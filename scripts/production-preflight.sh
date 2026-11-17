#!/usr/bin/env bash
# Read-only deployment inspection: do not print any .env values or Docker credentials.
set -Eeuo pipefail
set +x
umask 077

project_dir="${1:-/opt/karakeep}"
if [[ ! -d "$project_dir" || ! -f "$project_dir/.env" ]]; then
  echo "ERROR: Compose directory or .env not found: $project_dir" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "ERROR: docker missing" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 missing" >&2; exit 1; }
docker compose version >/dev/null || { echo "ERROR: docker compose missing" >&2; exit 1; }

cd "$project_dir"
echo "=== Compose project: services and public-safe metadata only ==="
# Never print raw 'docker compose config' -- it may contain API keys.
docker compose config --format json | python3 -c '
import json, sys
config = json.load(sys.stdin)
services = config.get("services", {})
for name in ("awg-client", "web", "chrome", "meilisearch"):
    service = services.get(name)
    if service is None:
        print("ERROR: missing Compose service:", name)
        sys.exit(2)
    image = service.get("image", "<built locally>")
    network = service.get("network_mode", "<compose networks>")
    mounts = [str(m.get("target", "")) for m in service.get("volumes", []) if isinstance(m, dict)]
    print(f"{name}: image={image} network_mode={network} mount_targets={mounts}")
    if name in ("web", "chrome") and network != "service:awg-client":
        print("WARNING: shared AWG network namespace is not confirmed for", name)
web = services["web"]
if not any(m.get("target") == "/data" for m in web.get("volumes", []) if isinstance(m, dict)):
    print("WARNING: expected persistent /data mount was not found; inspect before any upgrade")
print("NOTE: no environment variables or secrets displayed")
'
echo
echo "=== Running Compose containers ==="
docker compose ps
echo
echo "=== Current web image reference ==="
web_id="$(docker compose ps -q web)"
if [[ -z "$web_id" ]]; then
  echo "WARNING: web container is not running"
else
  docker inspect "$web_id" --format 'Configured image: {{.Config.Image}} | Image ID: {{.Image}} | State: {{.State.Status}}'
fi
echo
echo "=== Version pinning ==="
echo "Only deploy a tested ghcr.io/...@sha256:... digest; never a floating tag."
echo "READ-ONLY PREFLIGHT COMPLETE. No containers, volumes, DNS or VPN settings changed."
