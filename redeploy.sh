#!/usr/bin/env bash
# Stop all Azure Vision workloads in Kubernetes, rebuild the images, redeploy, then port-forward to http://localhost:${PORT:-3001}.
# Flags: --purge (also delete PVC data), --no-elastic, --no-forward (skip the port-forward).
set -euo pipefail
cd "$(dirname "$0")"
args=(); forward=1
for a in "$@"; do if [[ "$a" == --no-forward ]]; then forward=0; else args+=("$a"); fi; done
scripts/k8s.sh redeploy "${args[@]}"
((forward)) || exit 0
echo "Open http://localhost:${PORT:-3001} and sign in with Microsoft (Ctrl+C to stop forwarding)"
exec scripts/k8s.sh forward
