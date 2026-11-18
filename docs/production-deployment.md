# Production deployment plan: custom Karakeep + upstream v0.35.0

This runbook applies to the **custom fork** and the existing Ubuntu Docker Compose installation under `/opt/karakeep`. It does **not** apply to the separate exit VPN server, and it never changes AmneziaWG, firewall, DNS or Ozon workloads.

## Release gates — do not skip

1. Record a tested commit SHA from PR #11 and verify that **CI**, **Instagram integration verification**, and **Chrome Image** finish successfully for that exact SHA. CI includes TypeScript, lint, formatting, unit/integration tests and Playwright E2E tests.
2. Review the fork-specific files against upstream `v0.35.0`: Instagram import, titles, tags, OCR, remote sandbox, asset ownership and webhook/authentication behavior.
3. Merge the reviewed PR into `main`; wait for main CI and the independent `Build and Publish Karakeep Mine` workflow.
   The publisher checks the **same commit** for a successful `push` run of both the main CI and `Instagram integration verification` (which includes the security-audit gate and custom image smoke build). It waits for the latter or fails closed; a green run on another commit is not acceptable. The Chrome workflow is an additional pull-request review gate when relevant, not currently a release-publisher prerequisite.
4. Copy the published **immutable** `ghcr.io/xiaomiiraqly-alt/karakeep-mine@sha256:...` digest from the publisher's job summary. Do **not** deploy the floating `:instagram` tag.
5. Before any production upgrade, run an **isolated restore and migration test** using a copy of actual production data; a GitHub Actions fixture cannot prove compatibility with your existing database.

## 1. Inspect the current host (read-only)

Run on the **main** VPS, not the exit VPS:

```bash
cd /opt/karakeep
docker compose version
docker compose config --services
docker compose ps
```

A redacted, read-only preflight script is in `scripts/production-preflight.sh`. It reports Compose services, image reference, network namespace, volume *destinations*, and web container state; it deliberately does not print `.env`, API keys, proxy passwords, or VPN profiles.

Verify the Compose service names and mounts before proceeding. The known installation has custom Compose layers for AI, release, AmneziaWG and DNS; preserve their order and contents. In particular, web and Chrome use `network_mode: service:awg-client`; the AWG client publishes the loopback web port. Never replace that layout with upstream's stock Compose file.

## 2. Snapshot state and make a consistent backup

Use a root-owned directory with permissions `0700` on a separate storage location with sufficient capacity. Back up:

- All active Compose files and the private `.env` **without committing them to GitHub**.
- The database **and** any SQLite `-wal`/`-shm` files (or a valid SQLite backup); bookmarked files/assets, installed configuration, encryption secrets and session data.
- Meilisearch data, if a byte-for-byte search-index restore is wanted (otherwise plan for a full reindex).
- Existing image **digest**, container mounts, and the current `docker compose config` plan in a root-private directory (configuration output may contain secrets).

**Consistency requirement:** halt writers by stopping the application web/worker container before copying the mounted application data, or use a rigorously tested SQLite online-backup implementation. Do not run a casual `tar` while SQLite is receiving writes. Keep `awg-client` running. Confirm the backup archive is readable and actually contains the expected SQLite database and assets. Restart the previous application after backup.

The upstream 0.35.0 image changes process privilege handling. On the isolated copy, verify that existing `/data` ownership and permissions allow the new process to write; inspect for warnings before adopting the documented `KARAKEEP_DISABLE_PRIVILEGE_DROP=true` compatibility escape hatch.

### Opt-in backup helper for the known /opt/karakeep layout

On the **main application VPS**, first obtain the reviewed script and inspect its
contents before running it. By default it operates in **plan-only** mode:

