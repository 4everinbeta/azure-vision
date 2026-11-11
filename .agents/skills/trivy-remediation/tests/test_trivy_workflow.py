import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "trivy_workflow.py"
SPEC = importlib.util.spec_from_file_location("trivy_workflow", SCRIPT)
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)


def report(vulnerabilities=None, **extra):
    return {
        "SchemaVersion": 2, "ArtifactName": "fixture",
        "Results": [{
            "Target": "package-lock.json", "Class": "lang-pkgs", "Type": "npm",
            "Vulnerabilities": vulnerabilities or [],
            **extra,
        }],
    }


def vulnerability(identifier="TEST-001", **extra):
    return {
        "VulnerabilityID": identifier, "PkgName": "fixture-package",
        "InstalledVersion": "1.0", "FixedVersion": "1.1", "Severity": "HIGH",
        **extra,
    }


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.root = self.workspace / "project with spaces"
        self.root.mkdir()
        self.git("init", "--initial-branch=working")
        self.git("config", "user.name", "Skill Test")
        self.git("config", "user.email", "skill-test@example.invalid")
        (self.root / "app.txt").write_text("baseline\n")
        self.git("add", "app.txt")
        self.git("commit", "-m", "fixture baseline")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], text=True, stderr=subprocess.PIPE
        ).strip()

    def start(self):
        self.state = workflow.start(self.root)
        self.run = Path(self.state["run"])
        return self.state

    def fake_trivy(self):
        bin_dir = self.workspace / "bin"
        bin_dir.mkdir()
        executable = bin_dir / "trivy"
        executable.write_text(
            "#!" + sys.executable + "\n"
            "import json, os, sys\n"
            "if '--version' in sys.argv:\n"
            "    print(json.dumps({'Version': 'fixture', 'VulnerabilityDB': {'Version': 2}}))\n"
            "elif os.environ.get('FAKE_FAILURE'):\n"
            "    print('private diagnostics', file=sys.stderr); sys.exit(7)\n"
            "elif os.environ.get('FAKE_INVALID'):\n"
            "    open(sys.argv[sys.argv.index('--output') + 1], 'w').write('invalid fixture report')\n"
            "else:\n"
            "    open(sys.argv[sys.argv.index('--output') + 1], 'w').write(os.environ['FAKE_REPORT'])\n"
        )
        executable.chmod(0o700)
        patch = mock.patch.dict(os.environ, {
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "FAKE_REPORT": json.dumps(report([vulnerability()])),
        })
        patch.start()
        self.addCleanup(patch.stop)

    def scan(self, label="repository-before", kind="fs", target=None, scope="repository"):
        return workflow.scan(argparse.Namespace(
            run=str(self.run), kind=kind, target=target, label=label, scope=scope
        ))


