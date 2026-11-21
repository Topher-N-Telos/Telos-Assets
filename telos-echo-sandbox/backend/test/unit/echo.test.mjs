import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLAGE_COUNTS, COLLAGE_ROWS, panelRects, skolPrices, priceFor, collagePrompt, styleId, STYLES, normalizeFormat, eligibleForLowModeration } from '../../src/echo.mjs';

test('every collage size has full-width rows and a rectangle per panel, ending at the last number', () => {
  for (const n of COLLAGE_COUNTS) {
    assert.equal(COLLAGE_ROWS[n].reduce((a, b) => a + b, 0), n);
    const r = panelRects(n); assert.equal(r.length, n); assert.equal(r.at(-1).index, n);
    for (const x of r) { assert.ok(x.x >= 0 && x.y >= 0 && x.x + x.width <= 1.0001 && x.y + x.height <= 1.0001); }
    for (const row of new Set(r.map((x) => x.y))) assert.ok(Math.abs(r.filter((x) => x.y === row).reduce((a, b) => a + b.width, 0) - 1) < 1e-9, `row fills width n=${n}`);
  }
});
test('price ladder must be complete, whole, strictly increasing; otherwise no collage price exists', () => {
  const ok = { 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6 };
  assert.equal(priceFor(skolPrices({ COLLAGE_SKOL_PRICES: JSON.stringify(ok) }), 'collage', 9), 6);
  for (const bad of [undefined, '', 'nope', JSON.stringify({ ...ok, 7: 3 }), JSON.stringify({ ...ok, 9: '6' }), JSON.stringify({ 4: 1 }), JSON.stringify({ ...ok, 5: 1 })]) assert.equal(skolPrices({ COLLAGE_SKOL_PRICES: bad }).collage, null);
  assert.equal(priceFor(skolPrices({}), 'single'), 20);
  assert.equal(priceFor(skolPrices({}), 'collage', 4), null);
});
test('collage prompt demands exact count, one art treatment, and no printed lettering', () => {
  const t = collagePrompt(7, 'Anime'); assert.match(t, /EXACTLY 7/); assert.match(t, /3, 2, 2 panels/); assert.match(t, /\(Anime\)/); assert.match(t, /NO printed panel numbers/);
  assert.throws(() => collagePrompt(3, 'x'));
});
test('style ids accept labels from the app picker and default to realism', () => {
  assert.equal(styleId('Comic Book'), 'comic'); assert.equal(styleId('watercolor'), 'watercolor'); assert.equal(styleId('nonsense'), 'realism'); assert.equal(styleId(undefined), 'realism');
  assert.equal(new Set(STYLES.map((s) => s.id)).size, STYLES.length);
});
test('single image refuses collage options; collage requires 4–9', () => {
  assert.throws(() => normalizeFormat({ format: 'single', panelCount: 4 })); assert.throws(() => normalizeFormat({ format: 'collage', panelCount: 10 }));
  assert.equal(normalizeFormat({ format: 'collage', panelCount: 9, showPanelNumbers: true }).showPanelNumbers, true);
});
test('only the owner and the explicit adult-beta list may use Low moderation', () => {
  const env = { OWNER_EMAIL: 'o@x.com', ADULT_BETA_EMAILS: 'a@x.com, B@x.com' };
  assert.deepEqual(['o@x.com', 'A@x.com', 'b@x.com', 'c@x.com', ''].map((e) => eligibleForLowModeration(env, e)), [true, true, true, false, false]);
  assert.equal(eligibleForLowModeration({}, 'o@x.com'), false);
});
