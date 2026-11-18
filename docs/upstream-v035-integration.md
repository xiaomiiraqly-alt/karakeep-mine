# Upstream v0.35.0 integration

Upstream tag: `karakeep-app/karakeep:v0.35.0` (`ac46f47b9d4a3c8f3c43f93a7f5da7009b297d69`).

The preliminary conflict-biased merge was **not** suitable for deployment. The final integration requires reviewed source repairs and passing CI, not merely Git ancestry.

## Reviewed intersections

- Restored offline-copy-only crawler jobs before Instagram handling: those jobs must not re-import media or enqueue inference.
- Retained the custom Instagram post/carousel/Reel importer, visual context, reader assets, title generation and cancellation/transaction cleanup.
- Combined upstream note/PDF/image-text summarization with Instagram visual observations and optional title generation.
- Kept distinct `summarized`, `skipped` and incomplete-tagging outcomes; skipped work must not become false success.
- Restored upstream OpenAI refusal/token-limit diagnostics and legitimate empty OCR responses, while still rejecting blank text or structured tagging responses.
- Updated local worker imports and mocks after upstream removed `baseUrl` aliases.
- Preserved the fork's tag vocabulary, semantic reuse and minimum-five-grounded-concepts policy.
- Preserved upstream Docker security hardening and the custom gallery-dl installation.

## Remote sandbox boundary

The custom Instagram media importer currently runs locally. When `SANDBOX_REMOTE_URL` is configured it deliberately refuses the Instagram import rather than silently bypassing the sandbox. General upstream remote crawling remains available. Do not enable the experimental remote sandbox for an installation that requires this importer until the custom downloader is ported to the sandbox protocol. The normal local deployment is unaffected.

## Release boundary

CI includes upstream tests and the fork's regression tests. A successful TLS check or a mocked API test is not proof that the production Gemini API is accessible. Regional API rejection and VPN/DNS configuration are separate deployment concerns.

The fork's image publisher requires successful CI for the exact current `main` commit. It publishes only to the fork's own image namespace and does not contact or deploy to a production server.

## Deployment checklist

1. Record the running image digest and save all active Compose files and `.env` privately. Never commit credentials or VPN profiles.
2. Make a consistent backup of the database and assets, and preserve search data/configuration. Stop application writers or use a SQLite-aware backup method.
3. Test the new pinned image against an isolated copy of the data. Verify login, search, link/text/image processing and Instagram import.
4. Retain the existing AWG shared network namespace, loopback-published port and all Compose overrides.
5. Deploy the tested immutable image digest only after successful checks. A database migration may require restoring the pre-upgrade database and assets as well as the old image when rolling back.

No VPS networking changes are part of this integration.
