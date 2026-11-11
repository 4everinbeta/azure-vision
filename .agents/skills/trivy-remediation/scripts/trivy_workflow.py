#!/usr/bin/env python3
"""Private Trivy evidence helpers. No patch generation, commits, pushes or merges."""

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


class WorkflowError(Exception):
    pass


def git(root, *args):
    proc = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
    )
    if proc.returncode:
        raise WorkflowError("Git check failed: " + " ".join(args[:2]))
    return proc.stdout.strip()


def project_root(project):
    return Path(git(Path(project).resolve(), "rev-parse", "--show-toplevel")).resolve()


def no_symlinks(path, base):
    path = Path(os.path.abspath(path))
    base = Path(os.path.abspath(base))
    if not path.is_relative_to(base):
        raise WorkflowError("Path must stay within the project/run directory")
    current = base
    for part in ("", *path.relative_to(base).parts):
        current = current / part
        if current.is_symlink():
            raise WorkflowError("Refusing symlinked evidence path")
    return path


def tracked_reports(root):
    if git(root, "ls-files", "--", "trivy-reports"):
        raise WorkflowError("Tracked trivy-reports files require human review")


def preflight(project):
    root = project_root(project)
    branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    head = git(root, "rev-parse", "--verify", "HEAD")
    for operation in (
        "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge",
        "rebase-apply", "BISECT_LOG", "sequencer",
    ):
        path = Path(git(root, "rev-parse", "--git-path", operation))
        if not path.is_absolute():
            path = root / path
        if path.exists():
            raise WorkflowError("Finish the current Git operation first")
    tracked_reports(root)
    no_symlinks(root / "trivy-reports", root)
    if git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise WorkflowError("A clean tracked/untracked worktree is required")
    return {"root": str(root), "original_branch": branch, "original_commit": head}


@contextlib.contextmanager
def private_umask():
    old = os.umask(0o077)
    try:
        yield
    finally:
        os.umask(old)


def private_write(path, text):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as out:
        out.write(text)


