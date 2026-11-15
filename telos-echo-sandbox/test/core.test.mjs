import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIImageAdapter } from '../src/openai-image-api.mjs';
import { buildSceneImagePrompt } from '../src/prompt-builder.mjs';
import { maybeOfferImage } from '../src/suggestion-gate.mjs';
import { createSceneImageService } from '../src/scene-image-service.mjs';
import { idempotencyKeyForQuote } from '../src/browser-image-client.mjs';
import { adultCanon, sampleScene, sampleWorld, baseAdapters, principal, req } from '../test-support/doubles.mjs';

const okFetch = (capture) => async (url, options) => {
  capture.url = url; capture.options = options;
  return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }] }) };
};

// ---- the six handoff tests, updated only where the hardened contract requires it ----

test('composes locked appearance with timestamp-specific mutable state', () => {
  const prompt = buildSceneImagePrompt({ scene: sampleScene(), characters: [adultCanon()], world: sampleWorld });
  for (const term of ['gray curls', 'warm brown', 'natural dense', 'opaque black briefs', '2026-11-12T20:00:00Z'])
    assert.ok(prompt.includes(term));
});

test('suggestions are offers only and require confirmation', () => {
  const s = maybeOfferImage({ classifierResult: { photoWorthy: true, confidence: .9 }, event: { id: 's-1' }, account: {}, surface: 'sfw', enabled: true });
  assert.equal(s.requiresExplicitUserConfirmation, true);
  assert.equal(maybeOfferImage({ classifierResult: { photoWorthy: true, confidence: .9 }, event: { id: 's-1' }, account: { age: 17 }, surface: 'adult', enabled: true }), null);
});

test('generation sends SFW auto moderation to /images/generations', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', fetchFn: okFetch(cap) });
  const result = await fn({ prompt: 'test portrait', surface: 'sfw' });
  assert.ok(cap.url.endsWith('/images/generations'));
  const body = JSON.parse(cap.options.body);
  assert.equal(body.moderation, 'auto');
  assert.equal(body.model, 'gpt-image-2.6-sunburst');
  assert.equal(result.bytes.toString(), 'PNG');
  assert.equal(result.moderation, 'auto');
});

test('image edit sends canonical references to /images/edits; adult uses low ONLY when enabled', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', allowLowModeration: true, fetchFn: okFetch(cap) });
  const result = await fn({ prompt: 'test with refs', surface: 'adult', referenceImages: [{ bytes: Buffer.from('fake bytes'), mime: 'image/png' }] });
  assert.ok(cap.url.endsWith('/images/edits'));
  assert.equal(cap.options.body.get('moderation'), 'low');
  assert.equal(cap.options.body.getAll('image[]').length, 1);
  assert.equal(cap.options.body.has('input_fidelity'), false);
  assert.equal(result.moderation, 'low');
});

test('adult generation fails closed on age gate before work begins', async () => {
  const fn = createSceneImageService(baseAdapters());
  await assert.rejects(fn({ principal: { userId: 'user-1', verifiedAdult: false, age: 29 }, trustedSurface: 'adult', request: req() }), /ADULT_VERIFICATION_REQUIRED/);
});

test('milestone images cannot be charged by ledger', async () => {
  const a = baseAdapters();
  const fn = createSceneImageService(a);
  await assert.rejects(fn({ principal, trustedSurface: 'sfw', request: req({ purpose: 'milestone' }) }), /MILESTONE_MUST_BE_FREE/);
  assert.equal(a.calls.reserve, 0);
  assert.equal(a.calls.provider, 0);
});

// ---- new: defects found in the reference code ----

test('adapter: adult surface still uses auto moderation unless the low-moderation flag is enabled', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', fetchFn: okFetch(cap) });
  const r = await fn({ prompt: 'x', surface: 'adult' });
  assert.equal(JSON.parse(cap.options.body).moderation, 'auto');
  assert.equal(r.moderation, 'auto');
});

test('adapter: SFW can never get low moderation even with the flag on', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', allowLowModeration: true, fetchFn: okFetch(cap) });
  await fn({ prompt: 'x', surface: 'sfw' });
  assert.equal(JSON.parse(cap.options.body).moderation, 'auto');
});

