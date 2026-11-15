import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneImageService, publicFailureCode } from '../src/scene-image-service.mjs';
import { adultCanon, baseAdapters, principal, req } from '../test-support/doubles.mjs';

const adultPrincipal = { userId: 'user-1', verifiedAdult: true, age: 30 };
const run = (a, over = {}) => createSceneImageService(a)({ principal, trustedSurface: 'sfw', request: req(), ...over });

test('happy path: reference edit -> private save -> commit exactly once; record carries provenance', async () => {
  const a = baseAdapters();
  const out = await run(a);
  assert.equal(out.state, 'complete');
  assert.equal(out.visibility, 'private');
  assert.equal(out.canonApproved, false);
  assert.deepEqual([a.calls.reserve, a.calls.commit, a.calls.release, a.calls.provider], [1, 1, 0, 1]);
  const rec = a.calls.saved[0];
  assert.equal(rec.externallyShareable, false);
  assert.equal(rec.canonApproved, false);
  assert.equal(rec.surface, 'sfw');
  assert.equal(rec.providerModel, 'gpt-image-2.6-sunburst');
  assert.equal(rec.moderation, 'auto');
  assert.equal(rec.ledgerRef, 'hold-1');
  assert.deepEqual(rec.canonVersions, [{ id: 'telo-a', version: 'locked-v1' }]);
  assert.match(rec.canonHash, /^[0-9a-f]{64}$/);
});

test('idempotent: repeating the same key returns the finished result and does not render or charge again', async () => {
  const a = baseAdapters();
  const first = await run(a);
  const second = await run(a);
  assert.deepEqual(second, first);
  assert.deepEqual([a.calls.reserve, a.calls.commit, a.calls.provider], [1, 1, 1]);
});

test('concurrent workers: only one wins the atomic claim, so one render and one charge', async () => {
  const a = baseAdapters();
  const svc = createSceneImageService(a);
  const args = { principal, trustedSurface: 'sfw', request: req() };
  const results = await Promise.all([svc(args), svc(args)]);
  assert.equal(a.calls.provider, 1);
  assert.equal(a.calls.reserve, 1);
  assert.equal(results.filter((r) => r.state === 'complete').length, 1);
});

test('provider failure releases the hold, fails the job with a sanitized code, never commits', async () => {
  const a = baseAdapters({ openaiImage: async () => { const e = new Error('IMAGE_PROVIDER_HTTP_429'); e.providerDiagnostic = 'raw prompt echo'; throw e; } });
  const logged = [];
  const svc = createSceneImageService({ ...a, logger: { error: (x) => logged.push(x) } });
  await assert.rejects(svc({ principal, trustedSurface: 'sfw', request: req() }), /IMAGE_PROVIDER_HTTP_429/);
  assert.deepEqual([a.calls.reserve, a.calls.commit, a.calls.release], [1, 0, 1]);
  const job = [...a.jobs.byId.values()][0];
  assert.equal(job.state, 'failed');
  assert.equal(job.failureCode, 'IMAGE_PROVIDER_HTTP_429');
  assert.equal(JSON.stringify(job).includes('raw prompt echo'), false);
  assert.equal(logged[0].diagnostic, 'raw prompt echo'); // private log only
});

test('unexpected internal errors never leak their text into the job record', async () => {
  const a = baseAdapters({ media: { loadCanonReferences: async () => { throw new TypeError("Cannot read properties of undefined (reading 'secretField')"); }, savePrivateImage: async () => ({}) } });
  await assert.rejects(run(a));
  assert.equal([...a.jobs.byId.values()][0].failureCode, 'GENERATION_FAILED');
  assert.equal(publicFailureCode(new Error('weird text with spaces')), 'GENERATION_FAILED');
});

