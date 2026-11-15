# File map and what is/is not implemented

- `CLAUDE_START_HERE.md`: authoritative handoff and acceptance checklist.
- `src/openai-image-api.mjs`: tested backend adapter for `/v1/images/generations` and `/v1/images/edits`; standard vs low moderation. Requires real server key; no API calls made by tests.
- `src/prompt-builder.mjs`: scene prompt composer with historical/locked appearance fields.
- `src/scene-image-service.mjs`: backend worker contract, hardened with guardrails and adapters that MUST be connected to the real Telōs application; NOT drop-in production code.
- `src/suggestion-gate.mjs`: suggestion-to-offer gate; never triggers the provider, unlock, or purchase on its own.
- `src/browser-image-client.mjs`: browser-side API client to port into Telōs UI, no secrets.
- `test/core.test.mjs`: offline node tests using mocked OpenAI; no charge or live generation.
- `GARMENT_EVAL_PROTOCOL.md`: evaluation protocol and image scorecard for supplied user examples.
- `ENV_EXAMPLE.txt`: sample backend configuration. `low` adult mode is disabled by default until compliant gating is confirmed.

## Not implemented (the existing app's source and infrastructure are required)

- Real authentication and verified adult age-checking; do not allow a client-controlled `surface` field to choose policy.
- Database schema/migrations, private object storage, access controls, upload/encoding, immutable canon snapshots, optional human/celebrity-likeness screening.
- Reliable queue/worker, idempotent jobs, transactional ledger and refunds, real scene context, moderator/QA, safe private Echō integration.
- Real working endpoint handlers, UI components, production deployment, secure CSRF checks, API key provisioning, provider billing.

The backend service code intentionally refuses to run when adapters are absent; Claude must wire those adapters to the actual app. It must not replace them with dummy age or billing values.
