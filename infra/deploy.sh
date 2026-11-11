#!/usr/bin/env bash
# Deploys Azure Vision to Azure Container Apps in the current (or given) subscription.
#
#   infra/deploy.sh [up]     deploy or update everything: base infra, build images in ACR, deploy the apps
#   infra/deploy.sh down     delete the whole resource group
#
# Settings (environment variables):
#   SUBSCRIPTION=<id|name>   subscription to deploy into (default: the current `az account`)
#   LOCATION=westus3         Azure region
#   AV_NAME=azure-vision     base name; resources go to resource group rg-$NAME
#   YES=1                    skip the confirmation prompt
#
# Requires the Azure CLI, signed in (`az login`) with rights to create resources and role assignments in the
# subscription (Owner, or Contributor + User Access Administrator). The app itself gets no access to any
# subscription: everyone signs in with device code and sees only what their own Azure RBAC allows.
set -euo pipefail

cd "$(dirname "$0")/.."
CMD="${1:-up}"
LOCATION="${LOCATION:-westus3}"
NAME="${AV_NAME:-azure-vision}"
RG="rg-$NAME"

command -v az >/dev/null || { echo "Azure CLI (az) is required: https://aka.ms/azure-cli" >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "Not signed in: run 'az login' first." >&2; exit 1; }
[[ -n "${SUBSCRIPTION:-}" ]] && az account set --subscription "$SUBSCRIPTION"
SUB_ID=$(az account show --query id -o tsv)
SUB_NAME=$(az account show --query name -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

confirm() {
  [[ "${YES:-}" == 1 ]] && return
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
}

case "$CMD" in
  up) ;;
  down)
    echo "Subscription: $SUB_NAME ($SUB_ID)"
    confirm "Delete resource group $RG and everything in it?"
    az group delete --name "$RG" --yes --no-wait
    echo "Deletion of $RG started (runs in the background in Azure)."
    exit 0 ;;
  *) echo "Usage: $0 [up|down]" >&2; exit 2 ;;
esac

echo "Subscription: $SUB_NAME ($SUB_ID)"
echo "Tenant:       $TENANT_ID (only accounts from this tenant can sign in)"
echo "Region:       $LOCATION | Resource group: $RG"
confirm "Deploy Azure Vision here?"

echo "Registering resource providers (no-op if already registered)..."
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.Storage Microsoft.ManagedIdentity Microsoft.Network Microsoft.Insights; do
  az provider register --namespace "$ns" --wait --output none
done

deploy() { # $1 = image tag ("" = base infrastructure only)
  az deployment sub create --name "$NAME" --location "$LOCATION" --template-file infra/main.bicep \
    --parameters name="$NAME" tenantId="$TENANT_ID" imageTag="$1" --output none
}
output() { az deployment sub show --name "$NAME" --query "properties.outputs.$1.value" -o tsv; }

echo "Deploying base infrastructure (registry, storage, identity, Container Apps environment)..."
deploy ""
ACR_NAME=$(output acrName)

TAG=$(date +%Y%m%d%H%M%S)
for target in api web; do
  echo "Building azure-vision-$target:$TAG in $ACR_NAME..."
  az acr build --registry "$ACR_NAME" --image "azure-vision-$target:$TAG" --target "$target" --build-arg OS_PATCH_REVISION="$TAG" --file Dockerfile . --output none
done

echo "Deploying container apps..."
deploy "$TAG"
URL=$(output url)

echo "Waiting for the app to answer (first start can take a minute)..."
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 10 "$URL/api/config"; then
    healthy=1
    break
  fi
  sleep 10
done
if [[ "$healthy" != 1 ]]; then
  echo "Deployment completed, but the web health check failed: $URL/api/config" >&2
  exit 1
fi

cat <<EOF

Deployed: $URL

Share this URL with colleagues in your tenant. Each person signs in with their own account (device code) and sees
only the subscriptions and costs their Azure roles allow (Reader for resources, Cost Management Reader for costs).
Kibana (search index admin) is internal-only; use infra/kibana.sh open|close for temporary access from your IP.
EOF