\`\`\`bash
cd /opt/karakeep
bash /path/to/production-backup.sh --plan /var/backups/karakeep
\`\`\`

The plan checks the Compose services, shared AWG network namespace, actual
\`/data\` mount, source size, available backup space and destination overlap.
It prints no environment variables or API keys and does not stop any service.

Only after checking the output and accepting a temporary **Karakeep web/worker
outage**, run the deliberate write operation:

\`\`\`bash
bash /path/to/production-backup.sh --execute /var/backups/karakeep
\`\`\`

The script stops **only** Compose service \`web\`, archives its persistent
\`/data\` including SQLite database, WAL and assets, saves the original Compose
files and private resolved configuration, validates tar readability and SHA-256,
and starts the original \`web\` service again. It uses an EXIT trap to attempt
web restart after failures. It does **not** stop AWG, Chrome, Meilisearch or Ozon.

**Precautions:** It contains unencrypted user data and private configuration,
is stored in a root-only directory, and must never be published, pasted into
issues or uploaded to GitHub. Prefer a different disk and an encrypted off-host
copy. It is NOT a substitute for validating SQLite integrity on an extracted
copy, actually restoring the archive, or rehearsing migrations and rollback.
The Meilisearch index is not consistently backed up by this script; use the
Meilisearch snapshot mechanism or plan a reindex. Do not run \`--execute\`
before reviewing the plan and determining an acceptable maintenance window.

## 3. Rehearse migration off-line

Create an independent database/assets copy and an independent Compose project with **separate volume names, isolated port bindings and no production AWG network namespace**. Test the exact immutable candidate image with the copied data. Check database migrations, account logins, bookmarks and assets, search, and job processing. Keep secrets offline; use test API credentials or mock providers to avoid external charges.

Do not ever point a candidate test container at the live database, live asset store or live Meilisearch index.

## 4. Production rollout

Record the old digest and current Compose override files. Add the new image reference as the **last** image override in the active Compose file sequence; make the change persistent for reboot. Verify the complete merged Compose configuration **without publishing it**. This must not alter `awg-client` or the host DNS.

After the successful backup and rehearsal:

```bash
cd /opt/karakeep
docker compose config --services
# Confirm the exact resolved image reference in private output.
# Start only affected application components; NEVER use 'down -v'.
docker compose up -d --no-deps web
docker compose ps
```

Update Chrome separately if required by the new upstream version and validate that it still shares the AWG network namespace. Do **not** run `docker compose down`, restart the VPN, change host routes, or remove volumes. Preserve the published loopback binding and all six known Compose layers.

## 5. Acceptance tests after rollout

1. `/api/health` returns HTTP 200 via the existing HTTPS endpoint.
2. Existing user signs in and old bookmarks, lists, highlights and attachments are present.
3. Imported Instagram single photo, carousel and Reel produce correct media ordering, caption/reader attachments, summary and short title.
4. Ordinary web link, text bookmark and local picture without OCR text create accurate summaries and tags; at least five **grounded distinct** topical concepts when supported, and an explicit incomplete status otherwise.
5. Existing tag reuse and curated vocabulary respect ownership and manual titles.
6. Meilisearch returns archived and new content; queues drain; no persistent errors in web/worker/Chrome logs.
7. No API secret or VPN profile appears in CI logs or repository. An authenticated Gemini test is **separate**: its previously observed regional rejection cannot be fixed merely by a successful TLS/DNS check.
8. Existing AmneziaWG clients, domain, TLS certificate and Ozon workloads remain operational.

## 6. Rollback

A pre-migration image is **not sufficient** to roll back a migrated database. If the schema changed incompatibly, stop the application writers, restore the entire matching **pre-upgrade** database/assets snapshot and original Compose files/image digest, then start the previous application. Restore Meilisearch or reindex as needed. Never let both versions write the same database.

Rehearse the rollback against copied volumes before production change. Keep the old image and backup until acceptance is complete.

## Known limitations

- Our Instagram downloader currently **refuses** to run with the experimental remote sandbox enabled. It does not silently bypass it.
- A full production data-copy rehearsal and production health check cannot be completed from GitHub Actions alone.
- Post-release upstream `main` commits are not automatically included in the `v0.35.0` release tag; evaluate them separately.
- Passing CI validates the tested code paths, not every possible external Instagram or AI-provider response.
