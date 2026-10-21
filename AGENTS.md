# Contribution rules

Read `docs/contract.md` before changing client/server interfaces. Keep both ends compatible and preserve native Harness event semantics.

- Never commit credentials, private keys, user profiles, business files, databases, logs, generated runtimes or installers. `.env.example` contains placeholders only.
- Keep upstream pinned by `upstream.lock.json`; use replayable patches or enterprise plugins rather than editing upstream source.
- Preserve employee/admin isolation, server-side authorization, per-tool approval and company model routing. UI visibility is not an authorization boundary.
- Tests use mock models and synthetic accounts by default. Do not run paid model calls, live desktop actions or SolidWorks automation without an explicit test request and an isolated environment.
- Do not replace a running runtime. Build candidates separately; preserve drafts, tasks and unsaved models.
- Do not remove features to reduce package size. Retain all locks, dependency licenses and packaging gates.
- Distinguish source compilation, simulated validation and real Windows acceptance. Never call skipped hardware tests passed.
- Keep public service configuration consistent across client constants, runtime configuration and update feeds. Private release signing keys stay outside the repository.
