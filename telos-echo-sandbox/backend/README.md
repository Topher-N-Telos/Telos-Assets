# telos-echo-api (onboarding image backend, tester build)

Separate Worker from the sandbox. Imports the shared image service from `../src`, so Cloudflare must build from the
`telos-echo-sandbox/` folder as the repo root context (or import with root directory `telos-echo-sandbox/backend`; wrangler bundles `../src`).

Secrets (never in this repo): OPENAI_API_KEY, OWNER_EMAIL, ALLOWED_EMAILS, ACCESS_TEAM_DOMAIN, ACCESS_AUD.
Screening (public-figure / minor / likeness checks) is a stub in `src/safety.mjs` — REQUIRED before strangers use photo upload.
Tests: `npm test` (unit), `npm run e2e` (local workerd + fake OpenAI, no spend).
