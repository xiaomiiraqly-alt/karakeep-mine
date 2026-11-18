# Technical audit: Karakeep v0.35.0 + custom fork

Date: 2026-11-18. Status: **candidate, not deployed**. Scope: integration PR [#11](https://github.com/xiaomiiraqly-alt/karakeep-mine/pull/11) and isolated dependency-security PR [#12](https://github.com/xiaomiiraqly-alt/karakeep-mine/pull/12).

This document records tested evidence, concrete corrections and remaining limitations. **An exhaustive proof that all code is bug-free is not possible**, and CI cannot replace a staging upgrade using a copy of production data.

## Baseline and provenance

- Official Karakeep stable upstream: [v0.35.0](https://github.com/karakeep-app/karakeep/releases/tag/v0.35.0) (published November 15, 2026).
- Fork's original `main` branch remains the rollback reference while PR #11 is reviewed.
- The integration branch merged upstream's v0.35.0 into a separate candidate. The official tag includes hardening for avatar cleanup/path traversal, webhook redirect credential leakage, authentication rate limits, collaboration access controls, NAT64 SSRF, and Node.js November 2026 security patches.
- The custom fork retains original upstream AGPL-3.0 license and its original license file.
- This is a **release-tag integration**, not an automatic merge of unreviewed upstream `main` commits published after the stable tag.

## Custom features reviewed

| Subsystem | Main source files | Review and tests |
| --- | --- | --- |
| Public Instagram post, carousel and Reel acquisition | `apps/workers/workers/instagram.ts`, `utils/instagramPublic.ts`, `utils/instagramUrls.ts` | URL allow-listing, signed media URL validation, redirects forbidden, size limits, aborts, metadata file limits, gallery ordering, completion/fallback |
| Content extraction and Reader | `utils/instagramReaderHtml.ts`, `packages/trpc/lib/instagramReaderAssets.ts`, `crawlerWorker.ts` | HTML escaping, signed local asset links, ownership checks, simultaneous re-crawls |
| AI summaries and short meaningful titles | `inference/summarize.ts`, `instagramTitle.ts`, `inferenceWorker.ts` | No false success if no inference client; manual title preserved; conditional update on concurrent HTML change |
| Automatic tags and semantic reuse | `inference/tagging.ts`, `tagVocabulary.ts`, `semanticTagReuse.ts`, `taggingPolicy.ts`, `taggingResilience.ts` | Existing tag reuse, curated tag restrictions, user ownership, at least five grounded concepts where available; incomplete vs skipped status |
| Tag duplicate review UI | `packages/trpc/routers/tags.ts`, `apps/web/components/dashboard/tags/TagAudit.tsx` | Owner-scoped suggestions; no unattended destructive tag merge |
| Base security and containers | `docker/Dockerfile`, `.github/workflows/docker.yml`, `.github/workflows/ci.yml` | No untrusted publishing on PRs; base upstream hardening; release image must be pinned to digest |

## Defects corrected in integration PR

1. **Incorrect inference status:** a job with no model, a disabled auto-tagging setting, deleted curated tags or unavailable input could be recorded as successful. Added explicit `skipped` outcome and cleared pending status for skipped summarization/tagging. The `incomplete` tag outcome still reports failure, not success.
2. **Unsafe second-stage Instagram media access:** validation is repeated just before each CDN fetch; nonstandard ports and userinfo are disallowed; canonical post/reel URLs are constrained.
3. **Unbounded metadata-read exposure:** third-party sidecar files are stat-checked before being read and parsed.
4. **Signed Reader HTML attribute escaping:** all unsafe attribute characters are escaped, not only `&`; regression test covers hostile signer output.
5. **Concurrent recrawl/title generation:** an AI-generated Instagram Reader title now uses optimistic HTML compare-and-set, avoiding replacement of Reader content modified by a later crawl.
6. **Regression coverage:** unit tests added for job states, CDN guard, bad signed URL and concurrent Reader update; canonical formatter applied using the repository's own `oxfmt`.

## Evidence of automated verification

- Full GitHub CI: TypeScript typecheck, lint, canonical formatting, lockfile integrity, OpenAPI specification checks, unit/integration tests and browser E2E.
- Instagram integration workflow: focused workers integration tests and production-like no-publish Docker image build.
- Chrome Image workflow: both amd64 and arm64 build verification.
- Security remediation probe: Docusaurus optimized production build, Docusaurus TypeScript check and **486 mobile tests passed** while testing patched transitive dependencies.
- The latest state of all checks must be inspected **for the final SHA**, not inferred from a previous green run. Workflow pushes, ephemeral formatting jobs and dependency edits may invalidate earlier checks.

Verification links: [Actions](https://github.com/xiaomiiraqly-alt/karakeep-mine/actions), [PR #11](https://github.com/xiaomiiraqly-alt/karakeep-mine/pull/11), [PR #12](https://github.com/xiaomiiraqly-alt/karakeep-mine/pull/12).

## Third-party dependency security

The initial full pnpm audit exposed critical `tinypool` issues in the Docusaurus documentation build tree, plus high alerts across documentation, mobile and browser-extension/build tools. The isolated remediation branch tests:

- `tinypool 2.1.2` for the known critical worker-pool issues.
- `linkify-it 5.0.2` for matching complexity advisories.
- `markdown-it 14.3.3` for the two separate quadratic-complexity advisories, including [GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c).
- Lockfile updates for other automatically resolvable vulnerabilities.

**Known residual advisories which are not silently waived:**

1. `@faker-js/faker` — [GHSA-qxc2-j82w-r537](https://github.com/advisories/GHSA-qxc2-j82w-r537), pulled by the documentation Postman converter; a forced update to faker 10.5.0 made the docs build fail because the old converter uses incompatible faker APIs. That version override was reverted to preserve functionality; replacing or upgrading the converter requires separate validation.
2. `picomatch` — [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), largely under tools/build chains; the advisory reports **no patched npm release** as of this audit. This is an explicit residual risk, not a clean bill of health.

Risk classification must account for actual shipped artifacts: an alert in a development/build dependency does **not** automatically establish an exploitable flaw in the production web/worker image. Conversely, a clean application unit test does **not** clear third-party advisory risks. Preserve the full audit output and distinguish shipped dependencies from tooling before accepting a release.

## Data integrity and deployment gates

1. Main VPS currently uses custom Compose override layers and a separate AWG client network namespace. **Do not** replace them with stock upstream Compose, alter VPN/DNS/routes or restart other workloads.
2. Record the current web Docker **digest**, all Compose override files, mounts and environment configuration (privately, never in CI logs).
3. Take a consistent offline backup of the SQLite database (including journal/WAL correctness), assets, configurations and optional Meilisearch index. Stop **only app writers** while copying or use a tested online-backup mechanism.
4. **Restore** that backup into independent test volumes. Validate migrations and the new v0.35.0 image against this data copy before touching production.
5. Verify upstream privilege-drop change against real `/data` permissions. Prefer fixing ownership rather than disabling hardening.
6. Deploy only an immutable `ghcr.io/...@sha256:...` produced from reviewed `main`, preserving all active Compose layering and AWG network mode.
7. Run real end-to-end checks with existing user data: HTTPS health, login, old bookmark assets, search, Instagram photo/carousel/Reel ordering and captions, local non-OCR images, text bookmarks, title/summary/tags, queues, Chrome scraping and rollback.
8. Reindex Meilisearch if necessary. Do not use `docker compose down -v`.
9. Rehearse rollback including **old database and assets**, not only the old image digest: a migrated database may be incompatible with older code.
10. Keep unrelated AWG/Ozon services online throughout; network transport and Gemini API regional eligibility are separate issues.

Deployment instructions: [docs/production-deployment.md](./production-deployment.md). Read-only diagnosis: [scripts/production-preflight.sh](../scripts/production-preflight.sh).

## Outstanding blockers / deliberately unverified

- PR #11 and PR #12 must both pass final-sha CI and review of the dependency diff.
- All in-scope security warnings must be fixed, replaced or explicitly risk-accepted with the rationale and affected shipped-artifact analysis.
- Live production-data migration/rollback rehearsal cannot be asserted from GitHub CI and has not been performed.
- Unauthenticated Instagram retrieval depends on upstream network access and content visibility; mock tests cannot guarantee every real post downloads successfully.
- Gemini API's previously observed `FAILED_PRECONDITION` regional rejection is unrelated to Karakeep's code merge and cannot be resolved by passing a TLS/DNS test.
- A web image must not be published/deployed automatically from an unreviewed PR.

**Conclusion:** the integration and corrective patches are material, tested improvements; this report does not certify the installation as production-ready until the release gates above are met.
