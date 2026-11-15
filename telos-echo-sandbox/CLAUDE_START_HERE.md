# TELŌS — ECHŌ IN-APP IMAGE GENERATION
## Claude porting handoff | 15 November 2026 | Architecture and reference implementation

> **Instruction to Claude:** PORT this into the latest existing Telōs app. Do not rebuild Telōs, redefine its economy or canon, replace the memory system, or create an unrelated standalone app. First inspect the current real source and data layer. The reviewed library snapshot is `telos_v128.html` (~3.6 MB) and `TELOS_Master_v203.docx`; treat any newer files provided by the owner as authoritative after comparing them. The code in `src/` is a tested reference adapter / contract, not a claim that the integration is already deployed.

## 0. Outcome requested

Deliver a secure, persistent, first-party OpenAI image-generation system in Telōs with:
1. **User-initiated scene capture** from conversation, and user-initiated image creation from the Telōsian's profile/gallery. No image generated merely because a scene seems noteworthy.
2. **Photo-worthy scene suggestions** that invite a user to capture the moment; the user must explicitly accept, view price if applicable, and confirm before a charge or generation. Feature-flag suggestions at first.
3. **Canonical character fidelity** by attaching real locked individual reference images, per-character Living Appearance State, scene-time snapshots, precise world/venue assets, and relationship canon. Multiple characters are never averaged or merged.
4. **Two enforcement levels** within a *single backend image system*: SFW mobile/app has `moderation:'auto'`; verified adult web/PWA may set `moderation:'low'` if enabled. This affects filtering, not OpenAI's broader policy; never claim full NSFW/explicit generation support.
5. **Gallery / Echō / archive persistence**: privately stored generated media, linked to scene, characters, world, time, provenance, costs, review. No character-canon mutation without owner approval. Adult media NEVER goes to public Echō / external share/export.
6. **Clothed anatomical-realism tests**: specifically avoid artificial flattening of opaque male briefs/bikinis and distinguish realism from exaggerated or explicit genital depiction.
7. **Security**: OpenAI secrets only server side; validated identity, authorized assets, robust age gate, locked canon, rate limits, audited economy, moderation and post-generation review, stable job processing.

## 1. Source-specific findings: do not destroy existing functionality

### Telōs Master v203 — relevant canon
- §1.5: native mobile SFW is complete/standalone, with NO adult controls, toggle, promotion or hints; web/PWA may host adult experience. One account, shared canon and memories.
- §9.2A: age verification on web is triggered by explicit intent to open adult features. Adult controls must be completely absent for nonverified accounts, not merely greyed out. Age enforcement must also occur server-side on EVERY adult media request. The document's older language about a gate on arrival should be reconciled against this later intent-gated rule; do not silently broaden access.
- §9.10: adult Echō is PRIVATE to the account; no other real user appears or can be contacted, no external sharing of adult outputs. Invisible provenance watermark requirement exists elsewhere; no visible branding watermarks in adult feed.
- §5.12: media milestone unlocks are always free. Extra scene-generation actions beyond level-granted media cost Sköl. Do not invent a price; read the current economy config. Priority rendering may involve Gems per §30.6, separately.
- §7.8: Permanent and Mutable Living Appearance State must inform all image/prose, with explicit null states. Historical events use the appearance state *at event time*, not today.
- §14B: appearance diversity, skin tone, body type, body hair and authentic anatomical traits preserved; output likeness/deepfake screening and invisible provenance watermark are specified. Do not fake compliance with thresholds or silently skip missing moderation infrastructure; surface missing requirements explicitly.
- §14.8: no minor-presenting character imagery. Do not infer adult status from stated age alone when the subject looks age-ambiguous.
- §19C: Scribe is **future work**, not image-generation MVP. Leave Scribe unmodified; images should include provenance and canon references usable later by Scribe.

