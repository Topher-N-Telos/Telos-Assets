/**
 * TEST DOUBLES ONLY. These in-memory fakes exist so the offline tests can exercise the service and
 * route logic. They are NOT production adapters and must never be shipped as auth, billing,
 * age-verification or storage. Production needs the real Telōs backend equivalents.
 */
export const adultCanon = (over = {}) => ({
  id: 'telo-a', displayName: 'Example Telō', canonVersion: 'locked-v1',
  adultEligible: true, canonAgeClass: 'adult',
  appearance: { locked: { hair: 'gray curls', skinTone: 'warm brown', bodyHair: 'natural dense', eyes: 'dark' },
    atSceneTime: { currentOutfit: 'opaque black briefs' } },
  ...over
});
export const sampleScene = (over = {}) => ({ id: 'scene-001', description: 'A private conversation by the sea',
  worldId: 'solis', locationId: 'coast', participantIds: ['telo-a'], occurredAt: '2026-11-12T20:00:00Z', ...over });
export const sampleWorld = { id: 'solis', visualCanon: 'Amber coastal architecture.' };

/** A jobs store with the same compare-and-set semantics the real DB must provide. */
export function memoryJobs() {
  const byKey = new Map(); const byId = new Map(); let n = 0;
  return {
    byId,
    async findOrCreate(userId, key, extra = {}) {
      const k = `${userId}|${key}`;
      if (!byKey.has(k)) { const j = { id: `job-${++n}-xxxxxxxx`, userId, key, state: 'created', ...extra }; byKey.set(k, j); byId.set(j.id, j); }
      return byKey.get(k);
    },
    async claim(id) { const j = byId.get(id); if (j.state !== 'created') return false; j.state = 'working'; return true; },
    async complete(id, result) { Object.assign(byId.get(id), { state: 'complete', result }); },
    async fail(id, code) { Object.assign(byId.get(id), { state: 'failed', failureCode: code }); },
    async get(id) { return byId.get(id) ?? null; }
  };
}

export function baseAdapters(over = {}) {
  const calls = { reserve: 0, commit: 0, release: 0, provider: 0, saved: [] };
  const a = {
    calls,
    scenes: { getAuthorizedScene: async (uid, sid) => (sid === 'scene-001' ? sampleScene() : null) },
    canon: { getCharacterSnapshots: async () => [adultCanon()], getWorldSnapshot: async () => sampleWorld },
    media: {
      loadCanonReferences: async () => [{ bytes: Buffer.from('ref'), mime: 'image/png' }],
      savePrivateImage: async (rec) => { calls.saved.push(rec); return { id: 'img-12345678' }; }
    },
    wallet: {
      verifyAcceptedQuote: async ({ principal, scene }) => ({ amount: 20, currency: 'skol', userConfirmed: true, userId: principal.userId, sceneId: scene.id }),
      reserve: async () => { calls.reserve++; return { id: 'hold-1' }; },
      commit: async () => { calls.commit++; },
      release: async () => { calls.release++; }
    },
    jobs: memoryJobs(),
    safeguards: { beforeGeneration: async () => {}, afterGeneration: async () => ({ approved: true }) },
    openaiImage: async () => { calls.provider++; return { bytes: Buffer.from('PNG'), mime: 'image/png', model: 'gpt-image-2.6-sunburst', moderation: 'auto' }; },
    ...over
  };
  return a;
}

export const principal = { userId: 'user-1', verifiedAdult: false, age: 29 };
export const req = (over = {}) => ({ sceneId: 'scene-001', idempotencyKey: 'valid-123456', purpose: 'manual', quoteId: 'quote-1', ...over });
