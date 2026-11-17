import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { PREBUILT, prebuiltIds, refPlan, allRefFiles, normalizePrebuilt, prebuiltScene } from '../../src/prebuilt-canon.mjs';

const ok = (over = {}) => ({ mode: 'scene', scene: 'At the door.', idempotencyKey: 'abcdefghijklmnop1234', ...over });

test('four starters are defined and every reference file exists and is a reasonably small JPEG', () => {
  assert.deepEqual(prebuiltIds.sort(), ['aeon', 'nova', 'oryn', 'seraphine']);
  for (const id of prebuiltIds) for (const f of allRefFiles(id)) {
    const p = new URL(`../../public/_refs/${f}`, import.meta.url);
    assert.ok(existsSync(p), f); assert.ok(statSync(p).size > 20_000 && statSync(p).size < 1_500_000, f);
  }
});
test('refPlan: look reference is dropped when a new outfit is requested; dragon has no look', () => {
  assert.deepEqual(refPlan('nova', 'default', false).map((r) => r.role), ['face', 'body', 'look']);
  assert.deepEqual(refPlan('nova', 'default', true).map((r) => r.role), ['face', 'body']);
  assert.deepEqual(refPlan('aeon', 'dragon', false).map((r) => r.role), ['face', 'body']);
  assert.deepEqual(refPlan('aeon', 'human', false).map((r) => r.role), ['face', 'body', 'look']);
  assert.ok(refPlan('oryn', 'default', false).every((r) => r.label.includes('Oryn')));
});
test('normalizePrebuilt validates mode, form, required text, minor terms and key', () => {
  assert.equal(normalizePrebuilt('aeon', ok()).form, 'dragon');                       // Æon defaults to the dragon form
  assert.equal(normalizePrebuilt('aeon', ok({ form: 'human' })).form, 'human');
  for (const [id, over] of [['x', {}], ['nova', { mode: 'x' }], ['nova', { form: 'human' }], ['nova', { scene: '' }], ['nova', { mode: 'outfit' }],
    ['nova', { scene: 'a child at a door' }], ['nova', { idempotencyKey: 'short' }], ['nova', { scene: 'y'.repeat(501) }]]) assert.throws(() => normalizePrebuilt(id, ok(over)), id + JSON.stringify(over));
});
test('prebuiltScene uses canon look unless an outfit is given, and always an adult-presenting locked block', () => {
  assert.match(prebuiltScene(normalizePrebuilt('oryn', ok())).outfit, /clay-glyph/);
  assert.equal(prebuiltScene(normalizePrebuilt('oryn', { ...ok({ mode: 'outfit', outfit: 'a white linen robe' }) })).outfit, 'a white linen robe');
  assert.equal(prebuiltScene(normalizePrebuilt('aeon', ok())).outfit, '');            // dragon: no clothing
  for (const id of prebuiltIds) for (const f of Object.values(PREBUILT[id].locked)) assert.ok(!/child|teen|minor/i.test(JSON.stringify(f)));
});