### Saved `telos_v128.html` — real code touchpoints
- It is a compiled/bundled React-like single HTML export (not an identified server repo). Find the uncompiled source in Claude's working copy if available; **do not edit the minified/compiled artifact as the primary architecture** unless no upstream is accessible and changes can be round-tripped.
- `TeloImageGallery({ teloName, defaultImage, worldColor })` exists and provides upload/remove/select of image backgrounds.
- `galleryIndexKey`, `galleryImgKey`, `loadGallery`, `saveGallery`, `loadGalleryImage`, and `useActiveTeloImage` exist. Current key pattern is `telos-v1-gallery-${name.toLowerCase()}`. This is name-based; avoid collisions in the new generated-media system by using stable Telōsian IDs. Preserve existing galleries and migrate non-destructively only after testing.
- `storageGet`, `storageSet`, `storageDelete`, `docForKey`, `getDbCap`, `getUid` indicate a browser storage abstraction with local fallback/Firestore-like capabilities. This is **not** equivalent to durable private object storage for high-resolution generated files. Keep gallery thumbnails and metadata in existing UI data as appropriate; store full images securely on the backend.
- `TeloListAvatar` and `TelosianProfileScreen` call the current active image hook. Generated scene photos must NOT automatically overwrite the chosen chat background or canonical face. Provide an explicit “Set as background” operation if desired.
- `callClaudeViaFetch` handles text generation, unrelated to OpenAI image generation. Don't route image requests through it. Never expose `OPENAI_API_KEY` in HTML, local storage, build output, or client JavaScript.
- No existing OpenAI image client or backend image job/storage service was found in the reviewed HTML snapshot. There may be newer working code not visible to this handoff; inspect before porting.

## 2. Build in two deliverable passes

**Pass A / functional minimum:** backend OpenAI adapter and secure image-job endpoint; app manual “Capture this scene” control; quote+confirmation; canon references; private save/gallery; SFW `auto`; verified-adult `low` behind feature flag; account permission checks; basic audit/failure handling; offline and real test paths.

**Pass B / after Pass A is verified:** contextual “photo-worthy moment” suggestion service; richer scene prompts/locations; optional high-fidelity repair/edit flow; automatic character QA; premium priority rendering; historical photo-memory integration; collage/multi-scene planner. Nothing in Pass B may silently generate or spend.

## 3. Image API adapter (provided, offline-tested)

`src/openai-image-api.mjs` supports `POST /v1/images/generations` (no images) and `POST /v1/images/edits` (canonical references); Node 20+, no SDK required. Default model `gpt-image-2.6-sunburst`, `quality:'high'`, `size:'1024x1536'`, `output_format:'png'`, `n:1`.

- Set `moderation:'auto'` for SFW.
- Set `moderation:'low'` ONLY for adult verified web/PWA if `TELOS_IMAGE_ADULT_LOW_MODERATION_ENABLED` and organization/platform policies allow. A user's supplied `surface` flag must NEVER be trusted. Determine surface from server-validated host and authenticated account route.
- Sunburst for high-fidelity canonical work; `gpt-image-2.6-flare` may be tested as a cheaper/faster preview, but performance/cost must be measured, not assumed.
- Use **actual image references** for recurring characters. Call image *edits* with source images instead of text-only generation whenever references exist.
- 2.6 reference support should not be passed `input_fidelity:'high'` blindly; the API docs identify that setting as model-specific. Preserve with references, prompt, edit strategy, and output QA instead.
- Return `Buffer` from backend; never store base64 blobs in browser localStorage. The API key must remain a server secret.
- The provider may refuse or alter content regardless of moderation setting. Do not automatically retry with policy-evasion prompts.

Official documentation:
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/reference/resources/images/methods/edit
- https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst

## 4. API contract to implement in the Telōs backend

All routes are on the first-party Telōs server, with cookie/session authentication, CSRF protection for mutations, rate limits, and ownership checks. Adult domains/routes require additional server-authenticated adult verification.

