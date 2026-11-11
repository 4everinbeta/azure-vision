# Trivy remediation and verification guide

This document describes the project's remediation approach. It contains no
live environment inventory, account identifiers or deployment evidence.
Run fresh scans to establish current findings; neither this document nor a
previous successful build establishes the security status of a new release.

For an agent-driven scan, triage, fix/test/rescan workflow, see
[the reusable Trivy skill](.agents/skills/trivy-remediation/README.md).
Manual scanning commands are in [the scanning instructions](trivy-scan-instructions.md).

## Scope

- Scan repository vulnerabilities, misconfigurations and secrets, including
  development dependencies and all severities.
- Build and scan every relevant deployable image target: API, web and standalone.
  Review optional vendor images independently.
- Render Kubernetes manifests and compile Bicep modules to ARM before scanning
  their configuration. A clean subscription wrapper does not establish that
  every nested module was recognized.
- Keep reports and logs private under `trivy-reports/`, which is excluded from
  Git, build contexts and subsequent repository scans.
- Record scanner/database versions, artifact identities, coverage and errors.
  Count finding instances separately from distinct advisories.

## Safe remediation

1. Establish a clean Git worktree and dedicated remediation branch. Record the
   original branch/commit and leave changes for human review.
2. Run existing tests, type checks and builds before changing code. Stop for
   guidance if the baseline fails.
3. Classify findings by severity, runtime/development/vendor scope, supported
   fix availability and behavioral or deployment impact.
4. Fix one root cause at a time using supported dependency updates and precise
   configuration changes. Update workspace manifests and lockfiles consistently.
   Do not use blanket forced upgrades or unsupported vendor package replacement.
5. Add meaningful regression coverage where needed. After each unit, run the
   relevant tests and dependent checks, rebuild changed images, and rescan.
   Repair regressions before proceeding.
6. Ask before incompatible APIs/runtimes, authentication or network changes,
   persistent-data migrations, data loss and cost/availability tradeoffs.
   Do not deploy to a shared cluster or cloud account without approval.
7. Retain unfixable findings and scanner gaps with evidence. Do not weaken
   controls, hide severities or add suppressions merely to obtain a clean scan.
8. Complete final validation and request human feedback before committing,
   merging or pushing.

## Application and container considerations

- Coordinate Vite, Vitest and plugin upgrades rather than forcing individual
  transitive packages across incompatible versions.
- Preserve Azure credential semantics, per-user cache isolation, API
  serialization and frontend behavior when upgrading the SDK or Fastify.
- Digest-pinned base images still require refreshed security packages and
  rebuilds. The build scripts supply `OS_PATCH_REVISION`; manual builds can use
  a fresh value or `--no-cache`.
- Test native SQLite installation, WAL writes, service startup and health
  checks against the actual runtime image.
- Read-only container roots require writable data, configuration and temporary
  paths. Verify the intended non-root UID/GID can access those paths.
- Scan supported Elastic images separately. A package fix listed by Trivy does
  not mean a supported vendor release contains it. Keep upstream blockers
  visible rather than replacing bundled JARs or modules arbitrarily.
- Snapshot persistent Elasticsearch data before upgrades. Fresh-container
  startup tests are not migration tests; never downgrade an upgraded data
  directory or delete PVCs as a compatibility shortcut.

## Infrastructure considerations

The Container Apps templates use private Table Storage access through a
VNet-integrated environment, private endpoint and private DNS. Infrastructure
encryption is configured at storage-account creation.

These creation-time properties may require a separate migration for an existing
installation. Review downtime, cache rebuild/copy, permissions, rollback and
costs before changing a live environment. Never treat resource-group deletion
as an ordinary update.

Trivy's ARM adapter has limited visibility into some child resources and policy
intent. Independently verify:

- Public networking, firewall defaults, shared-key denial and private DNS.
- Managed-identity table read/write/delete from inside the connected environment.
- Actual diagnostic log delivery, not only a diagnostic-setting field.
- Blob/container retention where applicable; blob soft delete does not protect
  Table Storage.
- Replication requirements. The templates use LRS for the derived cache; assess
  your own recovery, availability, residency and cost requirements.

A trusted-services bypass recommendation can conflict with private-only
`bypass: None`. Do not weaken the firewall to satisfy it. Likewise, independently
verified child-resource controls must not be described as absent solely because
an adapter does not recognize them.

Relevant guidance:

- [Azure Storage private endpoints](https://learn.microsoft.com/azure/storage/common/storage-private-endpoints)
- [Infrastructure encryption](https://learn.microsoft.com/azure/storage/common/infrastructure-encryption-enable)
- [Elastic upgrade preparation](https://www.elastic.co/docs/deploy-manage/upgrade/prepare-to-upgrade)

## Verification

Use the Node/npm versions and install-script policy documented in the README.
Run these checks from the repository root:

```bash
npm run typecheck
npm test
npm run build -w web
```

Also verify rendered Kubernetes manifests, Bicep compilation, image builds,
health checks and runtime permissions appropriate to the changed components.
The `server/scripts/verify-private-storage.mjs` probe can verify private DNS and
managed-identity table operations in an explicitly authorized test environment;
its required addresses must come from that environment, not from an example.

Close a finding only when the relevant repeat scan and behavior checks support
the result. Preserve before/after evidence privately. Document failed scans,
unrecognized targets, vendor blockers and approved risks explicitly.

Before sharing reports or source publicly, remove organization-specific
identifiers, environment URLs, account metadata and secret values. This guide
does not authorize publishing raw deployment evidence.
