# Telōs — Garment/Anatomical Fidelity Evaluation (non-explicit)

This is a **clothed anatomical realism** study, not an attempt to generate exposed sexual anatomy. Use adult-presenting fictional characters and opaque coverings. Do not evaluate or target sexual arousal.

## Baseline supplied by creator

Existing examples indicate stable anatomical fidelity under structured compression shorts and fitted briefs, but frequent unnatural front flattening for bikini cuts and unstructured loose drapes. This is a user-observed pattern, **not yet experimentally verified across API settings**.

## Controls
- Same character locked portrait + full-body reference; same scene/pose/framing/lighting; same model and image dimensions; no identity substitution.
- Same verified account, trusted server surface and same scene history.
- Use `gpt-image-2.6-sunburst` for high-detail comparisons and keep quality/size fixed.
- Change ONE factor per pair: garment construction prompt, garment type, or permitted moderation setting.
- Three attempts for each condition; seed control if supported by tested API (do not invent a `seed` parameter).
- Never treat approval of one attractive sample as evidence of reliable character continuity.

## Conditions
| ID | Garment | Neutral baseline | Garment physics description |
|---|---|---|---|
| A | Black compression shorts | Existing standard description | Natural compression tension and stable sewn front |
| B | Black square-cut briefs | Existing standard description | Realistic opaque pouch geometry and seams |
| C | Classic opaque swim briefs | Existing standard description | Body-conforming opaque cut, natural drape |
| D | Black bikini-style briefs | Existing standard description | Contoured sewn pouch, opaque fabric, no anatomical exaggeration |
| E | Loose lightweight silk wrap | Existing standard description | Realistic hanging weight, gravity, folds and underlying body mass |
| F | Silk wrap over fitted underlayer | Same loose wrap | Structurally supported, opaque underlayer + correct exterior drape |

Apply only to policy-permitted requests; do not try to trick the provider into unrestricted output.

## Score image independently 1–5
1. **Identity consistency:** eyes, face, skin tone, height, facial hair, body hair, and physique preserved.
2. **Male clothed anatomical plausibility:** no anatomically neutralized front beneath opaque snug garments; no exaggerated contours.
3. **Fabric physics:** believable seams, weight, tension, folds, coverage.
4. **Costume accuracy:** shape matches requested cut and stays opaque.
5. **Scene continuity:** world, setting, chronology, relationship and number of subjects remain correct.

Also log rejection/sanitization category, surface, moderation setting, latency, actual billable tokens/cost, whether reference edit vs text generate, and whether image appears age-ambiguous.

## Decision criteria
- If both moderation modes look identical and structured garment descriptions work, treat it primarily as a garment/pose prompt issue.
- If `low` improves fidelity only for eligible web jobs, document that difference **without** treating it as proof of policy enforcement mechanism.
- If an image smooths anatomy even with opaque briefs, mark test failed rather than promoting the result into canon.
- If no condition consistently meets user-approved fidelity, mark garment category “experimental” and do not require users to spend currency on it.

## Data sheet CSV fields
`date,model,surface,moderation,character_id,canon_snapshot,garment,condition,reference_count,attempt,identity_score,anatomy_score,fabric_score,costume_score,scene_score,result,rejection_category,cost_sköl,provider_cost_usd,notes`