| Route | Request or action | Successful response |
|---|---|---|
| `POST /api/scene-images/quote` | `{sceneId,purpose,priority}` | `{quoteId,amount,currency,free,expiresAt}`; quote is bound to user+scene+purpose and signed/stored |
| `POST /api/scene-images/jobs` | `{sceneId,quoteId,idempotencyKey,purpose,priority,artDirection}` | `{jobId,state:'queued'}`; NO raw arbitrary reference image URLs |
| `GET /api/scene-images/jobs/:jobId` | session | `{jobId,state:'queued'|'working'|'complete'|'failed',imageId?,message?}`; fail messages sanitized |
| `GET /api/scene-images/gallery?characterId=...` | session | owner-visible image metadata and thumbnail access method |
| `GET /api/scene-images/:imageId` | session | server-authorized image stream or short-lived, owner-bound signed URL |
| `POST /api/scene-images/:imageId/set-background` | explicit action | changes chat background only, never the character's locked baseline |

Do not run a slow provider call synchronously in a user-facing HTTP request unless platform infrastructure explicitly supports it. Queue a job transactionally, return immediately, process with worker and backoff, and poll/subscribe. Enforce unique `(userId,idempotencyKey)` and `jobId` so UI retries never charge twice.

## 5. Server-side dependencies Claude must connect (no fake defaults)

`src/scene-image-service.mjs` is an orchestration skeleton with mandatory adapters. Implement them against the actual backend:

- `scenes.getAuthorizedScene(userId, sceneId)` — retrieve **trusted stored** conversation scene and participant IDs, world, location, event timestamp; not merely a client-submitted transcript.
- `canon.getCharacterSnapshots(userId, participants, occurredAt)` — locked visual canon + mutable appearance **at event time**, individual reference asset IDs, relationship facts, age eligibility; restore explicit null values; enforce access to adopted/owned characters.
- `canon.getWorldSnapshot(worldId, occurredAt)` — geography, architecture, region, map/venue refs; preserve coordinates and spatial identity.
- `media.loadCanonReferences`, `media.savePrivateImage` — private immutable baseline refs; signed retrieval; image hash/provenance, original full-res plus thumbnail, user-isolated storage, no adult public CDN.
- `jobs.findOrCreate`, `setState`, `complete`, `fail` — atomic queue, unique idempotency, immutable audit, repairable failed jobs.
- `wallet.verifyAcceptedQuote`, `reserve`, `commit`, `release` — **verified accepted** quote; correct price/currency; milestone zero cost; refund on failures; idempotent transaction. Do not trust `amount` from browser.
- `safeguards.beforeGeneration` / `.afterGeneration` — content policy, age, consent, privacy, likeness screening, image quality and canonical character comparison. For moderation false positives, provide safe error handling, not silent passing.

Store every image record with: imageId, ownerId, server-derived surface, privacy, sceneId, occurredAt, character IDs, canon snapshot/version/hash, world/region/venue, asset storage IDs, provider model, moderation mode, status, creation time, requestId, ledger reference, invisible provenance ID, `canonApproved:false` default. Never auto-write generated image assertions to long-term memory/canon.

**Safety/permitted-content boundary:** age-gating does not override OpenAI's policies. `low` is less restrictive moderation, not a switch to unrestricted explicit sexual imagery. If the provider rejects content, show a respectful, accurate message and do not charge for failed results.

## 6. UI integration

- Add a subtle **Capture Scene** action to a current conversation, using an existing stored `sceneId` rather than text-parsing a whole chat client-side.
- After user taps: show image preview format and quote in Sköl (or free milestone) and a confirmation action; only then `POST /jobs`.
- Processing state + cancel/back navigation without losing job; completed result appears as **New Photo** with Review, Save, Retake (new quote), and optional Set as Background.
- Append to the existing Telōsian profile Gallery/Photos area, ideally a new **Scene Memories** tab rather than replacing manually-uploaded profile portraits.
- Adult images are shown in private adult surface only, cannot be routed to SFW public Echō, external share flows, searchable CDN, other users, or broad social feeds.
- SFW still works completely without adult account entitlements. Adult options must not be present at all in mobile UI or nonverified web UI.
- Feature-flag `photoWorthy` suggestions; no automatic charging, generation, or canonical change from a classifier suggestion. A gentle prompt can be dismissed and should not repeat compulsively.