class RepositoryTest(FixtureCase):
    def test_preflight_is_read_only_and_resolves_nested_project(self):
        nested = self.root / "nested"
        nested.mkdir()
        state = workflow.preflight(nested)
        self.assertEqual(state["root"], str(self.root))
        self.assertEqual(state["original_branch"], "working")
        self.assertEqual(self.git("branch", "--show-current"), "working")
        self.assertFalse((self.root / "trivy-reports").exists())

    def test_refuses_non_git_detached_and_unborn(self):
        empty = self.workspace / "empty"
        empty.mkdir()
        with self.assertRaises(workflow.WorkflowError):
            workflow.preflight(empty)
        self.git("checkout", "--detach")
        with self.assertRaises(workflow.WorkflowError):
            workflow.preflight(self.root)
        subprocess.check_call(
            ["git", "init", "--quiet", str(empty)], stdout=subprocess.DEVNULL
        )
        with self.assertRaises(workflow.WorkflowError):
            workflow.preflight(empty)

    def test_refuses_dirty_tracked_and_untracked(self):
        (self.root / "app.txt").write_text("user change\n")
        with self.assertRaisesRegex(workflow.WorkflowError, "clean"):
            self.start()
        (self.root / "app.txt").write_text("baseline\n")
        (self.root / "untracked.txt").write_text("untracked\n")
        with self.assertRaisesRegex(workflow.WorkflowError, "clean"):
            self.start()
        self.assertEqual(self.git("branch", "--show-current"), "working")

    def test_refuses_active_git_operation(self):
        git_dir = self.root / ".git"
        (git_dir / "MERGE_HEAD").write_text(self.git("rev-parse", "HEAD"))
        with self.assertRaisesRegex(workflow.WorkflowError, "operation"):
            self.start()

    def test_refuses_symlinked_git_exclude_parent_without_creating_branch(self):
        info = self.root / ".git" / "info"
        # A freshly initialized fixture has only the default exclude file here.
        (info / "exclude").unlink()
        info.rmdir()
        outside = self.workspace / "external-info"
        outside.mkdir()
        info.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(workflow.WorkflowError, "symlink"):
            self.start()
        self.assertEqual(self.git("branch", "--show-current"), "working")
        self.assertFalse((outside / "exclude").exists())

    def test_refuses_tracked_or_symlinked_reports(self):
        reports = self.root / "trivy-reports"
        reports.mkdir()
        (reports / "old.json").write_text("{}")
        self.git("add", "trivy-reports")
        self.git("commit", "-m", "tracked reports fixture")
        with self.assertRaisesRegex(workflow.WorkflowError, "Tracked"):
            workflow.preflight(self.root)
        (reports / "old.json").unlink()
        reports.rmdir()
        self.git("add", "-u")
        self.git("commit", "-m", "remove fixture reports")
        reports.symlink_to(self.workspace, target_is_directory=True)
        with self.assertRaisesRegex(workflow.WorkflowError, "symlink"):
            workflow.preflight(self.root)

    def test_start_creates_private_ignored_run_and_preserves_original(self):
        before = self.git("rev-parse", "working")
        self.start()
        self.assertEqual(before, self.git("rev-parse", "working"))
        self.assertTrue(self.git("branch", "--show-current").startswith("security/trivy-remediation-"))
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("check-ignore", str(self.run / "run.json")), str(self.run / "run.json"))
        self.assertEqual(stat.S_IMODE(self.run.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.run / "run.json").stat().st_mode), 0o600)
        self.assertFalse((self.root / ".gitignore").exists())

    def test_refuses_branch_switch_and_changed_base(self):
        self.start()
        self.git("switch", "working")
        with self.assertRaisesRegex(workflow.WorkflowError, "not checked out"):
            workflow.get_run(self.run)
        self.git("commit", "--allow-empty", "-m", "base changed")
        self.git("switch", self.state["remediation_branch"])
        with self.assertRaisesRegex(workflow.WorkflowError, "Original branch"):
            workflow.get_run(self.run)

    def test_refuses_remediation_commits_and_symlinked_manifests(self):
        self.start()
        manifest = self.run / "run.json"
        copied = self.workspace / "manifest.json"
        copied.write_bytes(manifest.read_bytes())
        manifest.unlink()
        manifest.symlink_to(copied)
        with self.assertRaisesRegex(workflow.WorkflowError, "symlink"):
            workflow.get_run(self.run)
        manifest.unlink()
        manifest.write_bytes(copied.read_bytes())
        self.git("commit", "--allow-empty", "-m", "unexpected commit")
        with self.assertRaisesRegex(workflow.WorkflowError, "HEAD changed"):
            workflow.get_run(self.run)

    def test_scan_records_findings_despite_success_exit_and_skips_evidence(self):
        self.start()
        self.fake_trivy()
        result = self.scan()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["finding_instances"], 1)
        command = result["command"]
        self.assertIn(str(self.root / "trivy-reports"), command)
        self.assertIn("--include-dev-deps", command)
        self.assertIn("--ignore-unfixed=false", command)
        self.assertEqual(command[command.index("--output") + 1], str(self.run / "repository-before.json"))
        self.assertIn("VulnerabilityDB", result["trivy_after"])
        self.assertEqual(command[command.index("--severity") + 1], "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL")
        self.assertTrue((self.run / "repository-before.txt").exists())
        self.assertEqual(stat.S_IMODE((self.run / "repository-before.json").stat().st_mode), 0o600)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_scan_never_overwrites_evidence_and_rejects_bad_labels(self):
        self.start()
        self.fake_trivy()
        self.scan()
        with self.assertRaisesRegex(workflow.WorkflowError, "overwrite"):
            self.scan()
        with self.assertRaisesRegex(workflow.WorkflowError, "label"):
            self.scan(label="../escape")

    def test_failed_and_malformed_scans_are_not_clean(self):
        self.start()
        self.fake_trivy()
        with mock.patch.dict(os.environ, {"FAKE_FAILURE": "1"}):
            with self.assertRaisesRegex(workflow.WorkflowError, "Trivy failed"):
                self.scan(label="failed")
        with mock.patch.dict(os.environ, {"FAKE_INVALID": "1"}):
            with self.assertRaisesRegex(workflow.WorkflowError, "Invalid report"):
                self.scan(label="invalid")
        state = workflow.load_json(self.run / "run.json")
        self.assertEqual([s["status"] for s in state["scans"]], ["failed", "invalid-report"])
        self.assertFalse((self.run / "failed.inventory.json").exists())

    def test_config_scans_explicit_rendered_evidence_without_source_exclusion(self):
        self.start()
        self.fake_trivy()
        target = self.run / "compiled.arm.json"
        target.write_text("{}")
        result = self.scan(kind="config", target=str(target), scope="iac", label="iac-before")
        self.assertNotIn("--skip-dirs", result["command"])
        self.assertNotIn("--no-progress", result["command"])
        self.assertNotIn("--include-dev-deps", result["command"])
        self.assertEqual(result["command"][-1], str(target))

    def test_image_requires_immutable_id_and_docker_only(self):
        self.start()
        self.fake_trivy()
        with self.assertRaisesRegex(workflow.WorkflowError, "immutable"):
            self.scan(kind="image", target="fixture:latest")
        result = self.scan(kind="image", target="sha256:" + "a" * 64, scope="image:api")
        self.assertIn("--image-src", result["command"])
        self.assertEqual(result["command"][result["command"].index("--image-src") + 1], "docker")
        self.assertNotIn("--include-dev-deps", result["command"])

    def test_rejects_external_and_symlinked_scan_targets(self):
        self.start()
        self.fake_trivy()
        outside = self.workspace / "outside.json"
        outside.write_text("{}")
        with self.assertRaises(workflow.WorkflowError):
            self.scan(kind="config", target=str(outside))
        link = self.run / "linked.json"
        link.symlink_to(outside)
        with self.assertRaises(workflow.WorkflowError):
            self.scan(kind="config", target=str(link))

    def test_check_records_real_log_hash_and_failed_result(self):
        self.start()
        log = self.run / "tests.log"
        workflow.private_write(log, "synthetic failed assertion\n")
        args = argparse.Namespace(
            run=str(self.run), unit="unit-1", command="project test", exit_code=1, log=str(log)
        )
        result = workflow.record_check(args)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["log_sha256"], workflow.digest(log))
        self.assertIn("did not execute", result["provenance"])

    def test_compare_resolved_new_and_remaining_and_protects_output(self):
        self.start()
        old = workflow.normalized(report([vulnerability(), vulnerability("TEST-002")]), "repository", "fs", self.root)
        new = workflow.normalized(report([vulnerability(), vulnerability("TEST-003")]), "repository", "fs", self.root)
        before = self.run / "before.inventory.json"
        after = self.run / "after.inventory.json"
        workflow.write_json(before, old)
        workflow.write_json(after, new)
        args = argparse.Namespace(
            run=str(self.run), before=str(before), after=str(after), output=str(self.run / "comparison.json")
        )
        workflow.compare(args)
        result = workflow.load_json(args.output)
        self.assertEqual(result["candidate_resolved"][0]["id"], "TEST-002")
        self.assertEqual(result["new"][0]["id"], "TEST-003")
        self.assertEqual(result["remaining"][0]["id"], "TEST-001")
        args.output = str(self.root / "outside-run.json")
        with self.assertRaises(workflow.WorkflowError):
            workflow.compare(args)
        new["scope"] = "different"
        after.write_text(json.dumps(new))
        with self.assertRaisesRegex(workflow.WorkflowError, "same logical scope"):
            workflow.compare(args)

    def test_cli_reports_errors_without_dumping_data(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = workflow.main(["preflight", "--project", str(self.workspace)])
        self.assertEqual(code, 2)
        self.assertIn("Workflow stopped", stderr.getvalue())


class InventoryTest(unittest.TestCase):
    def inventory(self, data, kind="fs", scope="repository"):
        return workflow.normalized(data, scope, kind, Path("/project"))

    def test_secret_values_and_snippets_are_not_in_inventory_or_text(self):
        data = report(Secrets=[{
            "RuleID": "fixture-rule", "Severity": "HIGH", "StartLine": 4,
            "Match": "private-fixture-match", "Code": {"Lines": ["private-fixture-snippet"]},
            "Title": "private-fixture-title",
        }])
        inventory = self.inventory(data)
        combined = json.dumps(inventory) + workflow.readable(inventory)
        for value in ("private-fixture-match", "private-fixture-snippet", "private-fixture-title"):
            self.assertNotIn(value, combined)
        self.assertEqual(inventory["findings"][0]["location"]["start_line"], 4)

    def test_versions_do_not_change_instance_identity_but_paths_and_scopes_do(self):
        before = self.inventory(report([vulnerability()]))
        after = self.inventory(report([vulnerability(InstalledVersion="1.1")]))
        self.assertEqual(before["findings"][0]["key"], after["findings"][0]["key"])
        changed_path = self.inventory(report([vulnerability(PkgPath="other/package.json")]))
        changed_scope = self.inventory(report([vulnerability()]), scope="image:api")
        self.assertNotEqual(before["findings"][0]["key"], changed_path["findings"][0]["key"])
        self.assertNotEqual(before["findings"][0]["key"], changed_scope["findings"][0]["key"])

    def test_duplicate_occurrences_are_counted_and_distinct_targets_retained(self):
        data = report([vulnerability(), vulnerability()])
        data["Results"].append({**data["Results"][0], "Target": "other/package-lock.json"})
        inventory = self.inventory(data)
        self.assertEqual(len(inventory["findings"]), 2)
        self.assertEqual(sum(f["occurrences"] for f in inventory["findings"]), 4)

    def test_image_os_target_identity_survives_rebuild(self):
        data = report([vulnerability()])
        data["Results"][0].update({"Target": "old-image (alpine)", "Class": "os-pkgs", "Type": "alpine"})
        old = self.inventory(data, kind="image")
        data["Results"][0]["Target"] = "new-image (alpine)"
        new = self.inventory(data, kind="image")
        self.assertEqual(old["findings"][0]["key"], new["findings"][0]["key"])

    def test_misconfig_successes_are_not_findings_and_resources_are_stable(self):
        issue = {
            "ID": "TEST-CONFIG", "Severity": "MEDIUM", "Status": "FAIL",
            "CauseMetadata": {"Resource": "storage.fixture", "StartLine": 3},
        }
        data = report(Misconfigurations=[issue, {**issue, "Status": "PASS"}])
        before = self.inventory(data)
        self.assertEqual(len(before["findings"]), 1)
        issue["CauseMetadata"]["StartLine"] = 20
        after = self.inventory(data)
        self.assertEqual(before["findings"][0]["key"], after["findings"][0]["key"])

    def test_rejects_malformed_reports_and_keeps_empty_coverage_explicit(self):
        for data in ({}, {"SchemaVersion": 2, "Results": "bad"}, report(Vulnerabilities="bad")):
            with self.assertRaises(workflow.WorkflowError):
                self.inventory(data)
        inventory = self.inventory({"SchemaVersion": 2, "Results": []})
        self.assertEqual(inventory["recognized_results"], 0)
        self.assertEqual(inventory["findings"], [])


@unittest.skipUnless(os.environ.get("TRIVY_REAL_TESTS") == "1", "opt-in real Trivy fixture scans")
class RealTrivyTest(FixtureCase):
    def test_real_source_and_explicit_config_scans(self):
        if not workflow.shutil.which("trivy"):
            self.fail("TRIVY_REAL_TESTS requires installed Trivy")
        (self.root / "Dockerfile").write_text("FROM scratch\nUSER 65532\n")
        self.git("add", "Dockerfile")
        self.git("commit", "-m", "synthetic scanner fixture")
        self.start()
        hidden = self.run / "Dockerfile"
        hidden.write_text("FROM scratch\n")
        env = {
            "TRIVY_SKIP_DB_UPDATE": "true", "TRIVY_SKIP_JAVA_DB_UPDATE": "true",
            "TRIVY_SKIP_CHECK_UPDATE": "true", "TRIVY_OFFLINE_SCAN": "true",
        }
        with mock.patch.dict(os.environ, env):
            source = self.scan()
            self.assertEqual(source["status"], "complete")
            raw = workflow.load_json(self.run / "repository-before.json")
            targets = [result["Target"] for result in raw.get("Results", [])]
            self.assertTrue(any("Dockerfile" in target for target in targets))
            self.assertFalse(any("trivy-reports" in target for target in targets))
            rendered = self.scan(
                kind="config", target=str(hidden), scope="iac:fixture", label="config-before"
            )
            self.assertEqual(rendered["status"], "complete")
            self.assertGreater(rendered["recognized_results"], 0)
            self.assertGreater(rendered["finding_instances"], 0)
        self.assertEqual(self.git("status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
