#!/usr/bin/env bash
# Smoke-test the web frontend of an immutable candidate image on a COPY of
# already restored-and-migrated Karakeep /data. Never contacts external hosts.
# Does not start worker processes, alter Compose, attach any production volume,
# open a port, or access production secrets.
set -Eeuo pipefail
set +x
umask 077

if (( $# != 2 )); then
  echo "Usage: $0 ghcr.io/xiaomiiraqly-alt/karakeep-mine@sha256:FULL_DIGEST /ABSOLUTE/PATH/TO/MIGRATED-COPY" >&2
  exit 2
fi
image="$1"
input="$2"
if [[ ! "$image" =~ ^ghcr\.io/xiaomiiraqly-alt/karakeep-mine@sha256:[a-f0-9]{64}$ ]]; then
  echo "Refusing non-immutable or non-fork image" >&2
  exit 2
fi
[[ "$input" == /* && -d "$input" ]] || { echo "Source must be an existing absolute directory" >&2; exit 2; }
for cmd in docker python3 mktemp cp readlink stat sleep; do
  command -v "$cmd" >/dev/null || { echo "Missing: $cmd" >&2; exit 2; }
done
source="$(readlink -f -- "$input")"
[[ -f "$source/db.db" && -f "$source/queue.db" ]] || {
  echo "Missing source db.db/queue.db" >&2
  exit 2
}
[[ -d "$source" && ! -L "$source" ]] || { echo "Invalid source directory" >&2; exit 2; }

web_id="$(docker ps -q --filter 'name=^/karakeep-web-1$')"
[[ -n "$web_id" ]] || { echo "Cannot verify live app container; refusing" >&2; exit 2; }
live_data="$(docker inspect "$web_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[[ -n "$live_data" ]] || { echo "Cannot determine live /data" >&2; exit 2; }
live_data="$(readlink -f -- "$live_data")"
if [[ "$source" == "$live_data" || "$source" == "$live_data/"* || "$live_data" == "$source/"* ]]; then
  echo "Source overlaps production /data" >&2
  exit 2
fi

# This stage is a sibling of the migration rehearsal, not a child of its data.
parent="$(dirname "$source")"
stage="$(mktemp -d "$parent/.karakeep-web-smoke-XXXXXXXX")"
chmod 700 "$stage"
container="karakeep-web-smoke-$(basename "$stage" | tail -c 9)"
container_created=0
cleanup() {
  rc=$?
  if (( container_created )); then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if (( rc != 0 )); then
    echo "WEB SMOKE FAILED. No production container or data was changed." >&2
    echo "Private isolated stage retained for inspection: $stage" >&2
  fi
}
trap cleanup EXIT

echo "Making a fresh, isolated copy of the migrated data"
cp -a -- "$source"/. "$stage"/
secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
meili_test_secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"

# Explicitly override the image's /init entrypoint so only the Next.js web
# process runs. No queue processors, background jobs, or live API credentials.
# --network none creates no internet route, and no ports are published.
docker run --detach \
  --name "$container" \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --pids-limit 128 \
  --memory 1024m \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --tmpfs /app/apps/web/.next/cache:rw,nosuid,nodev,size=128m \
  --mount "type=bind,source=$stage,target=/data" \
  --env DATA_DIR=/data \
  --env HOSTNAME=127.0.0.1 \
  --env PORT=3000 \
  --env NEXTAUTH_URL=http://127.0.0.1:3000 \
  --env AUTH_TRUSTED_ORIGINS=http://127.0.0.1:3000 \
  --env NEXTAUTH_SECRET="$secret" \
  --env MEILI_ADDR=http://127.0.0.1:7700 \
  --env MEILI_MASTER_KEY="$meili_test_secret" \
  --env BROWSER_WEB_URL=http://127.0.0.1:9222 \
  --env DISABLE_NEW_RELEASE_CHECK=true \
  --env INFERENCE_ENABLE_AUTO_TAGGING=false \
  --env INFERENCE_ENABLE_AUTO_SUMMARIZATION=false \
  --env SEMANTIC_SEARCH_ENABLED=false \
  --env EMBEDDING_ENABLE_AUTO_INDEXING=false \
  --env LOG_LEVEL=warn \
  --workdir /app/apps/web \
  --entrypoint node \
  "$image" server.js >/dev/null
container_created=1

success=0
echo "Checking /api/health via docker exec inside isolated network namespace"
for attempt in {1..40}; do
  if docker exec "$container" node -e '
      fetch("http://127.0.0.1:3000/api/health", {signal:AbortSignal.timeout(2500)})
        .then(r => process.exit(r.status === 200 ? 0 : 1))
        .catch(() => process.exit(1));
    ' >/dev/null 2>&1; then
    success=1
    break
  fi
  if [[ "$(docker inspect "$container" --format '{{.State.Running}}')" != "true" ]]; then
    echo "Staging web process exited before becoming healthy" >&2
    break
  fi
  sleep 2
done

if (( success != 1 )); then
  echo "No healthy response from isolated web process; inspect container logs locally before cleanup" >&2
  # Avoid printing logs automatically: restored databases contain real data.
  exit 1
fi
echo "WEB STARTUP: /api/health = HTTP 200 (network none; no published ports)"

docker stop --time 10 "$container" >/dev/null
docker rm "$container" >/dev/null
container_created=0

python3 - "$source" "$stage" <<'PY'
import sqlite3
import sys
from pathlib import Path

original, staged = [Path(s) for s in sys.argv[1:]]
for filename in ("db.db", "queue.db"):
    with sqlite3.connect((staged / filename).resolve().as_uri() + "?mode=ro", uri=True) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit(f"Post-web SQLite integrity failed: {filename}")
        if conn.execute("PRAGMA foreign_key_check").fetchone():
            raise SystemExit(f"Post-web foreign-key check failed: {filename}")
    print(f"{filename}: integrity=OK, foreign_keys=OK")
for table in ("user", "bookmarks", "assets"):
    with sqlite3.connect((original / "db.db").resolve().as_uri() + "?mode=ro", uri=True) as old, sqlite3.connect((staged / "db.db").resolve().as_uri() + "?mode=ro", uri=True) as new:
        count_old = old.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        count_new = new.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        if count_old != count_new:
            raise SystemExit(f"{table}: record count unexpectedly changed: {count_old} -> {count_new}")
        print(f"{table}: {count_new} records preserved")
PY
trap - EXIT
echo "ISOLATED WEB SMOKE: PASSED"
echo "Private staging copy: $stage"
echo "Limitations: no workers, login, search, Chrome, Meilisearch, AI or external Instagram tested."
echo "No production containers, VPN, DNS, or volumes were changed."
