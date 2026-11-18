#!/usr/bin/env bash
# Karakeep v0.35.0-fork deployment for the known /opt/karakeep setup.
# Only the Compose "web" service changes. Always take a fresh offline /data
# snapshot; restore its database/assets with the old image on failed health.
set -Eeuo pipefail
set +x
umask 077

OLD="ghcr.io/xiaomiiraqly-alt/karakeep-mine@sha256:24ca0bc10891d474ab28cbf430628cb4e58e9f0074fd98352aec57d05af73494"
NEW="ghcr.io/xiaomiiraqly-alt/karakeep-mine@sha256:9697fcf4feb7cb6644e0b86a2553ab816a2268f663e504ab26a5d33e15cf3fbd"
OVERRIDE="docker-compose.karakeep-v035.yml"
BACKUP_SCRIPT="/tmp/karakeep-production-backup.sh"

cd /opt/karakeep
[[ -f .env && -f "$BACKUP_SCRIPT" ]] || {
  echo "Missing /opt/karakeep/.env or previously verified backup script" >&2
  exit 1
}
[[ ! -e "$OVERRIDE" ]] || {
  echo "Deployment override exists already; refusing to overwrite" >&2
  exit 1
}
bash -n "$BACKUP_SCRIPT"
docker compose version >/dev/null

# Fail before touching anything if this is not the exact installation reviewed.
docker compose config --format json | python3 -c '
import json, sys
s=json.load(sys.stdin)["services"]
old=sys.argv[1]
assert s["web"]["image"]==old, "Unexpected current web image"
assert s["web"].get("network_mode")=="service:awg-client"
assert s["chrome"].get("network_mode")=="service:awg-client"
assert {"web","chrome","awg-client","meilisearch"} <= set(s)
' "$OLD"

WEB="$(docker compose ps -q web)"
[[ -n "$WEB" ]] || { echo "Running web container not found" >&2; exit 1; }
SOURCE="$(docker inspect "$WEB" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
MOUNT_TYPE="$(docker inspect "$WEB" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}')"
SOURCE="$(readlink -f -- "$SOURCE")"
[[ "$MOUNT_TYPE" == "volume" && "$SOURCE" == */_data &&
   -f "$SOURCE/db.db" && -f "$SOURCE/queue.db" ]] || {
  echo "Unexpected live /data source; refusing to modify or restore it" >&2
  exit 1
}

echo "=== Download tested v0.35.0 image ==="
docker pull "$NEW"

echo "=== Fresh, consistent pre-deployment backup ==="
bash "$BACKUP_SCRIPT" --execute /var/backups/karakeep
SNAPSHOT="$(find /var/backups/karakeep -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
[[ -n "$SNAPSHOT" && -f "$SNAPSHOT/config/.env" && -f "$SNAPSHOT/data.tar" ]] || {
  echo "Fresh backup missing; not deploying" >&2
  exit 1
}
( cd "$SNAPSHOT" && sha256sum -c data.tar.sha256 )
docker compose config --format json > "$SNAPSHOT/config/pre-deploy-compose.private.json"
chmod 600 "$SNAPSHOT/config/pre-deploy-compose.private.json"

ARMED=0
MAY_HAVE_MIGRATED=0
ROLLBACK_OK=0
rollback() {
  code=$?
  if [[ "$ARMED" == 1 ]]; then
    trap - EXIT
    set +e
    echo "=== ERROR ($code). Automatic rollback to old image and pre-deploy data ===" >&2
    if [[ "$MAY_HAVE_MIGRATED" == 1 ]]; then
      docker compose stop web >/dev/null
    fi
    cp -a -- "$SNAPSHOT/config/.env" /opt/karakeep/.env
    rm -f -- "/opt/karakeep/$OVERRIDE"

    if [[ "$MAY_HAVE_MIGRATED" == 1 ]]; then
      if [[ -d "$SOURCE" && "$SOURCE" == */_data && -f "$SNAPSHOT/data.tar" ]]; then
        if find "$SOURCE" -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' + &&
           tar -C "$SOURCE" -xpf "$SNAPSHOT/data.tar"; then
          ROLLBACK_OK=1
        else
          echo "CRITICAL: could not restore /data automatically. Snapshot: $SNAPSHOT" >&2
        fi
      else
        echo "CRITICAL: original data mount not verified at rollback." >&2
      fi
    else
      ROLLBACK_OK=1
    fi
    if [[ "$ROLLBACK_OK" == 1 ]]; then
      docker compose up -d --no-deps web || echo "CRITICAL: old web start failed" >&2
      echo "Rollback attempted. Verify web health and keep snapshot: $SNAPSHOT" >&2
    fi
  fi
}
trap rollback EXIT

