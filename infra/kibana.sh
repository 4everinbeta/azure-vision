#!/usr/bin/env bash
# Temporary admin access to Kibana (internal-only by default; Elasticsearch itself is never exposed).
#
#   infra/kibana.sh open    allow only your current public IP, expose Kibana and print its URL
#   infra/kibana.sh close   make Kibana internal again and remove the IP rule
#
# Settings: SUBSCRIPTION, AV_NAME (as for deploy.sh), IP=<address> to allow a different address.
# A redeploy (infra/deploy.sh) also resets Kibana to internal-only.
set -euo pipefail

NAME="${AV_NAME:-azure-vision}"
RG="rg-$NAME"
APP=kibana
RULE=kibana-operator

[[ -n "${SUBSCRIPTION:-}" ]] && az account set --subscription "$SUBSCRIPTION"

case "${1:-}" in
  open)
    IP="${IP:-$(curl -fsS --max-time 10 https://api.ipify.org)}"
    [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not determine your public IPv4 address (set IP=...)" >&2; exit 1; }
    # Restrict first, then expose, so Kibana is never publicly reachable without the rule.
    az containerapp ingress access-restriction set -n "$APP" -g "$RG" --rule-name "$RULE" \
      --ip-address "$IP/32" --action Allow --description "Temporary admin access" --output none
    az containerapp ingress update -n "$APP" -g "$RG" --type external --output none
    FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
    echo "Kibana: https://$FQDN (allowed from $IP only; it may take a minute or two to start)"
    echo "No sign-in is required, so close it when done: $0 close" ;;
  close)
    az containerapp ingress update -n "$APP" -g "$RG" --type internal --output none
    az containerapp ingress access-restriction remove -n "$APP" -g "$RG" --rule-name "$RULE" --output none 2>/dev/null || true
    echo "Kibana is internal-only again." ;;
  *) echo "Usage: $0 open|close" >&2; exit 2 ;;
esac