test('adapter: safety_identifier is not sent by default; untrusted surface and bad refs are rejected', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', fetchFn: okFetch(cap) });
  await fn({ prompt: 'x', surface: 'sfw', safetyIdentifier: 'abc' });
  assert.equal('safety_identifier' in JSON.parse(cap.options.body), false);
  await assert.rejects(fn({ prompt: 'x', surface: 'whatever' }), /UNTRUSTED_SURFACE/);
  await assert.rejects(fn({ prompt: 'x', surface: 'sfw', referenceImages: [{ bytes: Buffer.from('a'), mime: 'image/gif' }] }), /UNSUPPORTED_CANON_REFERENCE_FORMAT/);
  assert.throws(() => createOpenAIImageAdapter({ apiKey: '' }), /OPENAI_API_KEY_REQUIRED_SERVER_SIDE/);
});

test('adapter: provider errors become coded, retry-classified, and carry no prompt text', async () => {
  const mk = (status) => createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', fetchFn: async () => ({ ok: false, status, text: async () => 'secret prompt echo' }) });
  const e429 = await mk(429)({ prompt: 'x', surface: 'sfw' }).catch((e) => e);
  assert.equal(e429.message, 'IMAGE_PROVIDER_HTTP_429');
  assert.equal(e429.retryable, true);
  const e400 = await mk(400)({ prompt: 'x', surface: 'sfw' }).catch((e) => e);
  assert.equal(e400.retryable, false);
  assert.equal(e400.providerDiagnostic, 'secret prompt echo'); // private log field only
});

test('suggestion gate: off by default, and missing confidence no longer passes', () => {
  const base = { classifierResult: { photoWorthy: true, confidence: .95 }, event: { id: 's-1' }, account: {}, surface: 'sfw' };
  assert.equal(maybeOfferImage(base), null); // flag defaults off
  assert.ok(maybeOfferImage({ ...base, enabled: true }));
  assert.equal(maybeOfferImage({ ...base, enabled: true, classifierResult: { photoWorthy: true } }), null);
  assert.equal(maybeOfferImage({ ...base, enabled: true, classifierResult: { photoWorthy: true, confidence: '0.99' } }), null);
  assert.equal(maybeOfferImage({ ...base, enabled: true, classifierResult: { photoWorthy: true, confidence: .5 } }), null);
});

test('browser client: one quote always yields the same idempotency key (no double charge on retry)', () => {
  assert.equal(idempotencyKeyForQuote('q_123'), idempotencyKeyForQuote('q_123'));
  assert.match(idempotencyKeyForQuote('q_123'), /^[a-zA-Z0-9._:-]{8,128}$/);
  assert.throws(() => idempotencyKeyForQuote(''), /QUOTE_ID_REQUIRED/);
});

test('prompt: null appearance state is rendered as CONFIRMED ABSENT, not dropped', () => {
  const c = adultCanon({ appearance: { locked: { facialHair: null, hair: 'gray' }, atSceneTime: {} } });
  const prompt = buildSceneImagePrompt({ scene: sampleScene(), characters: [c], world: sampleWorld });
  assert.match(prompt, /facialHair: CONFIRMED ABSENT/);
  assert.throws(() => buildSceneImagePrompt({ scene: sampleScene(), characters: [], world: sampleWorld }), /SCENE_CANON_INCOMPLETE/);
});

test('adapter: quality/size are validated and sent; apiRoot override is honoured (mock server tests)', async () => {
  const cap = {};
  const fn = createOpenAIImageAdapter({ apiKey: 'TEST_ONLY', apiRoot: 'http://127.0.0.1:9/v1', fetchFn: okFetch(cap) });
  await fn({ prompt: 'x', surface: 'sfw', quality: 'medium', size: '1024x1024' });
  const body = JSON.parse(cap.options.body);
  assert.equal(cap.url, 'http://127.0.0.1:9/v1/images/generations');
  assert.equal(body.quality, 'medium');
  assert.equal(body.size, '1024x1024');
  await assert.rejects(fn({ prompt: 'x', surface: 'sfw', quality: 'ultra' }), /INVALID_IMAGE_QUALITY/);
  await assert.rejects(fn({ prompt: 'x', surface: 'sfw', size: '1x1' }), /INVALID_IMAGE_SIZE/);
});

test('prompt: reference manifest names each attached image in order', () => {
  const p = buildSceneImagePrompt({ scene: sampleScene(), characters: [adultCanon()], world: sampleWorld, referenceManifest: ['SUBJECT 1 face', 'SUBJECT 1 full body'] });
  assert.ok(p.indexOf('image 1: SUBJECT 1 face') < p.indexOf('image 2: SUBJECT 1 full body'));
});
