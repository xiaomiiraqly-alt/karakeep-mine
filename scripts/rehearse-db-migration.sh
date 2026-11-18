#!/usr/bin/env bash
# Offline, isolated Karakeep SQLite migration rehearsal. NEVER points at live /data.
set -Eeuo pipefail
set +x
umask 077

if (( $# != 2 )); then
  echo "Usage: $0 ghcr.io/xiaomiiraqly-alt/karakeep-mine@sha256:FULL_DIGEST /path/to/verified-restored-data" >&2
  exit 2
fi

image="$1"
source_data="$(readlink -f -- "$2")"
if [[ ! "$image" =~ ^ghcr\.io/xiaomiiraqly-alt/karakeep-mine@sha256:[a-f0-9]{64}$ ]]; then
  echo "Refusing non-immutable or non-fork image reference" >&2
  exit 2
fi
for bin in docker python3 mktemp cp readlink; do
  command -v "$bin" >/dev/null || { echo "Missing dependency: $bin" >&2; exit 2; }
done
[[ -f "$source_data/db.db" && -f "$source_data/queue.db" ]] || {
  echo "Restored data must contain db.db and queue.db" >&2
  exit 2
}

live_container="$(docker ps -q --filter name='^/karakeep-web-1$')"
if [[ -z "$live_container" ]]; then
  echo "Production container not found; cannot verify data separation" >&2
  exit 2
fi
live_data="$(docker inspect "$live_container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
[[ -n "$live_data" ]] || { echo "Cannot resolve production /data; refusing" >&2; exit 2; }
live_data="$(readlink -f -- "$live_data")"
if [[ "$source_data" == "$live_data" || "$source_data" == "$live_data/"* ||
      "$live_data" == "$source_data/"* ]]; then
  echo "Restored-data path overlaps the LIVE Docker volume; refusing" >&2
  exit 2
fi

stage="$(mktemp -d "$(dirname "$source_data")/.karakeep-migrate-XXXXXX")"
chmod 700 "$stage"
echo "Rehearsal directory: $stage"
echo "Copying verified restored data (never writing to its source)"
cp -a -- "$source_data"/. "$stage"/

python3 - "$stage" <<'PY'
import sqlite3
import sys
from pathlib import Path
base = Path(sys.argv[1])
for name in ("db.db", "queue.db"):
    with sqlite3.connect((base/name).resolve().as_uri()+"?mode=ro", uri=True) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Pre-migration SQLite integrity failure")
        if conn.execute("PRAGMA foreign_key_check").fetchone():
            raise SystemExit("Pre-migration SQLite foreign key failure")
print("Pre-migration database integrity: OK")
PY

# The migration entrypoint is the SAME /db_migrations/index.js used by s6 init.
# Network is disabled; host networking, current Compose files and all live
# volumes are not available in the container.
echo "Executing migration bundle with NO network and only the isolated data mount"
docker run --rm \
  --network none --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --pids-limit 96 --memory 1024m \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e DATA_DIR=/data \
  -v "$stage:/data:rw" \
  --workdir /db_migrations \
  --entrypoint node \
  "$image" index.js

python3 - "$source_data" "$stage" <<'PY'
import sqlite3
import sys
from pathlib import Path
old, new = (Path(x) for x in sys.argv[1:])
for name in ("db.db", "queue.db"):
    file = new/name
    with sqlite3.connect(file.resolve().as_uri()+"?mode=ro", uri=True) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit(f"POST-MIGRATION INTEGRITY FAILURE: {name}")
        if conn.execute("PRAGMA foreign_key_check").fetchone():
            raise SystemExit(f"POST-MIGRATION FOREIGN KEY FAILURE: {name}")
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        print(f"{name}: integrity=OK foreign_keys=OK tables={len(tables)}")
    if name == "db.db":
        with sqlite3.connect((old/name).resolve().as_uri()+"?mode=ro", uri=True) as a, sqlite3.connect(file.resolve().as_uri()+"?mode=ro", uri=True) as b:
            old_tables = {r[0] for r in a.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            new_tables = {r[0] for r in b.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ("user", "bookmarks", "assets"):
                if table in old_tables and table not in new_tables:
                    raise SystemExit(f"CORE TABLE DISAPPEARED: {table}")
                if table in old_tables and table in new_tables:
                    n0 = a.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                    n1 = b.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                    if n0 != n1:
                        raise SystemExit(f"CORE RECORD COUNT CHANGED: {table}: {n0} -> {n1}")
                    print(f"{table}: {n0} records preserved")
print("ISOLATED SCHEMA MIGRATION: PASSED")
print("NOTE: this is not full web/worker E2E, and does not test production cutover.")
PY

echo "Migration result stored privately: $stage"
echo "Production containers, live database, VPN and DNS were not changed."