def write_json(path, data):
    private_write(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


def load_json(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def update_manifest(run, data):
    with private_umask():
        fd, name = tempfile.mkstemp(prefix=".manifest-", dir=run)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(data, out, indent=2, sort_keys=True)
                out.write("\n")
            os.replace(name, run / "run.json")
        finally:
            if os.path.exists(name):
                os.unlink(name)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def start(project):
    state = preflight(project)
    root = Path(state["root"])
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    branch = "security/trivy-remediation-" + run_id
    # Local-only exclusion: do not modify the working branch's shared ignore policy.
    exclude = Path(git(root, "rev-parse", "--git-path", "info/exclude"))
    if not exclude.is_absolute():
        exclude = root / exclude
    common_dir = Path(git(root, "rev-parse", "--git-common-dir"))
    if not common_dir.is_absolute():
        common_dir = root / common_dir
    no_symlinks(exclude, common_dir)
    if exclude.exists() and not exclude.is_file():
        raise WorkflowError("Git exclude path is not a regular file")
    git(root, "switch", "-c", branch)
    exclude.parent.mkdir(parents=True, exist_ok=True)
    prior = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if "/trivy-reports/" not in prior.splitlines():
        with exclude.open("a", encoding="utf-8") as out:
            out.write("\n# Private Trivy remediation evidence\n/trivy-reports/\n")
    reports = no_symlinks(root / "trivy-reports", root)
    with private_umask():
        reports.mkdir(mode=0o700, exist_ok=True)
        reports.chmod(0o700)
        run = reports / run_id
        run.mkdir(mode=0o700)
        state.update({
            "schema": 1, "run_id": run_id, "run": str(run), "created_at": now(),
            "remediation_branch": branch, "scans": [], "checks": [],
        })
        write_json(run / "run.json", state)
    return state


def get_run(path):
    # Do not resolve symlinks before checking them.
    run = Path(os.path.abspath(path))
    if run.parent.name != "trivy-reports":
        raise WorkflowError("Expected <project-root>/trivy-reports/<run-id>")
    root = project_root(run.parent.parent)
    if run.parent.parent != root:
        raise WorkflowError("Reports must be at the Git top-level")
    no_symlinks(run / "run.json", root)
    tracked_reports(root)
    state = load_json(run / "run.json")
    if state.get("root") != str(root) or state.get("run") != str(run):
        raise WorkflowError("Run manifest path mismatch")
    branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch != state["remediation_branch"]:
        raise WorkflowError("The remediation branch is not checked out")
    if git(root, "rev-parse", "HEAD") != state["original_commit"]:
        raise WorkflowError("Remediation HEAD changed; human review required")
    original = "refs/heads/" + state["original_branch"]
    if git(root, "rev-parse", "--verify", original) != state["original_commit"]:
        raise WorkflowError("Original branch tip changed; human review required")
    return run, state


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def policy_candidates(root):
    paths = sorted({
        *root.glob("trivy*.yaml"), *root.glob("trivy*.yml"),
        *root.glob(".trivyignore*"), *root.glob("trivy*policy*.json"),
    })
    return [
        {"path": str(path.relative_to(root)), "sha256": digest(path)}
        for path in paths if path.is_file() and not path.is_symlink()
    ]


def trivy_version(executable, root):
    proc = subprocess.run(
        [executable, "--version", "--format", "json"], cwd=root,
        capture_output=True, text=True, check=False,
    )
    if proc.returncode:
        raise WorkflowError("Cannot read Trivy version/DB metadata")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        raise WorkflowError("Trivy version metadata was not JSON") from error
    if not isinstance(data, dict) or not data.get("Version"):
        raise WorkflowError("Trivy version metadata is incomplete")
    return data


def normalized(report, scope, kind, root):
    if not isinstance(report, dict) or report.get("SchemaVersion") != 2:
        raise WorkflowError("Unsupported/malformed Trivy report schema")
    results = report.get("Results", [])
    if not isinstance(results, list):
        raise WorkflowError("Malformed Trivy Results")
    findings = {}
    for result in results:
        if not isinstance(result, dict):
            raise WorkflowError("Malformed Trivy result")
        target = str(result.get("Target", "unknown"))
        if kind == "image" and result.get("Class") == "os-pkgs":
            target = "os:" + str(result.get("Type", "unknown"))
        elif target.startswith(str(root) + os.sep):
            target = target[len(str(root)) + 1:]
        for field, category in (
            ("Vulnerabilities", "vulnerability"),
            ("Misconfigurations", "misconfiguration"),
            ("Secrets", "secret"),
        ):
            entries = result.get(field, []) or []
            if not isinstance(entries, list):
                raise WorkflowError("Malformed finding list: " + field)
            for entry in entries:
                if not isinstance(entry, dict):
                    raise WorkflowError("Malformed finding")
                if category == "misconfiguration" and entry.get("Status", "FAIL") != "FAIL":
                    continue
                cause = entry.get("CauseMetadata") or {}
                if not isinstance(cause, dict):
                    raise WorkflowError("Malformed finding location")
                identifier = entry.get("VulnerabilityID") if category == "vulnerability" else entry.get("ID") or entry.get("RuleID")
                if not isinstance(identifier, str) or not identifier:
                    raise WorkflowError("Finding missing identifier")
                package = entry.get("PkgName", "") if category == "vulnerability" else ""
                resource = cause.get("Resource", "") if category == "misconfiguration" else ""
                location = {
                    "path": str(entry.get("PkgPath") or cause.get("Filename") or target),
                    "resource": str(resource),
                    "start_line": entry.get("StartLine", cause.get("StartLine")),
                    "end_line": entry.get("EndLine", cause.get("EndLine")),
                }
                # Lines often shift after an IaC fix; prefer stable resource identity.
                identity = [scope, target, category, identifier, package, location["path"], resource]
                if not resource and category != "vulnerability":
                    identity.append(location["start_line"])
                key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
                finding = {
                    "key": key, "scope": scope, "target": target, "kind": category,
                    "id": identifier, "severity": str(entry.get("Severity", "UNKNOWN")).upper(),
                    "package": package, "location": location,
                }
                if category == "vulnerability":
                    finding.update({
                        "installed_version": entry.get("InstalledVersion", ""),
                        "fixed_version": entry.get("FixedVersion", ""),
                        "status": entry.get("Status", ""),
                    })
                # Never copy secret Match, Code, snippets, title or messages.
                if key in findings:
                    findings[key]["occurrences"] += 1
                else:
                    findings[key] = {**finding, "occurrences": 1}
    return {
        "schema": 1, "scope": scope, "kind": kind, "recognized_results": len(results),
        "findings": sorted(findings.values(), key=lambda item: item["key"]),
    }


def readable(inventory):
    lines = [
        "Scope: " + inventory["scope"],
        "Recognized result targets: " + str(inventory["recognized_results"]),
        "Finding instances: " + str(sum(f["occurrences"] for f in inventory["findings"])),
        "Raw report/logs are private; this inventory omits secret values.",
        "",
    ]
    for item in inventory["findings"]:
        lines.append(
            f'{item["severity"]} {item["kind"]} {item["id"]} '
            f'{item["target"]} {item["package"]} (instances: {item["occurrences"]})'
        )
    return "\n".join(lines) + "\n"


def scan(args):
    run, state = get_run(args.run)
    root = Path(state["root"])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", args.label):
        raise WorkflowError("Use a unique simple filename label")
    if not args.scope or len(args.scope) > 160 or any(ord(c) < 32 for c in args.scope):
        raise WorkflowError("Invalid logical scope")
    executable = shutil.which("trivy")
    if not executable:
        raise WorkflowError("Trivy is not installed")
    version_data = trivy_version(executable, root)
    command = [
        executable, args.kind, "--format", "json", "--exit-code", "0",
        "--disable-telemetry", "--skip-version-check",
    ]
    if args.kind != "config":
        command += ["--no-progress"]
    if args.kind == "image":
        if not args.target or not re.fullmatch(r"(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}", args.target):
            raise WorkflowError("Image scans require an immutable local image ID/digest")
        target = args.target
        command += ["--image-src", "docker", "--scanners", "vuln,secret"]
    else:
        target_path = Path(args.target).absolute() if args.target else root
        no_symlinks(target_path, root)
        target_path = target_path.resolve()
        if not target_path.exists():
            raise WorkflowError("Scan target does not exist")
        if args.kind == "fs" and target_path != root:
            raise WorkflowError("Source scans must cover the project root")
        target = str(target_path)
        if args.kind == "fs":
            command += [
                "--scanners", "vuln,misconfig,secret", "--include-dev-deps",
                "--skip-dirs", str(root / "trivy-reports"),
                "--skip-dirs", str(root / ".git"),
                "--skip-dirs", "**/node_modules",
            ]
        else:
            command += ["--include-non-failures"]
    if args.kind != "config":
        command += ["--ignore-unfixed=false"]
    command += ["--severity", "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", target]
    report_path = no_symlinks(run / (args.label + ".json"), run)
    log_path = no_symlinks(run / (args.label + ".log"), run)
    outputs = [report_path, log_path, run / (args.label + ".inventory.json"), run / (args.label + ".txt")]
    if any(path.exists() or path.is_symlink() for path in outputs):
        raise WorkflowError("Scan labels cannot overwrite existing evidence")
    # Override configured output paths so sensitive reports cannot escape the run.
    command[-1:-1] = ["--output", str(report_path)]
    record = {
        "label": args.label, "scope": args.scope, "kind": args.kind, "target": target,
        "command": command, "started_at": now(), "trivy_before": version_data,
        "policy_candidates": policy_candidates(root), "status": "running",
    }
    state["scans"].append(record)
    update_manifest(run, state)
    with private_umask():
        private_write(report_path, "")
        with log_path.open("x", encoding="utf-8") as log:
            proc = subprocess.run(command, cwd=root, stdout=log, stderr=log, check=False)
        record.update({"exit_code": proc.returncode, "finished_at": now(), "sha256": digest(report_path)})
        if proc.returncode:
            record["status"] = "failed"
            update_manifest(run, state)
            raise WorkflowError("Trivy failed; inspect the private scan log")
        try:
            record["trivy_after"] = trivy_version(executable, root)
        except WorkflowError:
            record["status"] = "metadata-error"
            update_manifest(run, state)
            raise
        try:
            inventory = normalized(load_json(report_path), args.scope, args.kind, root)
        except (json.JSONDecodeError, WorkflowError) as error:
            record["status"] = "invalid-report"
            update_manifest(run, state)
            raise WorkflowError("Invalid report; inspect private evidence") from error
        write_json(outputs[2], inventory)
        private_write(outputs[3], readable(inventory))
    record.update({
        "status": "complete", "recognized_results": inventory["recognized_results"],
        "finding_instances": sum(f["occurrences"] for f in inventory["findings"]),
    })
    update_manifest(run, state)
    return record


def run_file(run, path):
    file = no_symlinks(Path(os.path.abspath(path)), run)
    if not file.is_file():
        raise WorkflowError("Expected an existing private evidence file")
    return file


def compare(args):
    run, _state = get_run(args.run)
    before = load_json(run_file(run, args.before))
    after = load_json(run_file(run, args.after))
    if before.get("scope") != after.get("scope") or before.get("kind") != after.get("kind"):
        raise WorkflowError("Compare the same logical scope and scan kind")
    if before.get("schema") != 1 or after.get("schema") != 1:
        raise WorkflowError("Expected normalized inventories")
    old = {finding["key"]: finding for finding in before["findings"]}
    new = {finding["key"]: finding for finding in after["findings"]}
    result = {
        "scope": before["scope"],
        "candidate_resolved": [old[key] for key in sorted(old.keys() - new.keys())],
        "remaining": [new[key] for key in sorted(old.keys() & new.keys())],
        "new": [new[key] for key in sorted(new.keys() - old.keys())],
        "coverage": {"before": before["recognized_results"], "after": after["recognized_results"]},
        "note": "Reconcile target coverage, policies, path changes and DB versions before claiming resolution.",
    }
    output = no_symlinks(Path(os.path.abspath(args.output)), run)
    write_json(output, result)
    return {"output": str(output), "candidate_resolved": len(result["candidate_resolved"]), "new": len(result["new"])}


def record_check(args):
    run, state = get_run(args.run)
    log = run_file(run, args.log)
    log.chmod(0o600)
    check = {
        "unit": args.unit, "command": args.command, "exit_code": args.exit_code,
        "log": str(log.relative_to(run)), "log_sha256": digest(log), "recorded_at": now(),
        "status": "passed" if args.exit_code == 0 else "failed",
        "provenance": "Agent-reported execution; helper did not execute this command",
    }
    state["checks"].append(check)
    update_manifest(run, state)
    return check


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    for action in ("preflight", "start"):
        sub = subs.add_parser(action)
        sub.add_argument("--project", default=".")
    sub = subs.add_parser("scan")
    sub.add_argument("--run", required=True)
    sub.add_argument("--kind", choices=("fs", "image", "config"), required=True)
    sub.add_argument("--scope", required=True)
    sub.add_argument("--label", required=True)
    sub.add_argument("--target")
    sub = subs.add_parser("compare")
    for name in ("run", "before", "after", "output"):
        sub.add_argument("--" + name, required=True)
    sub = subs.add_parser("record-check")
    for name in ("run", "unit", "command", "log"):
        sub.add_argument("--" + name, required=True)
    sub.add_argument("--exit-code", type=int, required=True)
    sub = subs.add_parser("status")
    sub.add_argument("--run", required=True)
    args = parser.parse_args(argv)
    try:
        if args.action == "preflight":
            result = preflight(args.project)
        elif args.action == "start":
            result = start(args.project)
        elif args.action == "scan":
            result = scan(args)
        elif args.action == "compare":
            result = compare(args)
        elif args.action == "record-check":
            result = record_check(args)
        else:
            _run, result = get_run(args.run)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (WorkflowError, OSError, ValueError, KeyError, TypeError) as error:
        # Never echo raw report data or subprocess output, which may contain secrets.
        print(f"Workflow stopped ({type(error).__name__}). "
              + (str(error) if isinstance(error, WorkflowError) else "Check private evidence and inputs."),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
