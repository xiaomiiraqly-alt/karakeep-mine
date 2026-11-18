#!/usr/bin/env bash
# Consistent offline /data snapshot. Dry-run by default. No host VPN/DNS changes.
set -Eeuo pipefail
set +x
umask 077

mode="--plan"
backup_root="/var/backups/karakeep"
project_dir="/opt/karakeep"
if (( $# > 0 )); then mode="$1"; fi
if (( $# > 1 )); then backup_root="$2"; fi
if [[ -n "$(printenv KARAKEEP_PROJECT_DIR || true)" ]]; then
  project_dir="$KARAKEEP_PROJECT_DIR"
fi
if [[ "$mode" != "--plan" && "$mode" != "--execute" ]]; then
  echo "Usage: $0 [--plan|--execute] [ABSOLUTE_BACKUP_DIRECTORY]" >&2
  exit 2
fi
if [[ "$backup_root" != /* || "$project_dir" != /* ]]; then
  echo "Backup and project paths must be absolute" >&2
  exit 2
fi
for cmd in docker python3 tar sha256sum du df readlink stat find mktemp awk; do
  command -v "$cmd" >/dev/null || { echo "Missing dependency: $cmd" >&2; exit 2; }
done
[[ -f "$project_dir/.env" ]] || { echo "Missing $project_dir/.env" >&2; exit 2; }
cd "$project_dir"
docker compose version >/dev/null

# Check the resolved Compose configuration without ever printing credentials.
docker compose config --format json | python3 -c '
import json, sys
s=json.load(sys.stdin)["services"]
if s["web"].get("network_mode") != "service:awg-client":
    raise SystemExit("Refusing unexpected web network mode")
if s["chrome"].get("network_mode") != "service:awg-client":
    raise SystemExit("Refusing unexpected Chrome network mode")
if "awg-client" not in s or "meilisearch" not in s:
    raise SystemExit("Missing expected infrastructure services")
'

web_id="$(docker compose ps -q web)"
[[ -n "$web_id" ]] || { echo "Web container missing" >&2; exit 2; }
[[ "$(docker inspect --format '{{.State.Running}}' "$web_id")" == "true" ]] \
  || { echo "Web must be running before a controlled snapshot" >&2; exit 2; }

data_source="$(docker inspect "$web_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
data_type="$(docker inspect "$web_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}')"
[[ "$data_type" == "volume" || "$data_type" == "bind" ]] \
  || { echo "Unexpected /data mount type" >&2; exit 2; }
[[ -d "$data_source" ]] || { echo "Missing /data source directory" >&2; exit 2; }
data_source="$(readlink -f -- "$data_source")"
project_dir="$(readlink -f -- "$project_dir")"
backup_root="$(readlink -m -- "$backup_root")"
if [[ "$backup_root" == "$project_dir" || "$backup_root" == "$project_dir/"* ||
      "$backup_root" == "$data_source" || "$backup_root" == "$data_source/"* ||
      "$data_source" == "$backup_root/"* || "$backup_root" == "/" ]]; then
  echo "Backup destination overlaps the project or /data; refusing" >&2
  exit 2
fi

disk_path="$backup_root"
until [[ -d "$disk_path" ]]; do disk_path="$(dirname "$disk_path")"; done
size_kib="$(du -sk -- "$data_source" | awk '{print $1}')"
avail_kib="$(df -Pk -- "$disk_path" | awk 'END {print $4}')"
echo "=== Snapshot preflight ==="
echo "Web: running; network isolation: verified"
echo "/data mount type: $data_type"
echo "Estimated /data size: $size_kib KiB"
echo "Available backup capacity: $avail_kib KiB"
echo "Destination: $backup_root"
if [[ "$(stat -c %d -- "$data_source")" == "$(stat -c %d -- "$disk_path")" ]]; then
  echo "WARNING: backup destination is on the same filesystem as /data; keep an off-host copy."
fi
if (( avail_kib < size_kib + 262144 )); then
  echo "Not enough free space for an uncompressed snapshot plus 256 MiB reserve" >&2
  exit 1
fi
if [[ "$mode" == "--plan" ]]; then
  echo "PLAN ONLY: no files, containers or data were changed."
  exit 0
fi

# Explicit --execute is needed to incur web downtime. AWG, Chrome, Meili and
# unrelated services are neither stopped nor restarted by this script.
mkdir -p -m 700 -- "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp -d "$backup_root/.snapshot-$stamp-XXXXXX")"
chmod 700 "$stage"
mkdir -m 700 "$stage/config"
web_stopped=0
restore_web() {
  rc=$?
  if (( web_stopped )); then
    echo "Restoring the original web service after snapshot attempt"
    docker compose start web >/dev/null || echo "ERROR: automatic web restart failed" >&2
  fi
  if (( rc != 0 )); then
    echo "Snapshot incomplete; investigate private staging directory: $stage" >&2
  fi
}
trap restore_web EXIT

# Keep secrets only in local root-owned backup; never upload to GitHub.
cp -a -- "$project_dir/.env" "$stage/config/.env"
find "$project_dir" -maxdepth 1 -type f \( -name '*compose*.yml' -o -name '*compose*.yaml' \) \
  -exec cp -a -- '{}' "$stage/config/" \;
docker compose config > "$stage/config/resolved-compose.private.yml"
docker inspect "$web_id" --format 'ConfiguredImage={{.Config.Image}} ImageID={{.Image}}' \
  > "$stage/config/web-image.txt"

# Stop only the AIO web/worker writers before copying SQLite (including WAL).
web_stopped=1
docker compose stop web >/dev/null
tar -C "$data_source" -cpf "$stage/data.tar" .
tar -tf "$stage/data.tar" >/dev/null
( cd "$stage" && sha256sum data.tar > data.tar.sha256 && sha256sum -c data.tar.sha256 >/dev/null )
docker compose start web >/dev/null
web_stopped=0

final="$backup_root/snapshot-$stamp"
[[ ! -e "$final" ]] || { echo "Snapshot name collision" >&2; exit 1; }
mv -- "$stage" "$final"
trap - EXIT
echo "COMPLETE: $final"
echo "Includes app /data, private Compose files and immutable web image reference."
echo "Not included: consistent Meilisearch index; back it up separately or reindex."
echo "Restore into isolated test volumes and validate migrations BEFORE upgrading production."
