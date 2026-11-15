import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParams, normalizeCanon, normalizeCharacterInput, normalizeScore, composeArtDirection, sniffImage, csvCell, ApiError } from '../../src/params.mjs';
import { parseConfig } from '../../src/limits.mjs';

const cfg = parseConfig({});
const ok = { characterIds: ['char-0001'], sceneText: 'Two men talk on a balcony at dusk.' };
const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e instanceof ApiError ? e.code : `ERR:${e.message}`; } };

test('params: defaults are safe (auto moderation, high quality, portrait, 1 image)', () => {
  const p = normalizeParams(ok, cfg);
  assert.equal(p.moderation, 'auto'); assert.equal(p.quality, 'high'); assert.equal(p.size, '1024x1536');
  assert.equal(p.count, 1); assert.equal(p.model, 'gpt-image-2.6-sunburst'); assert.equal(p.allowDuplicate, false);
});

test('params: rejects bad ids, models, moderation, sizes, batch and missing scene', () => {
  assert.equal(code(() => normalizeParams({ ...ok, characterIds: [] }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, characterIds: ['../x'] }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, characterIds: ['char-0001', 'char-0001'] }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, model: 'gpt-4o' }, cfg)), 'MODEL_NOT_ALLOWED');
  assert.equal(code(() => normalizeParams({ ...ok, moderation: 'off' }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, size: '5000x5000' }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, quality: 'ultra' }, cfg)), 'FIELD_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, count: 4 }, cfg)), 'BATCH_SIZE_INVALID');
  assert.equal(code(() => normalizeParams({ ...ok, count: 1.5 }, cfg)), 'BATCH_SIZE_INVALID');
  assert.equal(code(() => normalizeParams({ characterIds: ['char-0001'] }, cfg)), 'FIELD_REQUIRED');
  assert.equal(code(() => normalizeParams({ ...ok, sceneText: 'x'.repeat(1501) }, cfg)), 'FIELD_INVALID');
});

test('params: minor-signal text is blocked in every free-text field', () => {
  for (const f of ['sceneText', 'worldText', 'artDirection', 'garmentPhysics', 'label']) {
    assert.equal(code(() => normalizeParams({ ...ok, [f]: 'a teenage boy' }, cfg)), 'BLOCKED_MINOR_TERMS', f);
  }
  assert.equal(code(() => normalizeParams({ ...ok, outfits: { 'char-0001': 'a child costume' } }, cfg)), 'BLOCKED_MINOR_TERMS');
  assert.equal(code(() => normalizeCanon({ apparentAge: '15 year old' })), 'BLOCKED_MINOR_TERMS');
  assert.equal(code(() => normalizeCharacterInput({ name: 'Teen Wolf' })), 'BLOCKED_MINOR_TERMS');
});

test('canon: keeps known fields, null means confirmed absent, unknown keys dropped, adult attestation must be literal true', () => {
  const c = normalizeCanon({ skinTone: ' warm brown ', facialHair: null, junk: 'x', hair: '' });
  assert.deepEqual(c, { skinTone: 'warm brown', facialHair: null });
  assert.equal(normalizeCharacterInput({ name: 'Oryn', adultAttested: 'true' }).adultAttested, false);
  assert.equal(normalizeCharacterInput({ name: 'Oryn', adultAttested: true }).adultAttested, true);
});

test('garment physics only joins the art direction when the owner opts in', () => {
  const a = normalizeParams({ ...ok, artDirection: 'warm light', garmentPhysics: 'opaque seamed pouch', useGarmentPhysics: false }, cfg);
  const b = normalizeParams({ ...ok, artDirection: 'warm light', garmentPhysics: 'opaque seamed pouch', useGarmentPhysics: true }, cfg);
  assert.equal(composeArtDirection(a), 'warm light');
  assert.match(composeArtDirection(b), /GARMENT CONSTRUCTION: opaque seamed pouch/);
});

test('uploads are identified by magic bytes, not by claimed type', () => {
  const pad = (a) => Uint8Array.from([...a, ...new Array(20).fill(0)]);
  assert.equal(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(pad([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0])), 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>  ')), null);
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a......')), null);
});

test('scores: integers 1-5 only; csv cells are escaped and formula-injection safe', () => {
  assert.deepEqual(normalizeScore({ identity: 4, anatomy: 5, notes: 'ok' }), { identity: 4, anatomy: 5, notes: 'ok', garment: '', condition: '' });
  assert.equal(code(() => normalizeScore({ identity: 6 })), 'FIELD_INVALID');
  assert.equal(code(() => normalizeScore({ fabric: 2.5 })), 'FIELD_INVALID');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell(null), ''); assert.equal(csvCell(3), '3');
});

test('moderation low: needs adult surface AND server flag AND explicit selection; adult surface needs attestation', () => {
  const on = parseConfig({ ALLOW_LOW_MODERATION: 'true', OWNER_ADULT_ATTESTED: 'true' });
  assert.equal(code(() => normalizeParams({ ...ok, moderation: 'low' }, cfg)), 'LOW_MODERATION_NOT_ALLOWED');
  assert.equal(code(() => normalizeParams({ ...ok, moderation: 'low', surface: 'adult' }, cfg)), 'ADULT_SURFACE_DISABLED');
  assert.equal(code(() => normalizeParams({ ...ok, moderation: 'low' }, on)), 'LOW_MODERATION_NOT_ALLOWED'); // sfw surface
  assert.equal(code(() => normalizeParams({ ...ok, moderation: 'low', surface: 'adult' }, parseConfig({ OWNER_ADULT_ATTESTED: 'true' }))), 'LOW_MODERATION_NOT_ALLOWED');
  assert.equal(normalizeParams({ ...ok, moderation: 'low', surface: 'adult' }, on).moderation, 'low');
  assert.equal(normalizeParams({ ...ok, surface: 'adult' }, on).moderation, 'auto'); // adult surface alone never means low
});
