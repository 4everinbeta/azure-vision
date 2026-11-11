# Scanning Azure Vision with Trivy

Run the commands from the repository root. They use relative paths, so they do
not depend on a particular workstation, username or deployment.
Flags were checked against Trivy 0.76.2; check installed help for other versions.

If your terminal shows a continuation prompt (`>`), press **Ctrl+C** and paste
the complete command as one line. Copy commands, not the Markdown fences.

The commands below use Trivy directly. If you use RTK, prefix them with
`rtk bypass` to preserve scanner output.

The repository's `trivy.yaml` loads relative policy data for the official
Elastic registry used by the Kubernetes overlay. That policy does not suppress
dependency advisories or disable the registry check.
See [the remediation guide](trivy-remediation-plan.md) for verification rules.

## 1. Confirm Trivy works

```bash
trivy --version
```

## 2. Scan the repository

```bash
trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-dirs trivy-reports --skip-dirs trivy-results --disable-telemetry .
```

This checks supported npm dependency manifests, configuration files and secret
patterns. It does not scan deployed Azure resources or fully validate Bicep.
Database downloads may need network access, but no Azure login, dependency
installation or container build is needed for this step.

## 3. Show only HIGH and CRITICAL findings

```bash
trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-dirs trivy-reports --skip-dirs trivy-results --severity HIGH,CRITICAL --disable-telemetry .
```

Use this filtered view for prioritization, not as proof that lower-severity
findings do not exist.

## 4. Optionally scan the built container

```bash
docker info
```

If Docker is available, build the default standalone target:

```bash
docker build --no-cache --file Dockerfile --tag azure-vision:trivy .
```

Only after the build succeeds, scan it:

```bash
trivy image --image-src docker --scanners vuln,secret --severity HIGH,CRITICAL --disable-telemetry azure-vision:trivy
```

The scan includes OS packages. `--image-src docker` prevents fallback to remote
image lookup. The standalone image is not the separate nginx `web` target;
build and scan the API and web targets independently for complete release
coverage.

`--no-cache` reruns package patch steps in digest-pinned bases. New database
advisories can affect a previously scanned image.

## 5. Optionally make findings fail a check

```bash
trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-dirs trivy-reports --skip-dirs trivy-results --severity HIGH,CRITICAL --exit-code 1 --disable-telemetry .
```

Matching findings intentionally return a nonzero exit status. Tool errors can
also return nonzero; inspect diagnostics rather than interpreting every failure
as a vulnerability finding.

## 6. Save reports and logs to files

Reports belong under `trivy-reports/` in the project root. Each clone therefore
has its own report folder. The folder is excluded from Git, Docker contexts and
the repository scans above. Reports can contain secrets: do not publish them.

Create a private directory on Linux or macOS:

```bash
install -d -m 700 trivy-reports
```

Use equivalent restrictive directory permissions on other platforms.
Run report commands with `umask 077` so newly created reports/logs are private.
Existing report names are overwritten; use unique names to preserve before/after
evidence. The reusable skill creates separate run directories automatically.

### Full repository report as readable text

```bash
(umask 077; NO_COLOR=1 trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-dirs trivy-reports --skip-dirs trivy-results --disable-telemetry --no-progress --format table --output trivy-reports/repository.txt . 2>trivy-reports/repository.log)
```

`NO_COLOR=1` prevents terminal color codes in text reports. Findings go to the
report; diagnostics go to the separate log.

### HIGH and CRITICAL findings as JSON

```bash
(umask 077; trivy fs --scanners vuln,misconfig,secret --include-dev-deps --skip-dirs node_modules --skip-dirs .git --skip-dirs trivy-reports --skip-dirs trivy-results --severity HIGH,CRITICAL --disable-telemetry --no-progress --format json --output trivy-reports/repository-high-critical.json . 2>trivy-reports/repository-high-critical.log)
```

Do not mix diagnostics into JSON with `2>&1`. For a full machine-readable
inventory, omit the severity filter.

### Container image report

Only after building the image in step 4:

```bash
(umask 077; NO_COLOR=1 trivy image --image-src docker --scanners vuln,secret --severity HIGH,CRITICAL --disable-telemetry --no-progress --format table --output trivy-reports/image.txt azure-vision:trivy 2>trivy-reports/image.log)
```

You can add `--exit-code 1` before the target in these commands to retain step
5's behavior. A quiet terminal is expected when both outputs go to files.
An output file alone does not prove a scan completed successfully.

### Compiled Azure infrastructure

Compile the resource-group module independently so the scanner can recognize
its resources, rather than assuming traversal of the subscription wrapper:

```bash
(umask 077; az bicep build --file infra/resources.bicep --outfile trivy-reports/resources.arm.json)
```

Only after successful compilation:

```bash
(umask 077; NO_COLOR=1 trivy config --misconfig-scanners azure-arm --include-non-failures --disable-telemetry --format table --output trivy-reports/azure-infrastructure.txt trivy-reports/resources.arm.json 2>trivy-reports/azure-infrastructure.log)
```

Compilation/scanning does not deploy resources. The explicit configuration
target is intentionally inside the otherwise excluded report directory.
Review recognized resources and checks; empty coverage is not proof of
compliance. Retain findings and independently verify controls instead of adding
unsupported settings or weakening private-access policies.

## Troubleshooting

- **Command not found:** install or locate the required tool before proceeding.
- **Database download failure:** check network/proxy restrictions; never treat
  an interrupted scan as clean.
- **Docker access failure:** verify daemon availability and your authorization.
- **Missing reports:** inspect logs and actual exit status.
- **Sensitive output:** keep raw findings private and redact secret values,
  organization/account identifiers and real environment URLs before sharing.

For sequential agent-driven remediation with branch protection, regression
tests and a human review gate, see
[the Trivy skill](.agents/skills/trivy-remediation/README.md).
