# Remediation and verification guide

## Classification

Record each instance, not only each CVE: the same advisory may affect several
packages, paths or images. Keep a logical scope such as `repository`, `image:api`
or `iac:resources` stable across scans. Record artifact identity separately.
An installed version belongs in evidence, not the finding's stable identity.

Distinguish:

- Dependency vulnerability: production runtime, development/build/test only,
  OS package, or upstream vendor-bundled component.
- Misconfiguration: actual control deficiency, intentional approved tradeoff,
  or a possible adapter/coverage gap requiring independent verification.
- Secret: potentially active credential, synthetic fixture, or false positive;
  never reproduce the matched value.

UNKNOWN severity remains visible. Fix availability does not establish safety,
and absence of a fixed version is not a reason to hide an advisory. Reachability
assessment must name its evidence and uncertainty.

## Dependencies

Use the existing ecosystem's package manager and supported minimal versions.
Understand direct/transitive ownership before changing manifests. Update
lockfiles consistently. Avoid forced updates, unsupported overrides, arbitrary
major upgrades and wholesale lockfile regeneration.

Test affected application flows, not a constant asserting a new version.
Run native dependency/audit/signature verification where the project already
requires it; these complement, not replace, Trivy.

## Containers and vendor software

Find every relevant deployable Docker target and supported vendor image.
Scan immutable local image IDs, not ambiguous mutable tags. Do not assume a
runtime replica uses the digest currently resolved from its tag.

Prefer supported patched bases, package updates and coordinated vendor versions.
Digest pinning does not update OS packages in cached layers. Respect the
project's cache-busting/rebuild convention; use isolated build tags. Rebuild
and rescan after image changes.

Replacing a vendor's JARs, embedded Node modules or package database without
vendor support is not a safe default fix. Retain the finding, supported upgrade
options and upstream blocker. Do not silently change distributions, libc,
runtime major versions or deployment topology.

## Infrastructure

Compile/render IaC that Trivy cannot directly evaluate. Bicep modules may
need independent ARM compilation; a subscription wrapper alone may hide module
resources. Scan rendered files explicitly even though source scans exclude
the report directory. Label recognized resource/check coverage.

Combine scanner results with schema compilation, configuration assertions and
appropriate behavior checks. Never add unsupported properties solely to satisfy
a scanner. Private networking, auth, encryption-at-creation, retention,
redundancy, identities and persistent volumes can substantially change cost,
availability or access: ask first.

Example: do not enable a public/trusted-service bypass merely to clear a policy
when the intended design requires private-only access. Verify the actual
control, document a scanner gap or accepted risk, and retain the result.
Do not copy Azure Vision's particular exceptions into another project.

## Secrets

Keep raw findings private. Inventory only rule ID, severity, location and
redacted disposition. Removing a secret is not equivalent to revoking it.
Request owner-approved rotation/revocation and coordinate dependent systems.
Never rewrite shared history, use a leaked credential to test it, or copy
secrets into prompts, tests, commits, tickets or scan summaries.

## Test and deployment boundaries

Before a unit, choose tests demonstrating the affected contract: API response,
authentication behavior, query semantics, CLI behavior, config rendering,
image startup, connectivity or persistence, as applicable. Preserve intended
behavior, not insecure behavior the fix explicitly changes.

After each unit, run targeted regressions and dependent checks. Final validation
must cover the original application's appropriate release checks and original
scan scope. Document failures and unavailable coverage explicitly.

Isolated local test deployments are allowed only after confirming the context,
ownership and isolation. Create uniquely owned test resources, bind exposed
ports to loopback, and clean up exactly those resources. Never assume Docker
Desktop, a Kubernetes current context, or a development cloud subscription is
dedicated to this task. Shared clusters, cloud changes, data migrations,
destructive operations and costly topology changes require explicit approval.

Do not disable assertions, broaden catches, invent success-shaped fallbacks,
or modify expected outputs simply to make failing tests pass. Repair the
regression. If blocked, preserve evidence and ask or safely isolate/revert only
the current unit; do not compound unverified changes.