test('early failures (scene missing) fail the job instead of leaving it stuck in "created"', async () => {
  const a = baseAdapters();
  await assert.rejects(run(a, { request: req({ sceneId: 'scene-zzz-unknown' }) }), /SCENE_NOT_FOUND/);
  const job = [...a.jobs.byId.values()][0];
  assert.equal(job.state, 'failed');
  assert.equal(job.failureCode, 'SCENE_NOT_FOUND');
  assert.equal(a.calls.reserve, 0);
});

test('failure AFTER commit does not release the committed hold', async () => {
  const a = baseAdapters();
  a.jobs.complete = async () => { throw new Error('DB_DOWN'); };
  await assert.rejects(run(a), /DB_DOWN/);
  assert.deepEqual([a.calls.commit, a.calls.release], [1, 0]);
});

test('failed safeguards (output review) -> no save, no charge', async () => {
  const a = baseAdapters({ safeguards: { beforeGeneration: async () => {}, afterGeneration: async () => ({ approved: false }) } });
  await assert.rejects(run(a), /IMAGE_FAILED_SAFEGUARDS_OR_FIDELITY/);
  assert.deepEqual([a.calls.saved.length, a.calls.commit, a.calls.release], [0, 0, 1]);
});

test('safeguards.beforeGeneration rejection stops the provider call', async () => {
  const a = baseAdapters({ safeguards: { beforeGeneration: async () => { throw new Error('POLICY_BLOCKED'); }, afterGeneration: async () => ({ approved: true }) } });
  await assert.rejects(run(a), /POLICY_BLOCKED/);
  assert.equal(a.calls.provider, 0);
  assert.equal(a.calls.reserve, 0);
});

test('age checks fail closed: missing, ambiguous, minor-presenting or minor canon are all blocked', async () => {
  for (const over of [{ canonAgeClass: undefined }, { canonAgeClass: 'minor' }, { ageAmbiguous: true }, { minorPresenting: true }]) {
    const a = baseAdapters({ canon: { getCharacterSnapshots: async () => [adultCanon(over)], getWorldSnapshot: async () => ({ id: 'solis' }) } });
    await assert.rejects(run(a), /MINOR_OR_AMBIGUOUS_CHARACTER_BLOCKED/, JSON.stringify(over));
    assert.equal(a.calls.provider, 0);
  }
});

test('one ineligible character blocks a multi-character adult scene', async () => {
  const a = baseAdapters({ scenes: { getAuthorizedScene: async () => ({ id: 'scene-001', worldId: 'solis', participantIds: ['telo-a', 'telo-b'], occurredAt: 't' }) },
    canon: { getCharacterSnapshots: async () => [adultCanon(), adultCanon({ id: 'telo-b', adultEligible: false })], getWorldSnapshot: async () => ({ id: 'solis' }) } });
  await assert.rejects(run(a, { principal: adultPrincipal, trustedSurface: 'adult' }), /CHARACTER_NOT_ELIGIBLE_FOR_ADULT_SURFACE/);
});

test('surface isolation: a private-adult scene is refused on the SFW surface', async () => {
  const a = baseAdapters({ scenes: { getAuthorizedScene: async () => ({ id: 'scene-001', privateAdult: true, worldId: 'solis', participantIds: ['telo-a'], occurredAt: 't' }) } });
  await assert.rejects(run(a), /SURFACE_ISOLATION/);
  assert.equal(a.calls.provider, 0);
});

test('quote must belong to this user and scene, and a paid quote must be confirmed with a currency', async () => {
  const bad = (q) => baseAdapters({ wallet: { ...baseAdapters().wallet, verifyAcceptedQuote: async () => q } });
  await assert.rejects(run(bad({ amount: 20, currency: 'skol', userConfirmed: true, userId: 'someone-else', sceneId: 'scene-001' })), /QUOTE_MISMATCH/);
  await assert.rejects(run(bad({ amount: 20, currency: 'skol', userConfirmed: true, userId: 'user-1', sceneId: 'other-scene' })), /QUOTE_MISMATCH/);
  await assert.rejects(run(bad({ amount: 20, userConfirmed: true, userId: 'user-1', sceneId: 'scene-001' })), /QUOTE_INVALID/);
  await assert.rejects(run(bad({ amount: -5, currency: 'skol', userConfirmed: true, userId: 'user-1', sceneId: 'scene-001' })), /QUOTE_INVALID/);
  await assert.rejects(run(bad({ amount: 20, currency: 'skol', userConfirmed: false, userId: 'user-1', sceneId: 'scene-001' })), /PRICE_CONFIRMATION_REQUIRED/);
  await assert.rejects(run(bad(null)), /QUOTE_INVALID/);
});

