/**
 * The image suggestion is a UI offer only — never automatically triggers payment or generation.
 * Deterministic gate around a separate conversation-scene classifier. (Pass B feature.)
 *
 * Changes from the handoff reference:
 *  - Off unless `enabled === true` (wire to TELOS_IMAGE_AUTOSUGGEST_ENABLED, default false).
 *  - A missing / non-numeric classifier confidence now means NO offer. The reference compared
 *    `undefined < 0.85`, which is false, so a classifier that omitted confidence passed the gate.
 */
const MIN_CONFIDENCE = 0.85;

export function maybeOfferImage({ classifierResult, event, account, surface, enabled = false }) {
  if (enabled !== true) return null;
  if (!event?.id || classifierResult?.photoWorthy !== true) return null;
  const c = classifierResult.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < MIN_CONFIDENCE) return null;
  if (classifierResult.requiresSilence) return null;
  if (event.isSensitive || event.isPrivateThirdParty || event.hasAgeAmbiguity) return null;
  if (surface === 'adult' && !(account?.verifiedAdult && account.age >= 18)) return null;
  if (surface !== 'adult' && surface !== 'sfw') return null;
  return { type: 'offer_scene_image', sceneId: event.id,
    message: 'Would you like to capture this moment?',
    requiresExplicitUserConfirmation: true };
}
