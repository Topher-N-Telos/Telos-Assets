# Telōs Echō image generation — Pass A status (15 Nov 2026)

**Bottom line:** the backend half of Pass A is built and tested offline. It is NOT integrated into the app,
because the v128 build has no server, no scene model, no Sköl wallet and no adult gate for it to plug into.
Nothing here has called OpenAI, and nothing is deployed.

## Built and verified (offline: 42 tests pass; 6 deliberately reintroduced bugs were each caught)
- `src/openai-image-api.mjs` — generations (no refs) / edits (with refs). SFW always `auto`; `low` only for the
  adult surface AND only if the flag is on. Errors are coded and marked retryable (429/5xx).
- `src/scene-image-service.mjs` — worker flow: claim job -> scene/canon at event time -> age checks -> safeguards
  -> verified quote -> reserve -> render with canon references -> review -> private save -> commit.
- `src/routes.mjs` — the six /api/scene-images routes as framework-agnostic handlers.
- `src/prompt-builder.mjs`, `src/suggestion-gate.mjs` (Pass B, off), `src/browser-image-client.mjs`.

## Defects found in the handoff reference code and fixed
1. Adapter ignored the adult-low-moderation flag (adult was always `low`).
2. No atomic job claim: two workers could both render and both charge.
3. A committed charge could be released if a later step failed.
4. Early failures left jobs stuck in "created"; raw error text was stored on the job.
5. Age checks failed open when canon fields were missing (now every character must be `canonAgeClass:'adult'`).
6. Quote was not bound to user and scene.
7. Suggestion gate passed when classifier confidence was missing.
8. Browser client made a new idempotency key per click (double-charge on retry); now one key per quote.
9. `safety_identifier` sent by default though not confirmed for Images; now off by default.

## Why it is not wired into the app (v128 findings, checked in the file)
- Runs inside Claude's artifact runtime: storage is `window.claude.use("db")` with a browser-localStorage
  fallback; no server of its own, so nowhere to hold an API key, a job queue or private image storage.
- No scene model (`sceneId` absent). Chat history, memory and appearance live in client storage, so a server
  cannot read a "trusted stored scene" or canon snapshots.
- No Sköl wallet/ledger (Sköl appears only as venue price text), so no quotes, holds or refunds.
- No adult-verification gate or adult web surface; no Echō image feed.
- Calls to `/api/...` from the artifact would not reach any server.
The bundle was NOT modified. A button that cannot work would only add regression risk.

## Needed from the owner before Pass A can finish
1. Where the backend lives (the Oct 10 Cloudflare account is the likely home: Worker + R2 + D1/Queue).
2. How scenes, canon snapshots and reference images reach the server (sync from the app, or move storage server-side).
3. The real Sköl price and wallet source of truth; the milestone entitlement rule.
4. An age-verification provider for the adult web surface (decision, plus provider account).
5. `OPENAI_API_KEY` as a platform secret on the dedicated Telōs project, plus a spend cap.

## OpenAI checks (live docs/search, 15 Nov 2026)
- Confirmed: `gpt-image-2.6-sunburst` and `-flare` exist (released 4 Nov 2026); `moderation` is `low`|`auto`;
  edits take several reference images; 2.6 has no fidelity setting.
- Not confirmed: `safety_identifier` on Images; whether 2.6's `complexity` default affects cost/latency (unset here).
- `low` is less restrictive filtering, not unrestricted output; blocks can still happen after rendering.
  Failed jobs are never retried with reworded prompts.
