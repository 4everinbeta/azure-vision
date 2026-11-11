# Evidence and reporting

## Layout

```text
<project-root>/trivy-reports/<run-id>/
  run.json
  repository-before.json
  repository-before.log
  repository-before.inventory.json
  repository-before.txt
  ...other uniquely labeled scans...
  findings.json
  ...check logs and comparison JSON...
  review.md
```

The helper creates directories with mode 0700 and files with mode 0600 on
POSIX systems. Permissions are not encryption. Keep the directory out of Git,
Docker build contexts, source rescans and artifacts uploaded by CI/build tools.
The helper sets a Git-local exclusion and a source-scan exclusion; the agent
must separately check `.dockerignore` and other upload tooling before a build.
Never assume `.gitignore` also protects Docker contexts.

Raw Trivy JSON and stderr may contain matched secrets and source fragments.
Do not paste them into conversation or publish them. Only derived, redacted
inventories are intended for routine review. Do not globally disable secret
scanning to avoid sensitive output.

## Manifest and helper commands

`start` records root, original branch/commit, remediation branch and run ID.
`scan` records exact command arguments, scanner version, before/after DB metadata
when available, exit code, report hash, logical scope, immutable image reference,
policy/configuration candidate hashes and coverage failures. The helper does
not fully interpret custom policies; inspect and disclose them.

`scan` exits nonzero on tool failure or malformed JSON, but zero on valid scans
with findings. This deliberately separates scan execution success from security
status. Never infer "clean" from exit code alone.

`record-check --run <run> --unit <id> --command '<actual command>'
--exit-code <code> --log <existing-private-log>` records an already executed
check; it does not execute or verify that command. The agent must actually run
the command, capture its real exit status (not a pipeline's `tail` exit status),
and preserve its output before recording it. Do not put credentials in command
arguments or logs. Record baseline and final checks as units `baseline` and
`final`.

`compare` compares normalized inventories by stable instance keys. Its output
is a candidate resolved/new/remaining set, not automatic triage. Source-path
renames, different rendered IaC filenames, changed artifact scope or new DB
advisories need explicit reconciliation. Compare the same scope and scanner
coverage. Image OS-package targets normalize mutable image labels but preserve
logical image scope.

`status` verifies current branch/commit and original branch tip, and lists scan
and check states. It is a safety/evidence summary, not a declaration that all
findings or tests are resolved.

## Remediation ledger

Create `findings.json` with one entry per normalized instance and fields:

- `key`, `scope`, `kind`, `id`, `severity`, `target`, `location`, `package`;
- `exposure`: production, development, OS, vendor, infrastructure, or unknown;
- `fixAvailability` and `riskAssessment`, with evidence/uncertainty;
- `unit`: the change grouping all instances of one root cause;
- `status`: remaining, resolved, blocked, needs-approval, accepted-risk, or
  verified-scanner-gap;
- `reason`, changed paths, before/after evidence and relevant check records;
- approval reference for accepted risks or significant behavior changes.

Never copy secret matches or snippets into the ledger. Unverified false-positive
claims stay remaining/blocked; do not silently relabel them.

## Final human review

Write `review.md` covering:

1. Original branch/commit and remediation branch; changes are uncommitted.
2. Before/after counts by severity/kind and logical target, explicitly labeled
   as instance counts. State unique advisory totals separately if calculated.
3. Each verified unit: why changed, test results and scan resolution evidence.
4. Remaining blockers, upstream fixes, approved risks, coverage gaps and failed
   checks. Distinguish errors/unscanned targets from zero findings.
5. Meaningful behavior/deployment impacts, approvals and operational steps.
6. Request for human feedback before any reviewed commit/merge.

Preserve original evidence; never overwrite a before report with an after
report. A run with unresolved findings may be ready for review, but cannot be
described as vulnerability-free or fully remediated.
