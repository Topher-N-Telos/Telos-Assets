# Telōs Echō Sandbox — status (2026-11-15)

NOT DEPLOYED. No Cloudflare or OpenAI credentials exist in the build session; deploy with DEPLOY.md.

## Tested (automatically, local workerd, mock OpenAI — no real key, no spend)
- 46 shared-module tests, 19 sandbox unit tests (limits, cost, Access JWT, validation), 13 end-to-end tests against the real Worker + Durable Object.
- E2E covers: fail-closed auth; CSP/headers/CSRF; reference upload (magic-byte check, 2.5 MB chunk round-trip); edits vs generations endpoint; moderation `auto` default and `low` only by explicit adult-surface choice (mutation-checked); wallet hold/commit/release; usage/cost tracking; idempotent replay; duplicate, too-soon, daily-cap and pause guards; provider failure releases the hold; secret never appears in any API response; scoring, repeat-consistency report, formula-safe CSV; delete and purge.
- UI rendered at 390x844 in Chrome with no script errors.

## Not verified (needs your real run)
- Real OpenAI behaviour: model availability/org verification, true token rates (input rates are configurable guesses; image output $30/1M is from the model page), `safety_identifier` (left off), image quality/fidelity itself.
- Real Cloudflare Access JWT flow (verifier is unit-tested with generated RSA keys, not against your team's live JWKS).
- Workers Free plan CPU limits on large image handling; if jobs fail with CPU errors, Workers Paid ($5/mo) fixes it.
- Zero Trust setup menus may differ from DEPLOY.md.

## Safety limits of the build
- Age checks: owner attestation + required apparent age + minor-term text filter, all fail-closed. These are heuristics, not verification.
- There is NO automated review of generated images for age appearance or likeness. You review every image.
- Spend figures are estimates; the OpenAI dashboard and your $10 hard limit are the source of truth.
