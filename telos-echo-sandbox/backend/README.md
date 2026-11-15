# telos-echo-api (onboarding image backend, tester build)

Separate Worker from the sandbox. Imports the shared image service from `../src`, so Cloudflare must build from the
`telos-echo-sandbox/` folder as the repo root context (or import with root directory `telos-echo-sandbox/backend`; wrangler bundles `../src`).

Secrets (never in this repo): OPENAI_API_KEY, OWNER_EMAIL, ALLOWED_EMAILS, ACCESS_TEAM_DOMAIN, ACCESS_AUD.
Screening (public-figure / minor / likeness checks) is a stub in `src/safety.mjs` — REQUIRED before strangers use photo upload.
Tests: `npm test` (unit), `npm run e2e` (local workerd + fake OpenAI, no spend).

## Hosted app (App v129)

`public/telos.html` is the TELŌS app (App v129), served from `/` by the Worker behind the same login as the API, so the onboarding image steps can reach `/api/*` on the same origin. `/test` still serves the test harness. Known gap: the app's art and fonts were `/_blob/<hash>` assets on the Claude page's own origin and are not yet in `public/`; until they are added the hosted copy shows no world art. In-app AI chat also does not work here until a Claude relay is added to the Worker.
