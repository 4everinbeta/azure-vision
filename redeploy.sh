#!/usr/bin/env bash
# Rebuild and redeploy Azure Vision, then detach port-forwarding to http://localhost:${PORT:-3001}.
# Flags: --purge (also delete PVC data), --no-elastic, --no-forward (skip the port-forward).
set -euo pipefail
cd "$(dirname "$0")"
args=(); forward=1
for a in "$@"; do if [[ "$a" == --no-forward ]]; then forward=0; else args+=("$a"); fi; done
scripts/k8s.sh redeploy "${args[@]}"
((forward)) || exit 0
log="${PORT_FORWARD_LOG:-data/port-forward.log}"
mkdir -p "$(dirname "$log")"
(umask 077; exec nohup scripts/k8s.sh forward >"$log" 2>&1 < /dev/null) &
pid=$!
for ((attempt=0; attempt<150; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    echo "Port-forward failed to start. See $log:" >&2
    cat "$log" >&2
    exit 1
  fi
  if grep -q "Forwarding from 127.0.0.1:" "$log"; then
    echo "Open http://localhost:${PORT:-3001} and sign in with Microsoft."
    echo "Port-forward is detached (PID $pid). Stop with: kill $pid"
    echo "Port-forward log: $log"
    exit 0
  fi
  sleep 0.2
done
kill "$pid"
wait "$pid" || true
echo "Port-forward did not become ready within 30 seconds. See $log:" >&2
cat "$log" >&2
exit 1
