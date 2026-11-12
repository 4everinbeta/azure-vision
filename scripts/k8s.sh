#!/usr/bin/env bash
# Run Azure Vision in Docker Desktop's Kubernetes.
# Usage: scripts/k8s.sh up [--no-elastic] | redeploy [--purge] [--no-elastic] | forward [kibana] | logs [service] | status | down [--purge]
set -euo pipefail
cd "$(dirname "$0")/.."
CONTEXT=docker-desktop
NS=azure-vision
PORT="${PORT:-3001}"
APPS=(inventory-api cost-api layout-api web)

kc() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }

require_cluster() {
  kubectl --context "$CONTEXT" get nodes --request-timeout=15s >/dev/null ||
    { echo "Kubernetes in Docker Desktop is not reachable (Settings > Kubernetes > enable / Reset cluster)." >&2; exit 1; }
}

require_docker() {
  if [[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] &&
    [[ "$(docker context show)" == default ]] &&
    [[ "$(docker --host unix:///var/run/docker.sock info --format '{{.OperatingSystem}}')" == "Docker Desktop" ]]; then
    export DOCKER_HOST=unix:///var/run/docker.sock
    echo "Using the verified local Docker Desktop socket for builds." >&2
    # Buildx enumerates context metadata even when an explicit host is selected.
    if ! docker context ls --format '{{.Name}}' >/dev/null; then
      docker_config=$(mktemp -d "${TMPDIR:-/tmp}/azure-vision-docker.XXXXXXXX")
      trap 'rm -rf -- "$docker_config"' EXIT
      if [[ -f "${DOCKER_CONFIG:-$HOME/.docker}/config.json" ]]; then
        cp "${DOCKER_CONFIG:-$HOME/.docker}/config.json" "$docker_config/config.json"
        chmod 600 "$docker_config/config.json"
      fi
      export DOCKER_CONFIG="$docker_config"
      echo "Docker context metadata is unreadable; using temporary client configuration (registry settings preserved)." >&2
    fi
  fi
  if ! docker info >/dev/null; then
    echo "Docker is not reachable. Check Docker Desktop and your Docker context before redeploying." >&2
    return 1
  fi
}

# Docker Desktop's kind-based cluster has its own containerd image store, so rebuilt :local images must be
# imported into the node (otherwise pods silently keep running the first image they saw).
NODE=desktop-control-plane
load_images() {
  docker inspect "$NODE" >/dev/null 2>&1 || return 0 # kubeadm mode shares the Docker image store
  for img in azure-vision-api:local azure-vision-web:local; do
    docker save "$img" | docker exec -i "$NODE" ctr -n k8s.io images import --no-unpack - >/dev/null
  done
}

case "${1:-up}" in
  up)
    require_cluster
    require_docker
    overlay=k8s/overlays/elastic
    [[ "${2:-}" == "--no-elastic" ]] && overlay=k8s/base
    patch_revision=$(date +%Y%m%d%H%M%S)
    docker build --build-arg OS_PATCH_REVISION="$patch_revision" --target api -t azure-vision-api:local .
    docker build --build-arg OS_PATCH_REVISION="$patch_revision" --target web -t azure-vision-web:local .
    load_images
    # Remove the old single-pod deployment if present.
    kc delete deployment/azure-vision service/azure-vision --ignore-not-found >/dev/null 2>&1 || true
    kubectl --context "$CONTEXT" apply -k "$overlay"
    if [[ "$overlay" == k8s/base ]]; then
      kc delete statefulset,deployment,service -l app.kubernetes.io/part-of=elastic --ignore-not-found
    fi
    for a in "${APPS[@]}"; do kc rollout restart "deployment/$a"; done # pick up rebuilt :local images
    for a in "${APPS[@]}"; do kc rollout status "deployment/$a" --timeout=180s; done
    if [[ "$overlay" != k8s/base ]]; then
      echo "Waiting for Elasticsearch (first start pulls ~1GB of images)..."
      kc rollout status statefulset/elasticsearch --timeout=600s
    fi
    echo "Ready. Run: scripts/k8s.sh forward   (then open http://localhost:$PORT)"
    ;;
  redeploy)
    # Stop every workload (PVC data is kept), then rebuild and deploy from scratch.
    require_cluster
    require_docker
    kc delete deployment,statefulset,service --all --ignore-not-found --wait=true
    pass=()
    for a in "${@:2}"; do
      if [[ "$a" == --purge ]]; then kc delete pvc --all --ignore-not-found --wait=true; else pass+=("$a"); fi
    done
    "$0" up "${pass[@]}"
    ;;
  forward)
    require_cluster
    # port-forward binds to loopback only; sign-in is single-user and unauthenticated locally.
    if [[ "${2:-}" == kibana ]]; then
      exec kubectl --context "$CONTEXT" -n "$NS" port-forward --address 127.0.0.1 svc/kibana "${KIBANA_PORT:-5601}:5601"
    else
      exec kubectl --context "$CONTEXT" -n "$NS" port-forward --address 127.0.0.1 svc/web "$PORT:8080"
    fi
    ;;
  logs) kc logs -f "deployment/${2:-inventory-api}" ;;
  status) kc get pods,svc,pvc ;;
  down) # PVCs (cached data) are kept unless --purge is given
    kc delete deployment,statefulset,service --all --ignore-not-found
    [[ "${2:-}" == --purge ]] && kc delete pvc --all --ignore-not-found
    kc get pvc 2>/dev/null || true ;;
  *) echo "usage: $0 up [--no-elastic] | redeploy [--purge] [--no-elastic] | forward [kibana] | logs [service] | status | down [--purge]" >&2; exit 2 ;;
esac