## 7. Fit/identity fidelity

For each generated scene, provide canonical images in a stable subject order (individual close head-and-shoulders, full body, optional garment-specific reference, then world/location). Keep roles distinct by asset identity. Use editing where possible, not text-only synthetic reconstruction. Natural body-hair distribution and clothed anatomical contours are part of visual fidelity; do not specify anatomy exaggeration or attempt explicit-content workarounds.

Run the controlled tests in `GARMENT_EVAL_PROTOCOL.md`: compression shorts and fitted briefs generally hold in the user's baseline, whereas bikinis and loose garments frequently flatten the clothed pelvic region. Test same subject and same garment in standard vs garment-construction prompting and `auto` vs `low` only on authorized environments; keep outputs private.

## 8. Security, privacy and operational acceptance

- API key is server-side only. If the existing snapshot deploys a client directly calling third-party APIs, do not copy that pattern for OpenAI keys.
- Validate the host, domain, session, role, and age proof on every route. Client request never picks moderation mode. Minors, age-ambiguous personas, and minor-presenting subjects are blocked in visual generation in accordance with Master v203.
- No cross-user media access via changing `imageId` or `sceneId`. Adult media cannot be returned through an SFW route, even to the owner.
- Each user image and private reference has a secure ownership scope, encrypted private storage and an appropriate retention/delete policy.
- No model output or system-generated claims can silently update locked character canon or relational history. Consent and user approval required for any canonical adoption.
- Only create a billable reservation after quote confirmation; release on failed provider call or failed QA; never bill twice due to retry.
- Record provider error category and request IDs in private logs, not raw personal text/secret keys or public UI.
- Establish provider rate/cost caps and per-user quotas, with a kill switch for image generation and separate `low` moderation flag.
- QA must cover SFW vs adult route isolation, image leakage, gallery migration, old versus current appearance state, cost consistency, provider 429/timeout/blocked outputs, individual face/body/skin/eye and height stability, and no accidental character replacement.

## 9. Explicit acceptance checklist for Claude

- [ ] The integration is in the **existing** Telōs build; old galleries/conversations still load.
- [ ] Manual scene capture works end-to-end for at least one authorized test user with actual OpenAI API (after configured key and project access).
- [ ] Calls made with one or more canonical reference images reach `/images/edits`; zero-reference calls reach `/images/generations`.
- [ ] SFW uses `auto`; verified adult web/PWA uses `low` ONLY if enabled; unverified and native mobile cannot select it.
- [ ] Same character remains recognizably the same in at least five controlled renders; drift is scored, not wished away.
- [ ] The real user sees the exact price/currency or a genuinely free milestone before confirmation; no charge if generation fails.
- [ ] Private scene image appears in owner-scoped gallery with provenance and no automatic portrait/canon overwrite.
- [ ] Adult image is not visible through SFW routes, public Echō, social share, or another account.
- [ ] No automatically generated images on `photoWorthy` triggers; explicit opt-in works.
- [ ] Tests pass; list remaining blockers separately (e.g. third-party age verification, celebrity-likeness service, actual backend deployment). Never label placeholders as completed.

## 10. Exact request to Claude

> Work within the latest real Telōs app source. First locate current chat lifecycle, authenticated account/session implementation, image gallery, canonical character and world models, memory/history snapshots, pricing ledger, and adult web gate. Compare against `TELOS_Master_v203.docx` (or a newer canonical master if available). Integrate the provided backend OpenAI image adapter and scene-image service contract into the current code architecture. Implement Pass A first, without changing existing chat/character canon or breaking current galleries. Use durable queue+private storage, validated quotes, real adult gate, and server-derived moderation. Then add the manual Capture Scene UI, real API routes, and QA tests. Gate the auto-suggestion feature for Pass B. Report exactly which files changed, what ran, what passed, what is still mocked, and what credentials/infrastructure I need to supply. Do not claim deployment until actual deployment and end-to-end tests have succeeded.