echo "=== Prepare persistent, web-only Compose override ==="
ARMED=1
printf 'services:\n  web:\n    image: "%s"\n' "$NEW" > "$OVERRIDE"
chmod 600 "$OVERRIDE"

# Update only the COMPOSE_FILE line. Preserve all other .env contents.
python3 - "$OVERRIDE" <<'PY'
from pathlib import Path
import sys
p=Path(".env")
lines=p.read_text().splitlines(keepends=True)
matches=[i for i,line in enumerate(lines) if line.lstrip().startswith("COMPOSE_FILE=")]
if len(matches)!=1:
    raise SystemExit("Expected exactly one COMPOSE_FILE entry in .env")
idx=matches[0]
prefix,raw=lines[idx].rstrip("\r\n").split("=",1)
value=raw.strip()
quote=""
if len(value)>=2 and value[0] in ("'",'"') and value[-1]==value[0]:
    quote=value[0]
    value=value[1:-1]
if not value or "#" in value or sys.argv[1] in value:
    raise SystemExit("Unexpected COMPOSE_FILE syntax or duplicate override")
lines[idx]=prefix+"="+quote+value+":"+sys.argv[1]+quote+"\n"
p.write_text("".join(lines))
PY

# The ONLY resolved configuration change permitted is services.web.image.
docker compose config --format json > "$SNAPSHOT/config/post-deploy-compose.private.json"
chmod 600 "$SNAPSHOT/config/post-deploy-compose.private.json"
python3 - "$OLD" "$NEW" "$SNAPSHOT" <<'PY'
import json,sys
from pathlib import Path
old,new,snap=sys.argv[1:]
p=Path(snap)/"config"
before=json.loads((p/"pre-deploy-compose.private.json").read_text())
after=json.loads((p/"post-deploy-compose.private.json").read_text())
if before["services"]["web"]["image"]!=old or after["services"]["web"]["image"]!=new:
    raise SystemExit("Resolved image does not match expected release")
after["services"]["web"]["image"]=old
if before!=after:
    raise SystemExit("Compose change differs from web.image only. Aborting.")
print("Compose verification: only web.image changes")
PY

echo "=== Deploying only the web service ==="
MAY_HAVE_MIGRATED=1
docker compose up -d --no-deps web

echo "=== Waiting for Karakeep and HTTPS health ==="
HEALTHY=0
for attempt in $(seq 1 60); do
  CURRENT_ID="$(docker compose ps -q web)"
  if [[ -n "$CURRENT_ID" ]] &&
     [[ "$(docker inspect "$CURRENT_ID" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == "healthy" ]] &&
     curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/api/health &&
     curl -fsS --max-time 8 -o /dev/null https://zametkiblya.duckdns.org/api/health; then
    HEALTHY=1
    break
  fi
  sleep 3
done
[[ "$HEALTHY" == 1 ]] || {
  echo "New web container is not healthy within the rollout window" >&2
  exit 1
}

ARMED=0
trap - EXIT
echo
echo "SUCCESS: Karakeep v0.35.0 fork is running and public HTTPS returned 200"
echo "Immutable new image: $NEW"
echo "Pre-deploy backup: $SNAPSHOT"
echo "AWG, Chrome, Meilisearch, and Ozon services were not recreated."
docker compose ps web
