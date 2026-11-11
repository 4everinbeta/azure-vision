# Trivy remediation skill

A portable agent skill for scanning, classifying and sequentially fixing Trivy
findings with regression protection. It creates a separate remediation branch,
keeps private evidence under the project's root and stops for human feedback
before any commit or merge.

## Install and share

Copy this entire `trivy-remediation` directory, including its `scripts`,
`references` and `tests`, to a compatible host's skill directory:

- Project-scoped: `<project>/.agents/skills/trivy-remediation/`.
- Copilot personal scope: `~/.copilot/skills/trivy-remediation/` or
  `~/.agents/skills/trivy-remediation/`.
- Other hosts: use their documented Agent Skills installation location.

For Copilot, `copilot skill list --json` confirms discovery. New sessions may be
needed to refresh available skills. Copying the directory is enough; no global
package installation, hosted service or dynamic agent workflow is required.
It is ready to copy or place in your own repository; this package has not been
published to a registry.

Keep the skill installed and, if project-local, committed before running it:
the remediation workflow requires a clean Git worktree. A directory without
Git is deliberately refused; it is never automatically initialized.

## Requirements

- An agent able to edit code, run tools/tests and request human feedback.
- Git with an existing commit on a named branch and a clean worktree.
- Python 3.10+ and Trivy available on PATH.
- Project-native package managers and tests; Docker/IaC compilers when needed.

Scanner flags were verified with Trivy 0.76.2. Other versions should be checked
against installed help. Reports use Trivy JSON schema version 2; unsupported
schemas fail explicitly. POSIX permissions protect local reports on Linux and
macOS; Windows requires equivalent directory ACL protection.

## Use

Ask the agent:

> Use the trivy-remediation skill on this repository. Scan all severities,
> inventory findings, add focused regression coverage, then fix one unit at a
> time and run tests after every change. Ask before significant behavior or
> deployment changes. Leave everything uncommitted on the remediation branch
> and request feedback before merging.

Default scope includes source vulnerabilities/misconfigurations/secrets and
development dependencies, plus relevant local images and compiled/rendered IaC
when applicable. No cloud changes or shared-cluster deployment is authorized
by invoking the skill. Local test resources must be isolated and task-owned.

The agent establishes passing baseline checks, adds meaningful missing
regression coverage, and uses the fix/test/rescan loop. If a fix breaks tests,
it repairs the regression before continuing. Significant decisions are asked,
not guessed. Unfixable/vendor findings stay documented without suppression.

Reports are stored here:

```text
<git-project-root>/trivy-reports/<run-id>/
```

They are excluded from Git locally and from source rescans. Before building,
the agent must also exclude them from Docker and other upload contexts. Raw
reports/logs may contain secrets; only redacted inventories and appropriately
reviewed summaries should be shared.

## Helper commands

These are supporting primitives, **not an autonomous remediation script**.
The agent must read `SKILL.md` and the references to execute the complete loop.
Replace `HELPER` with the absolute path to `scripts/trivy_workflow.py` in the
installed skill directory; supply absolute paths for evidence files.

```text
python3 HELPER preflight --project /path/to/project
python3 HELPER start --project /path/to/project
```

`start` returns a JSON object with `run`, `original_branch`, `original_commit`
and `remediation_branch`. Use that run directory in subsequent commands:

```text
python3 HELPER scan --run RUN --kind fs --scope repository --label repository-before
python3 HELPER scan --run RUN --kind image --target sha256:IMMUTABLE_IMAGE_ID --scope image:api --label api-before
python3 HELPER scan --run RUN --kind config --target RUN/resources.arm.json --scope iac:resources --label arm-before
python3 HELPER compare --run RUN --before RUN/repository-before.inventory.json --after RUN/repository-after.inventory.json --output RUN/repository-comparison.json
python3 HELPER record-check --run RUN --unit baseline --command "actual project test command" --exit-code 0 --log RUN/baseline.log
python3 HELPER status --run RUN
```

Run the check before recording it: `record-check` records agent-supplied evidence
and does not execute the command or attest to its outcome. Capture the actual
exit code, not that of `tail`, `tee` or another pipeline consumer.

Use unique scan labels; the helper refuses to overwrite evidence. Image IDs
must be real 64-hex digests available in Docker locally. It never falls back to
remote image lookup. Source scans run from the project root to retain relative
policy paths. Config scans intentionally allow explicit compiled outputs under
the otherwise excluded report directory.

Exit code 0 from `scan` means a valid scan completed, even when it found issues.
Exit code 2 means a safety/tool/report failure, not a clean result. Read the
manifest and private logs. No command commits, pushes or merges.

## Test the package

From any directory, using the installed skill path:

```text
python3 -B -m unittest discover -s /path/to/trivy-remediation/tests -v
```

The default suite uses temporary Git repositories and a fake scanner; it does
not modify or scan your application. Real fixture scans are opt-in:

```text
TRIVY_REAL_TESTS=1 python3 -B -m unittest discover -s /path/to/trivy-remediation/tests -v
```

Real tests use the installed scanner and its existing caches in offline/update-
disabled mode. They require a populated Trivy database/check cache and may fail
if it is missing or incompatible; do not treat that failure as a clean scan.
They scan only disposable fixture repositories, never the application or a
cloud deployment. Report/fixture directories are removed with their temporary
test directories.

## Limits

Tests and Trivy cannot prove all application behavior is identical or all
vulnerabilities absent. Policy exclusions, unrecognized resources, upstream
blockers and scan failures must be disclosed. The skill does not claim that a
locally scanned image is the artifact currently running in production.

Human approval is required before significant behavior/deployment changes and
before a later commit/merge. The initial skill request is not merge consent.
