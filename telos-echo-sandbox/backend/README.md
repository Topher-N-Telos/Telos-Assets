# telos-echo-api (onboarding image backend, tester build)

Separate Worker from the sandbox. Imports the shared image service from `../src`, so Cloudflare must build from the
`telos-echo-sandbox/` folder as the repo root context (or import with root directory `telos-echo-sandbox/backend`; wrangler bundles `../src`).

Secrets (never in this repo): OPENAI_API_KEY, OWNER_EMAIL, ALLOWED_EMAILS, ACCESS_TEAM_DOMAIN, ACCESS_AUD.
Screening (public-figure / minor / likeness checks) is a stub in `src/safety.mjs` — REQUIRED before strangers use photo upload.
Tests: `npm test` (unit), `npm run e2e` (local workerd + fake OpenAI, no spend).

## Hosted app (App v129)

`public/telos.html` is the TELŌS app (App v129), served from `/` by the Worker behind the same login as the API, so the onboarding image steps can reach `/api/*` on the same origin. `/test` still serves the test harness. Art (95 images) and fonts (Cinzel, Cormorant Garamond, served locally) live in `public/_blob` and `public/_fonts`. All referenced art is present.

## Prebuilt (starter) Telōs — outfit / scene generation

`POST /api/prebuilt/<nova|seraphine|oryn|aeon>/generate` with `{ mode: 'outfit'|'scene', outfit?, scene?, direction?, form?, idempotencyKey }`
(`form` only for Æon: `dragon` default, `human` = Sir Rocco). Returns a job like the onboarding routes; poll `GET /api/jobs/<id>`, read `GET /api/images/<id>`, remove with `DELETE /api/images/<id>`.
Uses the same caps, idempotency, per-user DO isolation and refund-on-failure as onboarding. Free allotment: `FREE_PREBUILT_GENERATIONS` (default 6 per user; owner unlimited; `/api/_admin/user/<email>/allowance` accepts kind `prebuilt`).
Canon: `src/prebuilt-canon.mjs` (locked looks + which reference files per form). Reference images: full-size masters in `refs/`, deployable copies in `public/_refs/` (rebuild with `python3 tools/make-refs.py`).
`public/_refs` is never served to clients; the Worker copies the files into the caller's own Durable Object on first use (once per `PREBUILT_VERSION`; bump it when a reference or look changes).
The server does NOT know relationship level, so the app must only request Æon's `human` form at LV51+ (Master 4.x Reveal Architecture).