test('a genuinely free milestone quote (amount 0) proceeds', async () => {
  const a = baseAdapters({ wallet: { ...baseAdapters().wallet, verifyAcceptedQuote: async ({ principal: p, scene }) => ({ amount: 0, userId: p.userId, sceneId: scene.id }) } });
  const out = await run(a, { request: req({ purpose: 'milestone' }) });
  assert.equal(out.state, 'complete');
});

test('request validation happens before any job is created', async () => {
  const a = baseAdapters();
  await assert.rejects(run(a, { request: req({ idempotencyKey: 'short' }) }), /INVALID_IMAGE_REQUEST/);
  await assert.rejects(run(a, { request: req({ purpose: 'free-for-all' }) }), /UNKNOWN_IMAGE_PURPOSE/);
  await assert.rejects(run(a, { trustedSurface: 'bogus' }), /UNAUTHORIZED/);
  assert.equal(a.jobs.byId.size, 0);
});

test('missing adapters are detected at construction, not at 3am in production', () => {
  assert.throws(() => createSceneImageService({ ...baseAdapters(), wallet: undefined }), /MISSING_SERVER_ADAPTER_wallet/);
  assert.throws(() => createSceneImageService({ ...baseAdapters(), jobs: { findOrCreate() {} } }), /MISSING_SERVER_ADAPTER_jobs\.claim/);
});

test('reference labels become a manifest in the prompt; usage, quality and size reach provider and record', async () => {
  const seen = {};
  const a = baseAdapters({
    media: {
      loadCanonReferences: async () => [{ bytes: Buffer.from('a'), mime: 'image/png', label: 'SUBJECT 1 face' }, { bytes: Buffer.from('b'), mime: 'image/png', label: 'WORLD reference' }],
      savePrivateImage: async (rec) => { seen.rec = rec; return { id: 'img-12345678' }; }
    },
    openaiImage: async (args) => { seen.args = args; return { bytes: Buffer.from('PNG'), mime: 'image/png', model: 'm', moderation: 'auto', usage: { output_tokens: 7 } }; }
  });
  await run(a, { request: req({ quality: 'medium', size: '1024x1024' }) });
  assert.match(seen.args.prompt, /image 1: SUBJECT 1 face/);
  assert.match(seen.args.prompt, /image 2: WORLD reference/);
  assert.equal(seen.args.quality, 'medium');
  assert.equal(seen.args.size, '1024x1024');
  assert.deepEqual(seen.rec.providerUsage, { output_tokens: 7 });
  assert.equal(seen.rec.referenceCount, 2);
  assert.equal(seen.rec.endpoint, 'edits');
});

test('missing reference assets fail BEFORE any hold is taken; bad quality/size rejected up front', async () => {
  const a = baseAdapters({ media: { loadCanonReferences: async () => { throw new Error('CANON_REFERENCES_UNAVAILABLE'); }, savePrivateImage: async () => ({}) } });
  await assert.rejects(run(a), /CANON_REFERENCES_UNAVAILABLE/);
  assert.equal(a.calls.reserve, 0);
  const b = baseAdapters();
  await assert.rejects(run(b, { request: req({ quality: 'ultra' }) }), /INVALID_IMAGE_REQUEST/);
  await assert.rejects(run(b, { request: req({ size: '99x99' }) }), /INVALID_IMAGE_REQUEST/);
});
