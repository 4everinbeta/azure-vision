#!/usr/bin/env bash
# One-step start: build the image, deploy to Docker Desktop Kubernetes, then serve on http://localhost:${PORT:-3001}.
# Ctrl+C stops the port-forward; the app keeps running in the cluster (remove it with: npm run k8s:down).
set -euo pipefail
cd "$(dirname "$0")"
scripts/k8s.sh up
echo "Open http://localhost:${PORT:-3001} and sign in with Microsoft (Ctrl+C to stop forwarding)"
exec scripts/k8s.sh forward
