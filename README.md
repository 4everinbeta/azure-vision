# Azure Vision

Graphical view of your Azure tenant: subscription > resource group > resource, relationship edges, pan/zoom/minimap, and filters by subscription, resource group, type and name (filters persist in the URL). An optional cost overlay (Azure Cost Management) shows spend per resource, resource group and subscription.

## Run (your own Azure login, default)

Use Node 22.22.2+, Node 24.15+, or a supported newer even-numbered release, and
npm 12.2.2 (pinned in `packageManager`). The install policy permits only the
reviewed SQLite/esbuild script versions in `package.json`; unreviewed scripts
fail installation. Optional `fsevents` scripts are disabled (file watching uses
the portable fallback).

If your global npm is older, install the locked dependencies with the pinned
version without changing the global installation:

```bash
rtk bypass npm exec --yes --ignore-scripts --package npm@12.2.2 -- npm --ignore-scripts=false ci
```

The outer flag disables bootstrap scripts; the inner command still enforces the
project's explicit install-script allowlist.

```bash
npm install
npm run dev      # web http://localhost:5173, API http://127.0.0.1:3001
npm test
```

Open the app and click **Sign in with Microsoft**: you get a device code and a link (https://login.microsoft.com/device); sign in as yourself and the app loads every subscription you can read (Reader or above) via Azure Resource Graph. No app registration needed. Optional env: `AZURE_TENANT_ID` to pin a tenant (default `organizations`), `AZURE_CLIENT_ID` to use your own public-client app. The token is held in server memory only (one session per browser, via an httpOnly cookie), so you sign in again after restarting the server. Use **Sign out** to clear it.

For fixture data without Azure: `SOURCE=mock npm run dev`.

## Multi-user mode (app registration + On-Behalf-Of, `SOURCE=arg`)

1. Entra ID app registration (single tenant):
   - SPA redirect URI `http://localhost:5173`
   - Expose an API: Application ID URI `api://<client-id>`, scope `access_as_user`
   - Add a client secret; API permissions: Azure Service Management `user_impersonation` (delegated), grant consent (needed for On-Behalf-Of)
2. Start the server:
   ```bash
   SOURCE=arg AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=... npm run dev -w server
   npm run dev -w web
   ```
   The user needs Reader on the subscriptions to see. Results are cached per user (`CACHE_TTL_MS`, default 60s; Refresh button bypasses).

## Deploy to Azure (Container Apps)

Hosted version for colleagues in your Entra tenant: each person opens the URL, clicks **Sign in with Microsoft**, enters a device code and sees only the subscriptions and costs their own Azure roles allow (Reader for resources, Cost Management Reader for costs). No app registration is needed, and the app has no subscription access of its own.

```bash
az login
infra/deploy.sh            # deploy or update (asks for confirmation); SUBSCRIPTION=<id|name> LOCATION=westus3 AV_NAME=azure-vision YES=1
infra/kibana.sh open       # temporary Kibana access from your public IP only; `close` makes it internal again
infra/deploy.sh down       # delete the resource group
```

`deploy.sh` registers resource providers, deploys `infra/main.bicep` with only the base infrastructure, builds the `api` and `web` images in ACR (`az acr build`, timestamp tag), then deploys the apps and checks the public URL. It exits with an error if the app does not answer. Re-run it to ship a new version. It needs rights to create resources and role assignments in the target subscription.

The private-storage design requires a VNet-integrated workload-profiles
environment and infrastructure encryption configured when the storage account
is created. These properties may require a separate migration for an existing
environment or storage account. `down` deletes the entire deployment resource
group, including cache data, registry images, logs and identities.
Never use `down` as an ordinary update or a migration preserving data.
Review a migration and rollback plan before applying creation-time changes to
an existing installation.

Azure and local Kubernetes builds pass a fresh `OS_PATCH_REVISION` build argument
so Docker reruns the OS patch steps even when digest-pinned base images have not
changed. For manual builds, pass a fresh value or use `--no-cache`.
Elasticsearch and Kibana use matching, digest-pinned official Wolfi 8.19.25
images. Scan these separately for vendor-bundled findings; see
[the remediation guide](trivy-remediation-plan.md). Before upgrading
existing Kubernetes data, take a snapshot and review the Elastic upgrade
requirements; never delete PVCs or downgrade an upgraded data directory.

| Resource (`rg-<name>`) | Purpose |
|---|---|
| VNet-integrated Container Apps environment + Log Analytics | Consumption workload profile, application logs, and Table Storage audit logs |
| `web` (external HTTPS) | nginx: UI and `/api/*` gateway; the only public endpoint. Scales 0–2 |
| `inventory-api`, `cost-api`, `layout-api` (internal) | the same services as in k8s. Inventory and cost scale 0–1 (sessions and cost collection are in-process) |
| `elasticsearch` (internal, 1 warm replica) | search index on ephemeral disk (derived data, rebuilt as people use the app); security off, so it is never exposed |
| `kibana` (internal, 0–1) | opened only via `infra/kibana.sh` with an IP allow rule |
| Container Registry (Basic) | images, pulled with the managed identity (`AcrPull`) |
| Storage account (Table `inventory`) | per-user cache; public network/shared-key/blob-public access disabled; infrastructure encryption and managed identity with `Storage Table Data Contributor` |
| VNet, NSG, private endpoint and private DNS | delegated infrastructure subnet `10.42.0.0/23`; endpoint subnet `10.42.2.0/27`; private `table` access via `privatelink.table.core.windows.net` |

Storage defaults to **Standard_LRS** for this derived cache; review replication
and recovery requirements for your installation. Table read/write/delete
audit logs use the existing workspace's 30-day retention. Seven-day blob and
container soft delete protects any future blobs, not Table Storage.
Trivy's ARM adapter may still report missing logging or blob soft delete even
when their child resources are configured. Its trusted-services bypass
recommendation conflicts with the deliberate `bypass: None` private-only
design. Check the deployed controls instead of weakening the firewall to clear
these findings.

Sign-in and security:
- Device code via Azure's public developer client, pinned to the deploying tenant (`AZURE_TENANT_ID`); accounts whose token is from another tenant are rejected. Conditional Access policies that block device-code flow will block sign-in; Entra SSO is the planned follow-up.
- Each browser gets its own session (random id in an httpOnly, `SameSite=Lax`, `Secure` cookie); tokens stay in `inventory-api` memory and never reach the browser. Sessions expire after `SESSION_IDLE_MS` (default 8h) idle; limits: `MAX_SESSIONS` (200), `MAX_PENDING_LOGINS` (20), `LOGINS_PER_IP` (10 per 10 min).
- nginx drops any client-supplied `Authorization` header and sets it only from the session; services verify forwarded ARM tokens (Entra signature, lifetime, audience, tenant) before using their identity for cache keys.
- Users should enter only device codes they requested themselves on this site (device-code phishing).

Operational notes:
- Apps scale to zero when idle: the first request afterwards takes a few seconds, and people sign in again (sessions are in memory). Costs keep collecting only while someone has the page open.
- Fixed costs include the warm Elasticsearch replica (0.75 vCPU / 1.5 GiB),
  ACR Basic, the private endpoint and private DNS zone; storage, logging and
  network usage add charges.
- A new environment changes app FQDNs and ends existing sign-in sessions.
  Verify private DNS, managed-identity table read/write and public storage
  denial after provisioning; a successful public `/api/config` check alone
  does not prove storage access.
- The packaged `server/scripts/verify-private-storage.mjs` probe runs inside
  the environment with `STORAGE_TABLE_ENDPOINT`, `STORAGE_TABLE_NAME`,
  `MANAGED_IDENTITY_CLIENT_ID` and `EXPECTED_STORAGE_IPS` (comma-separated
  private-endpoint NIC IPs). It uses managed identity, verifies private DNS,
  reads/writes a unique test entity and removes only that owned entity.
- The default VNet is `10.42.0.0/16`. Check address overlap before peering or
  connecting it to other networks. Public HTTPS ingress is retained; NSG
  defaults retain required platform health probes and outbound access.
- Templates: `az bicep build --file infra/main.bicep`. The server's `managed` and `arg` modes remain in code but are not deployed.

## Docker

```bash
docker compose up --build    # http://localhost:3001 (UI + API), loopback-only
```

Inventory is cached in SQLite (`/data/azure-vision.db`, a named volume) with a 1-day TTL (`CACHE_TTL_MS`). The **Refresh** button bypasses the cache and re-queries Resource Graph. The cache is keyed per signed-in identity (tenant + object id). You still sign in (device code) after a restart, since tokens are memory-only. Locally, `DB_PATH` defaults to `data/azure-vision.db`.

## Exploring the graph

Explore drills down: all subscriptions → resource groups → a laid-out diagram of one resource group (breadcrumb, URL-persisted via `s`/`g`). Cards are ordered left to right by role (edge, network, compute, data, security, ops) using ELK; NICs, disks and public IPs fold into their owning resource (`+N items`). Selecting a card highlights its neighbours. Header: dark mode toggle; "Export PNG" saves the current diagram. Very large resource groups are not yet clustered.

The top filter bar searches resource names/types and offers searchable subscription, resource-group and resource-type selections (including friendly labels such as **AKS** and **Service Bus**). Choices narrow to the current drill-down scope and the other filters; selected unavailable choices remain visible so you can clear them. Changing subscriptions clears incompatible resource-group selections. **Any (OR)** matches any selected type; **All (AND)** requires all selected types in each subscription at the tenant level, or in the same resource group when drilled into a subscription. Only resources of the selected types are shown. Text/group filters apply before the All check. Filters survive drill-down and are saved in the URL.

Overview cards default to **Name ascending**; choose **Spend** or **Resource count** and change direction. In a resource group, switch **Diagram / List** for a sortable table of every matching resource, including those folded into diagram cards. List sorting supports **Name, Spend, Type, Location**; the diagram retains its relationship-based layout. Spend sorting requires Costs; unavailable spend sorts last, and ordering falls back to Name while no spend is available. Sort choices and Diagram/List are URL-persisted. Network retains its independent sidebar filters.

With Explore filters active, cards and the header show **matching resource spend**, excluding unrelated/unallocated costs. Resource details explicitly retain full resource-group/subscription totals for context. Missing costs are shown as unavailable rather than zero; pending/failed subscription queries mark totals as partial. Filtering and sorting reuse the cached inventory/costs and do not re-query Azure.

## Costs

Tick **Costs** in the header to overlay Azure Cost Management data (actual cost, queried per subscription by resource id). Pick a period (month to date, last month, last 30/90 days); the selection is kept in the URL (`cost=`, `heat=1`). Resource nodes, resource-group and subscription headers show their cost, **Heat** colours resources on a log scale, and selecting a resource shows its share of its resource group and subscription plus a per-service/meter breakdown. Cost that cannot be matched to an inventory resource (deleted resources, tax, purchases) is shown as "unallocated" on the subscription so totals match the portal.

- Needs **Cost Management Reader** (or Reader plus billing access) on each subscription. Subscriptions you cannot query are listed in a warning instead of failing the whole view. In Azure each user's own role assignments apply.
- Supported in `local` (device code), `managed` and `mock` modes; `arg` (OBO) returns 501 for cost endpoints.
- Cost data lags by several hours and the Query API is aggressively rate limited (the server retries 429s), so costs are collected in the background one subscription at a time (`COST_SPACING_MS`, default 1.5s apart; waits out `Retry-After`/rate-limit headers) and cached per subscription for `COST_CACHE_TTL_MS` (default 24h). `/api/costs` returns what is cached with a `pending` count and the UI polls until it reaches 0, so a throttled tenant fills in over time; subscriptions that fail are retried after a minute on the next load, and Refresh forces a full re-query. Per-resource breakdowns are fetched on demand and kept in memory only.
- API: `GET /api/costs?period=mtd|lastMonth|30d|90d[&refresh=1]`, `GET /api/costs/breakdown?resourceId=...&period=...`.

## Kubernetes (Docker Desktop)

Enable Kubernetes in Docker Desktop (verified on its kind-based cluster, v1.36), then:

```bash
./start.sh                      # build, deploy, port-forward to http://localhost:3001
npm run k8s:up                  # same build + deploy without forwarding; add `-- --no-elastic` to skip Elasticsearch/Kibana
npm run k8s:forward             # http://localhost:3001 (loopback only), then sign in with the device code
scripts/k8s.sh forward kibana   # http://localhost:5601
scripts/k8s.sh status | logs [service]
./redeploy.sh [--purge]         # stop everything, rebuild, redeploy and port-forward; --purge also deletes the PVCs; --no-forward skips forwarding
scripts/k8s.sh down [--purge]   # stop everything; --purge also deletes the PVCs
```

Separate pods, one codebase (`SERVICE` selects the API a process serves; `azure-vision-api` image, plus `azure-vision-web`):

| Pod | Role |
|---|---|
| `web` | nginx: static UI and `/api/*` routing (the only thing you port-forward) |
| `inventory-api` | Resource Graph fetch, 1-day cache (PVC), sign-in, `/api/search`; indexes into Elasticsearch |
| `cost-api` | Cost Management queries and breakdowns, per-subscription 24h cache (PVC), throttled background collection, indexes costs; calls `inventory-api` for the resource list |
| `layout-api` | Stateless ELK graph layout (`POST /api/layout`); the browser no longer runs ELK |
| `elasticsearch`, `kibana` | Optional search/analytics (indices `azure-vision-resources`, `azure-vision-costs`); security is off, so they are cluster-internal (Kibana via port-forward only). Logstash is not used: services index directly |

Sign-in lives in `inventory-api` (device-code tokens are in memory, one session per browser cookie, so it is one replica with `Recreate`). For `/api/costs`, nginx asks `inventory-api` for that browser's ARM token (`auth_request`, passing the cookie) and forwards it as a bearer token; nginx strips any client-supplied `Authorization` on every route, and services verify forwarded tokens before trusting them. `cost-api` stays stateless and never sees the device-code session. The token is not sent to the browser. The Services are `ClusterIP`: use `port-forward`. The nginx config is a template (`web/nginx/templates/`) whose upstreams come from `INVENTORY_UPSTREAM`/`COST_UPSTREAM`/`LAYOUT_UPSTREAM` (defaults are the k8s Service names). Settings (`SOURCE`, tenant/client ids, TTLs) are in `k8s/base/kustomization.yaml`; Elasticsearch needs roughly 2GB of RAM.

Docker Desktop's kind-based cluster has its own image store, so `k8s.sh up` imports the rebuilt `:local` images into the node. Locally and with `docker compose`, the default image target still runs everything in one process (`SERVICE=all`).

Kubernetes workloads run as UID/GID 10001 with read-only root filesystems.
Writable data and runtime paths use volumes; `fsGroup` grants the API and
Elasticsearch processes access to their PVCs. CPU limits are initial local
development budgets, not production load measurements. Cache TTLs inherit the
server's one-day defaults; `CACHE_TTL_MS` and `COST_CACHE_TTL_MS` remain available
as overrides. The Docker/Compose images retain their original default users.

The Trivy configuration trusts the official Elastic registry for this local
deployment and pins its two images by digest. Run Trivy from the workspace root
to load `trivy.yaml` and `trivy-policy.json`; the single-line commands in
[the scan instructions](trivy-scan-instructions.md) handle this from other
working directories. See
[the remediation plan](trivy-remediation-plan.md) for findings and validation.

## Icons

Official icons are not bundled (Microsoft's terms apply). Download "Azure Architecture Icons" from https://learn.microsoft.com/azure/architecture/icons/ and run:

```bash
npm run icons -- ~/Downloads/Azure_Architecture_Icons.zip
```

This copies the service SVGs into `web/src/icons/azure/` (git-tracked is up to you). Icons are matched to resource types via explicit keywords in `web/src/icons/index.ts` (`iconMeta`), otherwise by guessing from the ARM type name; unmatched types show a coloured badge.

## Extending

- New relationships: add an extractor in `shared/src/edges.ts`.
- New data source: implement `ResourceSource` (`server/src/sources`).
- Alerts/recommendations: add `Rule`s in `server/src/analysis` (types in `shared/src/types.ts`).

## Status / known gaps

The ARG + OBO path is implemented but untested against a real tenant. Very large tenants will need collapse/clustering of groups.
