/** End-to-end: REAL Worker + Durable Objects in local workerd, fake OpenAI. No network, no key, no spend. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-openai.mjs';
import { makePng } from './png.mjs';

const A = 'http://localhost:8787', B = 'http://localhost:8788', C = 'http://localhost:8789', D = 'http://localhost:8790', E = 'http://localhost:8791', W = 'http://localhost:8792', MOCK = 8799;
let mock, procs = [];
const OWNER = 'owner@example.com', ALICE = 'alice@example.com', BOB = 'bob@example.com', EVE = 'eve@example.com', CARA = 'cara@example.com';
const BASE = { OWNER_EMAIL: OWNER, ALLOWED_EMAILS: `${ALICE},${BOB},${CARA}`, DEV_BYPASS_AUTH: 'true', OPENAI_API_BASE: `http://127.0.0.1:${MOCK}/v1`, OPENAI_API_KEY: 'mock-key', MIN_SUBMIT_INTERVAL_MS: 100 };

function launch(port, vars) {
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--persist-to', mkdtempSync(join(tmpdir(), 'telos-be-')), '--inspector-port', String(port + 100)];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const p = spawn('npx', args, { detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  procs.push(p);
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('wrangler did not start:\n' + out.slice(-1500))), 90000);
    const on = (d) => { out += d; if (out.includes('Ready on')) { clearTimeout(t); resolve(); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
  });
}
before(async () => {
  ({ log: globalThis.mockLog } = mock = await startMock(MOCK));
  await Promise.all([
    launch(8787, { ...BASE, MAX_USD_PER_DAY: 10, MAX_USD_PER_MONTH: 100 }),
    launch(8788, {}),                                                                   // no auth config at all
    launch(8789, { ...BASE, MAX_USD_PER_DAY: 0.65, EST_USD_PER_CALL: 0.1 }),          // tiny global cap
    launch(8790, { ...BASE, MAX_USD_PER_DAY: 50, MAX_USD_PER_MONTH: 500, MAX_CALLS_PER_DAY_USER: 60 }),           // roomy caps: prebuilt-Telō tests
    launch(8791, { ...BASE, MAX_USD_PER_DAY: 50, MAX_USD_PER_MONTH: 500, MAX_CALLS_PER_DAY_USER: 60, ADULT_BETA_EMAILS: ALICE, SKOL_TEST_ALLOWANCE: 'off', COLLAGE_SKOL_PRICES: JSON.stringify({ 4: 100, 5: 120, 6: 150, 7: 200, 8: 275, 9: 400 }) }),
    launch(8792, { ...BASE, MAX_USD_PER_DAY: 50, MAX_USD_PER_MONTH: 500, MAX_CALLS_PER_DAY_USER: 60, ADULT_BETA_EMAILS: ALICE, COLLAGE_SKOL_PRICES: JSON.stringify({ 4: 100, 5: 120, 6: 150, 7: 200, 8: 275, 9: 400 }) })   // Sköl test-allowance wallet (3 nine-panel collages = 1200)   // Echō collage tests (ladder = TEST numbers only)
  ]);
});
after(() => { for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } mock?.server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (base, who, method, path, body, headers = {}) => {
  const opt = { method, headers: { 'x-telos': '1', ...(who ? { 'x-dev-email': who } : {}), ...headers } };
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) opt.body = body;
  else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(base + path, opt);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, json: ct.includes('json') ? await r.json() : null, bytes: ct.includes('json') || ct.includes('text') ? null : Buffer.from(await r.arrayBuffer()) };
};
const as = (who, base = A) => (m, p, b, h) => call(base, who, m, p, b, h);
const alice = as(ALICE), bob = as(BOB), owner = as(OWNER);
const key = () => crypto.randomUUID().replace(/-/g, '');
const fields = (over = {}) => ({ description: 'A calm man with a short beard in a linen shirt', apparentAge: '34', name: 'Test', ...over });
const body = (over = {}) => ({ fields: fields(over.fields), adultAttested: true, idempotencyKey: key(), photoIds: [], ...over, ...(over.fields ? { fields: fields(over.fields) } : {}) });
const wait = async (api, id, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const j = (await api('GET', '/api/jobs/' + id)).json;
    if (['complete', 'failed'].includes(j.state)) return j;
    if (Date.now() > end) throw new Error('timeout ' + JSON.stringify(j));
    await sleep(250);
  }
};
// Avatars are now a package like Telōs: first generation = package, later ones are single-image redos ('full') unless a test says otherwise.
const gen = async (api, kind, over) => {
  if (kind === 'avatar' && !(over && over.part)) { const me = (await api('GET', '/api/me')).json; over = { ...over, part: me?.avatar?.hasPackage ? 'full' : 'package' }; }
  return api('POST', `/api/onboarding/${kind}/generate`, body(over));
};
const genWait = async (api, kind, over) => { const r = await gen(api, kind, over); assert.equal(r.status, 200, JSON.stringify(r.json)); return wait(api, r.json.id); };

test('secured instance refuses everything without Access config (fails closed)', async () => {
  for (const p of ['/', '/api/me']) { const r = await call(B, null, 'GET', p); assert.equal(r.status, 503, p); assert.equal(r.json.error, 'AUTH_NOT_CONFIGURED'); }
  assert.equal((await call(B, null, 'GET', '/api/me', undefined, { 'Cf-Access-Jwt-Assertion': 'a.b.c' })).status, 503);
});

test('allowlist: unknown email is refused, testers and owner are in', async () => {
  assert.equal((await as(EVE)('GET', '/api/me')).status, 403);
  assert.equal((await as('')('GET', '/api/me')).status, 200);       // no header -> falls back to owner in dev
  assert.equal((await alice('GET', '/api/me')).status, 200);
  assert.equal((await bob('GET', '/api/me')).status, 200);
});

test('page headers, CSRF, and admin routes are owner-only', async () => {
  const r = await fetch(A + '/test', { headers: { 'x-dev-email': ALICE } }); const html = await r.text();
  const csp = r.headers.get('content-security-policy'); const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)[1];
  assert.ok(html.includes(`nonce="${nonce}"`)); assert.ok(!html.includes('__NONCE__')); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(A + '/api/me/purge', { method: 'POST', body: '{}', headers: { 'x-dev-email': ALICE } })).status, 403);
  assert.equal((await fetch(A + '/api/me/purge', { method: 'POST', body: '{}', headers: { 'x-dev-email': ALICE, 'x-telos': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await alice('GET', '/api/_admin/summary')).status, 403);
  assert.equal((await alice('POST', '/api/_admin/pause', { paused: true })).status, 403);
  assert.equal((await alice('POST', `/api/_admin/user/${ALICE}/allowance`, { kind: 'avatar', extra: 5 })).status, 403);
});

test('the Telōs app is served at / behind the same auth, with its own CSP and no cache sharing', async () => {
  const r = await fetch(A + '/', { headers: { 'x-dev-email': ALICE } }); const html = await r.text();
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(html.includes('id="root"') && html.includes('OnboardingImagePanel') && html.includes('/api/onboarding/'));
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("connect-src 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes('*'));
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await fetch(A + '/', { method: 'POST', headers: { 'x-dev-email': ALICE } })).status, 405);
  assert.equal((await fetch(A + '/telos.html', { headers: { 'x-dev-email': ALICE } })).status, 404);   // raw asset path is not exposed
  assert.equal((await fetch(A + '/', { headers: { 'x-dev-email': EVE } })).status, 403);             // allowlist applies to the app page
});

test('app art and fonts are served behind the same login, with correct types and long cache; other paths are not exposed', async () => {
  const img = await fetch(A + '/_blob/06fca1493ccae966f182cd7309bac98c.jpg', { headers: { 'x-dev-email': ALICE } });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg'); assert.match(img.headers.get('cache-control'), /immutable/);
  assert.ok((await img.arrayBuffer()).byteLength > 1000);
  const font = await fetch(A + '/_fonts/cinzel-latin-wght-normal.woff2', { headers: { 'x-dev-email': ALICE } });
  assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(A + '/_blob/06fca1493ccae966f182cd7309bac98c.jpg', { headers: { 'x-dev-email': EVE } })).status, 403);
  assert.equal((await fetch(A + '/_blob/../telos.html', { headers: { 'x-dev-email': ALICE } })).status, 404);
  assert.equal((await fetch(A + '/_blob/missing.jpg', { headers: { 'x-dev-email': ALICE } })).status, 404);
});

test('free allotment: avatar and telo each get 1 generation + 1 redo, third is FREE_ALLOTMENT_USED; counts are per kind', async () => {
  const me0 = (await alice('GET', '/api/me')).json;
  assert.equal(me0.avatar.remaining, 2); assert.equal(me0.telo.remaining, 2);
  const j1 = await genWait(alice, 'avatar'); assert.equal(j1.state, 'complete', JSON.stringify(j1)); assert.ok(j1.imageId);
  assert.equal(j1.remaining, 1);
  await sleep(150);
  const j2 = await genWait(alice, 'avatar'); assert.equal(j2.state, 'complete'); assert.equal(j2.remaining, 0);
  await sleep(150);
  const r3 = await gen(alice, 'avatar'); assert.equal(r3.status, 402); assert.equal(r3.json.error, 'FREE_ALLOTMENT_USED');
  assert.equal((await alice('GET', '/api/me')).json.telo.remaining, 2);       // telo untouched
  const sent = mockLog.at(-1);
  assert.equal(sent.path, '/v1/images/generations'); assert.equal(sent.moderation, 'auto'); assert.equal(sent.model, 'gpt-image-2.6-sunburst');
  assert.equal(sent.quality, 'high'); assert.equal(sent.size, '1024x1536');
  // image bytes are PNG and only the owner can read them
  const img = await alice('GET', '/api/images/' + j1.imageId); assert.equal(img.bytes[1], 0x50); assert.match(img.headers.get('cache-control'), /no-store/);
  assert.equal((await bob('GET', '/api/images/' + j1.imageId)).status, 404);
  ctx.aliceAvatar = j1.imageId;
});
const ctx = {};

test('idempotent replay: same key -> same job, no new provider call, no extra entitlement used', async () => {
  const b = body(); await sleep(150);
  const r1 = await bob('POST', '/api/onboarding/telo/generate', b); assert.equal(r1.status, 200);
  const n = mockLog.length;
  const r2 = await bob('POST', '/api/onboarding/telo/generate', b);
  assert.equal(r2.status, 200); assert.equal(r2.json.replay, true); assert.equal(r2.json.id, r1.json.id);
  const bad = await bob('POST', '/api/onboarding/telo/generate', { ...b, fields: fields({ description: 'something else entirely' }) });
  assert.equal(bad.status, 409); assert.equal(bad.json.error, 'IDEMPOTENCY_CONFLICT');
  await wait(bob, r1.json.id); assert.equal(mockLog.length - n, 2);                       // a Telō package = full-length + face close-up
  assert.equal((await bob('GET', '/api/me')).json.telo.remaining, 1);                       // ...but ONE allotment unit
});

test('provider rejection refunds the free try (FORCE_400)', async () => {
  await sleep(150);
  const before = (await bob('GET', '/api/me')).json.telo.remaining;
  const r = await gen(bob, 'telo', { part: 'full', fields: { description: 'FORCE_400 a man by the sea' } }); assert.equal(r.status, 200);     // single-image redo
  const j = await wait(bob, r.json.id);
  assert.equal(j.state, 'failed'); assert.equal(j.refunded, true); assert.equal(j.imageId, null);
  assert.equal((await bob('GET', '/api/me')).json.telo.remaining, before);
});

test('minors are refused: age < 18, minor terms, missing attestation', async () => {
  await sleep(150);
  assert.equal((await gen(bob, 'telo', { fields: { apparentAge: '15' } })).json.error, 'CHARACTER_AGE_NOT_ADULT');
  assert.equal((await gen(bob, 'telo', { fields: { description: 'a teenage boy on a beach' } })).json.error, 'BLOCKED_MINOR_TERMS');
  assert.equal((await gen(bob, 'telo', { fields: { apparentAge: undefined, description: 'x' } })).json.error, 'FIELD_REQUIRED');
  assert.equal((await bob('POST', '/api/onboarding/telo/generate', { ...body(), adultAttested: false })).json.error, 'ADULT_ATTESTATION_REQUIRED');
  assert.equal((await bob('GET', '/api/me')).json.telo.remaining, 1);   // nothing consumed
});

test('photo uploads: certification, magic bytes, per-user isolation, edits endpoint, accept deletes photos', async () => {
  const png = makePng(64, 96, [10, 20, 30]);
  assert.equal((await bob('POST', '/api/uploads', png)).json.error, 'CERTIFICATION_REQUIRED');
  assert.equal((await bob('POST', '/api/uploads', Buffer.from('<svg onload=alert(1)>'), { 'x-certify': 'self' })).status, 415);
  const big = makePng(32, 48, [1, 2, 3], 2_500_000);   // crosses the 900 KB chunk boundary
  const u1 = await bob('POST', '/api/uploads', big, { 'x-certify': 'self' }); assert.equal(u1.status, 200);
  const u2 = await bob('POST', '/api/uploads', png, { 'x-certify': 'self' }); assert.equal(u2.status, 200);
  const back = await bob('GET', `/api/uploads/${u1.json.id}/image`); assert.deepEqual(back.bytes, big);
  assert.equal((await alice('GET', `/api/uploads/${u1.json.id}/image`)).status, 404);          // other tester cannot read it
  assert.equal((await alice('POST', '/api/onboarding/avatar/generate', body({ photoIds: [u1.json.id], part: 'full' }))).status, 404);
  await sleep(150);
  const r = await bob('POST', '/api/onboarding/avatar/generate', body({ photoIds: [u1.json.id, u2.json.id] })); assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = await wait(bob, r.json.id); assert.equal(j.state, 'complete', JSON.stringify(j));
  const sent = mockLog.at(-2); assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 2);
  assert.equal((await bob('POST', `/api/onboarding/avatar/accept`, { imageId: 'nope' })).status, 404);
  assert.ok(j.faceImageId); assert.equal((await bob('POST', `/api/onboarding/avatar/accept`, { imageId: j.imageId })).json.error, 'FACE_IMAGE_REQUIRED');
  const acc = await bob('POST', `/api/onboarding/avatar/accept`, { imageId: j.imageId, faceImageId: j.faceImageId }); assert.equal(acc.json.avatar.acceptedImageId, j.imageId);
  assert.equal((await bob('GET', `/api/uploads/${u1.json.id}/image`)).status, 404);           // photos deleted on accept
  assert.equal((await bob('GET', '/api/me')).json.uploads.length, 0);
  assert.equal((await bob('POST', '/api/onboarding/avatar/generate', body())).json.error, 'ALREADY_ACCEPTED');
});

test('Telō imported-character references (14B.1A): rights certification, separate from avatar photos, edits endpoint, accept clears only telo refs', async () => {
  await sleep(150);
  const png = makePng(64, 96, [40, 60, 90]);
  const r1 = await alice('POST', '/api/uploads', png, { 'x-certify': 'rights' }); assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const av = await alice('POST', '/api/uploads', png, { 'x-certify': 'self' }); assert.equal(av.status, 200);
  assert.equal((await alice('POST', '/api/onboarding/avatar/generate', body({ photoIds: [r1.json.id], part: 'full' }))).json.error, 'PHOTO_WRONG_PURPOSE');
  assert.equal((await alice('POST', '/api/onboarding/telo/generate', body({ photoIds: [av.json.id] }))).json.error, 'PHOTO_WRONG_PURPOSE');
  const g = await alice('POST', '/api/onboarding/telo/generate', body({ photoIds: [r1.json.id] })); assert.equal(g.status, 200, JSON.stringify(g.json));
  const j = await wait(alice, g.json.id); assert.equal(j.state, 'complete', JSON.stringify(j));
  const sent = mockLog.at(-1); assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 1);
  assert.ok(j.faceImageId);
  assert.equal((await alice('POST', '/api/onboarding/telo/accept', { imageId: j.imageId })).json.error, 'FACE_IMAGE_REQUIRED');
  assert.equal((await alice('POST', '/api/onboarding/telo/accept', { imageId: j.imageId, faceImageId: j.faceImageId })).status, 200);
  assert.equal((await alice('GET', `/api/uploads/${r1.json.id}/image`)).status, 404);
  assert.equal((await alice('GET', '/api/me')).json.uploads.length, 1);   // the avatar photo is untouched
});

test('admin: owner can grant extra free generations; non-owner cannot; purge keeps counters', async () => {
  const g = await owner('POST', `/api/_admin/user/${ALICE}/allowance`, { kind: 'avatar', extra: 1 }); assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.avatar.remaining, 1);
  const p = await alice('POST', '/api/me/purge', { confirm: 'DELETE MY DATA' }); assert.equal(p.status, 200);
  assert.equal(p.json.avatar.images.length, 0); assert.equal(p.json.avatar.remaining, 1);     // purge cannot reset free tries
  assert.equal((await alice('POST', '/api/me/purge', {})).json.error, 'CONFIRM_REQUIRED');
});

test('owner is unlimited: no free-allotment or daily-call limit, can re-accept; testers unaffected', async () => {
  const o = (await owner('GET', '/api/me')).json; assert.equal(o.avatar.unlimited, true); assert.equal(o.avatar.remaining, null);
  for (let i = 0; i < 3; i++) { await sleep(150); const r = await gen(owner, 'avatar'); assert.equal(r.status, 200, JSON.stringify(r.json)); const j = await wait(owner, r.json.id); assert.equal(j.state, 'complete'); assert.equal(j.remaining, null);
    const mo = (await owner('GET', '/api/me')).json.avatar; const a = await owner('POST', '/api/onboarding/avatar/accept', { imageId: j.imageId, faceImageId: mo.faceImages.at(-1).id }); assert.equal(a.status, 200); }
  assert.equal((await alice('GET', '/api/me')).json.avatar.unlimited, false);
});

test('global pause and the owner summary', async () => {
  await owner('POST', '/api/_admin/pause', { paused: true });
  await sleep(150);
  const r = await gen(alice, 'avatar'); assert.equal(r.status, 429); assert.equal(r.json.error, 'GENERATION_PAUSED');
  await owner('POST', '/api/_admin/pause', { paused: false });
  const s = (await owner('GET', '/api/_admin/summary')).json;
  assert.equal(s.paused, false); assert.ok(s.usdToday > 0 && s.usdToday < 5, String(s.usdToday));
  assert.ok(!JSON.stringify(s).includes('mock-key'));
});

test('global USD cap stops spend across users (tiny cap instance)', async () => {
  const a = as(ALICE, C), b = as(BOB, C);
  const j1 = await a('POST', '/api/onboarding/avatar/generate', body()); assert.equal(j1.status, 200); await wait(a, j1.json.id);
  await sleep(150);
  const j2 = await b('POST', '/api/onboarding/avatar/generate', body()); assert.equal(j2.status, 200); await wait(b, j2.json.id);
  await sleep(150);
  const j3 = await a('POST', '/api/onboarding/telo/generate', body()); assert.equal(j3.status, 429); assert.equal(j3.json.error, 'DAILY_USD_CAP');
  assert.equal((await a('GET', '/api/me')).json.telo.remaining, 2);    // refused before any entitlement was taken
});

test('no secrets leak in any response', async () => {
  for (const p of ['/api/me', '/api/_admin/summary']) { const r = await owner('GET', p); assert.ok(!JSON.stringify(r.json).includes('mock-key'), p); }
  assert.equal(mockLog.filter((e) => e.auth !== 'Bearer mock-key').length, 0);
});


// ---------- prebuilt (starter) Telōs: canon references seeded server-side, outfit / scene generation ----------
const cara = as(CARA, D), aliceD = as(ALICE, D), bobD = as(BOB, D), ownerD = as(OWNER, D), eveD = as(EVE, D);
const pbBody = (over = {}) => ({ mode: 'scene', scene: 'Standing at a heavy wooden door at dusk, about to knock.', idempotencyKey: key(), ...over });
const pbGen = (api, id, over) => api('POST', `/api/prebuilt/${id}/generate`, pbBody(over));
const pbWait = async (api, id, over) => { const r = await pbGen(api, id, over); assert.equal(r.status, 200, JSON.stringify(r.json)); return wait(api, r.json.id); };

test('prebuilt: canon references are private to the Worker (not served to anyone)', async () => {
  for (const p of ['/_refs/terra-nova/face.jpg', '/_refs/auris-aeon/dragon-face.jpg', '/public/_refs/terra-nova/face.jpg']) assert.equal((await aliceD('GET', p)).status, 404, p);
  assert.equal((await ownerD('GET', '/_refs/terra-nova/face.jpg')).status, 404);
});

test('prebuilt: scene uses face+body+canon look; outfit change drops the look; Æon dragon has no look and human has one', async () => {
  assert.equal((await cara('GET', '/api/me')).json.prebuilt.remaining, 6);
  const n = mockLog.length;
  let j = await pbWait(cara, 'nova'); assert.equal(j.state, 'complete', JSON.stringify(j)); assert.ok(j.imageId); assert.equal(j.remaining, 5);
  let sent = mockLog.at(-1); assert.equal(mockLog.length - n, 1); assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 3);
  await sleep(150);
  j = await pbWait(cara, 'nova', { mode: 'outfit', outfit: 'a deep burgundy wool coat with gold buttons', scene: undefined }); assert.equal(j.state, 'complete', JSON.stringify(j));
  assert.equal(mockLog.at(-1).imageParts, 2);
  await sleep(150);
  j = await pbWait(cara, 'aeon', { scene: 'Resting at the foot of a waterfall in the cave city.' }); assert.equal(j.state, 'complete'); assert.equal(mockLog.at(-1).imageParts, 2);   // dragon (default): face + body
  await sleep(150);
  j = await pbWait(cara, 'aeon', { form: 'human' }); assert.equal(j.state, 'complete'); assert.equal(mockLog.at(-1).imageParts, 3);                                   // Sir Rocco: face + body + look
  assert.equal((await cara('GET', '/api/images/' + j.imageId)).bytes[1], 0x50);
  assert.equal((await bobD('GET', '/api/images/' + j.imageId)).status, 404);                                                                                          // private to the owner
  assert.equal((await cara('GET', '/api/me')).json.prebuilt.remaining, 2);
});

test('prebuilt: validation fails closed before any spend', async () => {
  const n = mockLog.length;
  const bad = async (id, over, status, code) => { const r = await pbGen(cara, id, over); assert.equal(r.status, status, JSON.stringify(r.json)); assert.equal(r.json.error, code); };
  await bad('nobody', {}, 404, 'NOT_FOUND');
  await bad('nova', { mode: 'banana' }, 400, 'FIELD_INVALID');
  await bad('nova', { mode: 'outfit', outfit: '' }, 400, 'FIELD_REQUIRED');
  await bad('nova', { scene: '' }, 400, 'FIELD_REQUIRED');
  await bad('nova', { form: 'human' }, 400, 'FIELD_INVALID');                                    // only Æon has a second form
  await bad('aeon', { form: 'wolf' }, 400, 'FIELD_INVALID');
  await bad('oryn', { scene: 'a teen standing at a door' }, 400, 'BLOCKED_MINOR_TERMS');
  await bad('oryn', { idempotencyKey: 'short' }, 400, 'FIELD_INVALID');
  await bad('oryn', { scene: 'x'.repeat(501) }, 400, 'FIELD_INVALID');
  assert.equal(mockLog.length, n);
  assert.equal((await eveD('POST', '/api/prebuilt/nova/generate', pbBody())).status, 403);   // allowlist applies
});

test('prebuilt: provider rejection refunds the allotment; replay is idempotent; image delete works; owner is unlimited', async () => {
  const before = (await cara('GET', '/api/me')).json.prebuilt.remaining;
  await sleep(150);
  const j = await pbWait(cara, 'seraphine', { scene: 'FORCE_400 at the library window' });
  assert.equal(j.state, 'failed'); assert.equal(j.refunded, true);
  assert.equal((await cara('GET', '/api/me')).json.prebuilt.remaining, before);
  await sleep(150);
  const b = pbBody({ scene: 'At the moonlit balcony.' });
  const r1 = await cara('POST', '/api/prebuilt/seraphine/generate', b); assert.equal(r1.status, 200);
  const n = mockLog.length; const r2 = await cara('POST', '/api/prebuilt/seraphine/generate', b);
  assert.equal(r2.json.replay, true); assert.equal(r2.json.id, r1.json.id);
  const done = await wait(cara, r1.json.id); assert.equal(mockLog.length - n, 1);
  assert.equal((await cara('DELETE', '/api/images/' + done.imageId)).status, 200); assert.equal((await cara('GET', '/api/images/' + done.imageId)).status, 404);
  const ownerJob = await pbWait(ownerD, 'oryn'); assert.equal(ownerJob.state, 'complete'); assert.equal(ownerJob.remaining, null);
});

test('prebuilt: allotment runs out at the configured number, then FREE_ALLOTMENT_USED', async () => {
  const me = (await cara('GET', '/api/me')).json.prebuilt;
  for (let i = 0; i < me.remaining; i++) { await sleep(150); const j = await pbWait(cara, 'oryn'); assert.equal(j.state, 'complete', JSON.stringify(j)); }
  await sleep(150);
  const r = await pbGen(cara, 'oryn'); assert.ok([402, 429].includes(r.status), JSON.stringify(r.json));
});


// ---------- Telō onboarding package: full-length + face close-up = one free unit; either redo = one unit ----------
const tg = (api, over) => api('POST', '/api/onboarding/telo/generate', body(over));
const tw = async (api, over) => { const r = await tg(api, over); assert.equal(r.status, 200, JSON.stringify(r.json)); return wait(api, r.json.id); };

test('telo package: two images for one allotment unit; face is built from the full-length image; second package refused; each redo is one unit', async () => {
  const n = mockLog.length;
  assert.equal((await cara('GET', '/api/me')).json.telo.remaining, 2);
  const j = await tw(cara); assert.equal(j.state, 'complete', JSON.stringify(j)); assert.ok(j.imageId && j.faceImageId && j.imageId !== j.faceImageId); assert.equal(j.remaining, 1);
  assert.equal(mockLog.length - n, 2); assert.equal(mockLog[n].path, '/v1/images/generations'); assert.equal(mockLog[n + 1].path, '/v1/images/edits'); assert.equal(mockLog[n + 1].imageParts, 1);
  const me = (await cara('GET', '/api/me')).json.telo; assert.equal(me.hasPackage, true); assert.equal(me.images.length, 1); assert.equal(me.faceImages.length, 1);
  assert.equal((await cara('GET', '/api/images/' + j.faceImageId)).bytes[1], 0x50);
  await sleep(150);
  const again = await tg(cara); assert.equal(again.status, 409); assert.equal(again.json.error, 'PACKAGE_ALREADY_GENERATED');
  await sleep(150);
  const rf = await tw(cara, { part: 'face', refImageId: j.imageId }); assert.equal(rf.state, 'complete'); assert.ok(rf.imageId); assert.equal(rf.faceImageId, null); assert.equal(rf.remaining, 0);   // redo face = the free pass
  const cnt = mockLog.length; await sleep(150);
  const rr = await tg(cara, { part: 'full' }); assert.equal(rr.status, 402); assert.equal(rr.json.error, 'FREE_ALLOTMENT_USED'); assert.equal(mockLog.length, cnt);
  assert.equal((await cara('GET', '/api/me')).json.telo.faceImages.length, 2);
  ctx.caraFull = j.imageId; ctx.caraFace = rf.imageId;
});

test('telo package: face redo needs an existing full-length image; accept needs both images', async () => {
  await sleep(150);
  const bad = await tg(cara, { part: 'face', refImageId: 'doesnotexist12' }); assert.ok([402, 404].includes(bad.status), JSON.stringify(bad.json));
  assert.equal((await cara('POST', '/api/onboarding/telo/accept', { imageId: ctx.caraFull })).json.error, 'FACE_IMAGE_REQUIRED');
  const ok = await cara('POST', '/api/onboarding/telo/accept', { imageId: ctx.caraFull, faceImageId: ctx.caraFace }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.telo.acceptedImageId, ctx.caraFull); assert.equal(ok.json.telo.acceptedFaceImageId, ctx.caraFace);
  assert.equal((await tg(bobD, { part: 'face', refImageId: ctx.caraFull })).json.error, 'PACKAGE_REQUIRED');      // nobody else can redo before making their own package
});

test('telo package: either half failing refunds the whole unit and discards both images', async () => {
  const a0 = (await aliceD('GET', '/api/me')).json.telo.remaining, n = mockLog.length;
  const f1 = await tw(aliceD, { fields: { description: 'FORCE_400 a man by the sea' } });                          // full-length half fails
  assert.equal(f1.state, 'failed'); assert.equal(f1.refunded, true); assert.equal(mockLog.length - n, 1);
  await sleep(150);
  const f2 = await tw(aliceD, { fields: { description: 'FORCE_FACE a woman by the sea' } });                       // face half fails after the full image succeeded
  assert.equal(f2.state, 'failed'); assert.equal(f2.refunded, true); assert.equal(f2.imageId, null);
  const me = (await aliceD('GET', '/api/me')).json.telo;
  assert.equal(me.remaining, a0); assert.equal(me.images.length, 0); assert.equal(me.faceImages.length, 0); assert.equal(me.hasPackage, false);
  await sleep(150);
  const ok = await tw(aliceD); assert.equal(ok.state, 'complete', JSON.stringify(ok));                              // a clean retry still works
});

test('prebuilt: wardrobe garment layers are one transparent, registered reference; base route serves only the body canvas', async () => {
  const n = mockLog.length;
  const bad = async (id, over, status, code) => { const r = await pbGen(ownerD, id, over); assert.equal(r.status, status, JSON.stringify(r.json)); assert.equal(r.json.error, code); };
  await bad('nova', { mode: 'garment', outfit: 'a cream linen blouse' }, 400, 'FIELD_INVALID');                        // slot required
  await bad('nova', { mode: 'garment', slot: 'hat-trick', outfit: 'x' }, 400, 'FIELD_INVALID');
  await bad('nova', { mode: 'garment', slot: 'accessory', outfit: 'x' }, 400, 'FIELD_INVALID');
  await bad('nova', { mode: 'garment', slot: 'top' }, 400, 'FIELD_REQUIRED');
  await bad('seraphine', { mode: 'garment', slot: 'top', outfit: 'a silk blouse' }, 400, 'GARMENT_LAYERS_UNAVAILABLE'); // canvas only exists for Nova so far
  await bad('nova', { mode: 'garment', slot: 'top', outfit: 'a blouse for a 15 year old' }, 400, 'BLOCKED_MINOR_TERMS');
  assert.equal(mockLog.length, n, 'validation must fail before any provider call');
  await sleep(150);
  const j = await pbWait(ownerD, 'nova', { mode: 'garment', slot: 'top', outfit: 'a fitted cream linen blouse with rolled sleeves', scene: undefined });
  assert.equal(j.state, 'complete', JSON.stringify(j)); assert.ok(j.imageId);
  const sent = mockLog.at(-1); assert.equal(mockLog.length - n, 1);
  assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 1); assert.equal(sent.hasMask, true);   // ONLY the registration canvas + its edit mask: no face, no look
  assert.equal(sent.background, undefined); assert.equal(sent.size, '1024x1536');
  const other = await pbWait(ownerD, 'nova', { mode: 'scene', scene: 'Standing at a heavy wooden door at dusk, about to knock.' });
  assert.equal(other.state, 'complete'); assert.equal(mockLog.at(-1).hasMask, false);   // ordinary scenes never carry a mask
  const base = await ownerD('GET', '/api/prebuilt/nova/base'); assert.equal(base.status, 200); assert.equal(base.headers.get('content-type'), 'image/jpeg');
  assert.equal((await ownerD('GET', '/api/prebuilt/seraphine/base')).status, 404);          // only characters with a canvas
  assert.equal((await ownerD('GET', '/_refs/terra-nova/body.jpg')).status, 404);            // the raw references stay private
});

test('Telō made after onboarding: its own package, redos and accepted image, independent of the onboarding Telō and of other Telōs', async () => {
  await sleep(150);
  const before = (await cara('GET', '/api/me')).json.telo;
  assert.equal((await cara('GET', '/api/me?telo=wren-1')).json['telo~wren-1'].remaining, 2);          // its own free unit + redo
  assert.equal((await cara('POST', '/api/onboarding/telo~bad%20id/generate', body())).status, 404);   // only simple ids are accepted
  const n = mockLog.length;
  const j = await genWait(cara, 'telo~wren-1'); assert.equal(j.state, 'complete', JSON.stringify(j)); assert.ok(j.imageId && j.faceImageId);
  assert.equal(mockLog.length - n, 2);                                                               // full-length + face close-up, one unit
  const v = (await cara('GET', '/api/me?telo=wren-1')).json['telo~wren-1']; assert.equal(v.hasPackage, true); assert.equal(v.remaining, 1);
  assert.deepEqual((await cara('GET', '/api/me')).json.telo, before);                                 // onboarding Telō untouched
  await sleep(150);
  const dup = await gen(cara, 'telo~wren-1'); assert.equal(dup.status, 409, JSON.stringify(dup.json)); assert.equal(dup.json.error, 'PACKAGE_ALREADY_GENERATED');
  await sleep(150);
  const other = await genWait(cara, 'telo~sol-9'); assert.equal(other.state, 'complete');            // a different Telō gets its own package
  const acc = await cara('POST', '/api/onboarding/telo~wren-1/accept', { imageId: j.imageId, faceImageId: j.faceImageId }); assert.equal(acc.status, 200, JSON.stringify(acc.json));
  assert.equal(acc.json['telo~wren-1']?.acceptedImageId ?? (await cara('GET', '/api/me?telo=wren-1')).json['telo~wren-1'].acceptedImageId, j.imageId);
  assert.equal((await alice('GET', '/api/images/' + j.imageId)).status, 404);                        // images stay private to their owner
});

// ============ Echō images: Single Image / Collage (v136 integration) ============
const ea = (who) => as(who, E), eAlice = ea(ALICE), eBob = ea(BOB), eOwner = ea(OWNER);
const mlog = () => fetch(`http://127.0.0.1:${MOCK}/__log`).then((r) => r.json());
const quoteFor = async (api, over = {}) => { const r = await api('POST', '/api/echo/quote', { format: 'collage', panelCount: 4, showPanelNumbers: false, ...over }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const echoBody = (q, over = {}) => { const b = { prompt: 'Two friends walking through the village market at dusk', adultAttested: true, idempotencyKey: key(), quoteId: q.quoteId, format: 'collage', panelCount: 4, showPanelNumbers: false, world: 'TERRA', species: ['Human'], ...over }; if (b.format === 'single') { delete b.panelCount; delete b.showPanelNumbers; } return b; };
const echoGen = async (api, over = {}, qover = {}) => { await sleep(150); const q = await quoteFor(api, { ...(over.format === 'single' ? { format: 'single', panelCount: undefined } : {}), ...(over.panelCount ? { panelCount: over.panelCount } : {}), ...(over.showPanelNumbers !== undefined ? { showPanelNumbers: over.showPanelNumbers } : {}), ...qover }); const r = await api('POST', '/api/echo/generate', echoBody(q, over)); return { q, r }; };

test('echo: options expose the one style list, 4–9 counts, and who may use Low moderation', async () => {
  const a = (await eAlice('GET', '/api/echo/options')).json, b = (await eBob('GET', '/api/echo/options')).json, d = (await as(ALICE, D)('GET', '/api/echo/options')).json;
  assert.deepEqual(a.collageCounts, [4, 5, 6, 7, 8, 9]);
  assert.equal(a.styles.length, 12); assert.equal(a.styles[0].id, 'realism');
  for (const id of ['anime', 'cartoon', 'watercolor', 'comic', 'ghibli', 'oil', 'fantasy', 'cyberpunk', 'scifi', 'noir', 'pixel']) assert.ok(a.styles.some((s) => s.id === id), id);
  assert.deepEqual(a.rows['7'], [3, 2, 2]);
  assert.equal(a.pricing.collageConfigured, true); assert.equal(d.pricing.collageConfigured, false);
  assert.deepEqual([a.moderation.enabled, a.moderation.mode], [true, 'low']);          // allowlisted adult-beta tester: default Low
  assert.deepEqual([b.moderation.enabled, b.moderation.mode], [false, 'auto']);       // everyone else: Auto, switch hidden
  assert.deepEqual([(await eOwner('GET', '/api/echo/options')).json.moderation.mode], ['low']);
});

test('echo: Sköl quotes rise strictly from 4 to 9 panels, are one image use, never accept a browser price', async () => {
  let prev = 0;
  for (const n of [4, 5, 6, 7, 8, 9]) { const q = await quoteFor(eAlice, { panelCount: n }); assert.equal(q.usageUnits, 1); assert.equal(q.currency, 'Sköl'); assert.ok(q.amountSkol > prev, `n=${n}`); assert.equal(q.charged, false); prev = q.amountSkol; }
  assert.equal(prev, 400);
  assert.equal((await eAlice('POST', '/api/echo/quote', { format: 'collage', panelCount: 9, amountSkol: 1 })).status, 400);
  for (const n of [3, 10, '9', 4.5]) assert.equal((await eAlice('POST', '/api/echo/quote', { format: 'collage', panelCount: n })).json.error, 'FIELD_INVALID', String(n));
  assert.equal((await eAlice('POST', '/api/echo/quote', { format: 'single', panelCount: 5 })).status, 400);
  assert.equal((await eAlice('POST', '/api/echo/quote', { format: 'single' })).json.amountSkol, 20);       // Master 30.2: photo beyond credits
  const noLadder = await as(ALICE, D)('POST', '/api/echo/quote', { format: 'collage', panelCount: 4 });      // no ladder configured: fail closed, nothing invented
  assert.equal(noLadder.status, 503); assert.equal(noLadder.json.error, 'IMAGE_PRICING_UNAVAILABLE');
});

test('echo: a collage is ONE provider request (n=1) and ONE image use; quote is single-use and bound to count; replay is free', async () => {
  const sum0 = (await eOwner('GET', '/api/_admin/summary')).json.callsToday;
  assert.equal((await eAlice('POST', '/api/echo/generate', { prompt: 'x', adultAttested: true, idempotencyKey: key(), format: 'collage', panelCount: 4, world: 'TERRA', species: ['Human'] })).json.error, 'IMAGE_QUOTE_REQUIRED');
  const q6 = await quoteFor(eAlice, { panelCount: 6, showPanelNumbers: true });
  const wrong = await eAlice('POST', '/api/echo/generate', echoBody(q6, { panelCount: 9 }));
  assert.equal(wrong.status, 403); assert.equal(wrong.json.error, 'IMAGE_QUOTE_INVALID');
  assert.equal((await eAlice('POST', '/api/echo/generate', echoBody({ quoteId: 'forgedquoteid0000000' }, { panelCount: 6 }))).json.error, 'IMAGE_QUOTE_INVALID');
  const mismatch = await eAlice('POST', '/api/echo/generate', echoBody(q6, { panelCount: 6, showPanelNumbers: false }));       // quote is bound to the number preference too
  assert.equal(mismatch.json.error, 'IMAGE_QUOTE_INVALID');
  await sleep(150);
  const before = (await mlog()).length;
  const b = echoBody(q6, { panelCount: 6, showPanelNumbers: true, style: 'watercolor', world: 'SOLIS' });
  const r = await eAlice('POST', '/api/echo/generate', b);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const done = await wait(eAlice, r.json.id); assert.equal(done.state, 'complete');
  const log = (await mlog()).slice(before);
  assert.equal(log.length, 1, 'exactly one provider request for a 6-panel collage');
  assert.equal(log[0].n, 1); assert.equal(log[0].size, '1536x1024'); assert.equal(log[0].path, '/v1/images/generations');
  assert.match(log[0].prompt, /EXACTLY 6 DISTINCT story panels/); assert.match(log[0].prompt, /3, 3 panels/); assert.match(log[0].prompt, /NO printed panel numbers/);
  assert.match(log[0].prompt, /Watercolor painting/); assert.doesNotMatch(log[0].prompt, /Photorealistic candid/); assert.match(log[0].prompt, /Fire-stone and forge-craft/);
  const replay = await eAlice('POST', '/api/echo/generate', b); assert.equal(replay.json.replay, true); assert.equal((await mlog()).length, before + 1);   // replay: no new request
  assert.equal((await eAlice('POST', '/api/echo/generate', { ...b, idempotencyKey: key() })).json.error, 'IMAGE_QUOTE_INVALID');          // quote already used
  assert.equal((await eOwner('GET', '/api/_admin/summary')).json.callsToday - sum0, 1, 'one collage = one counted call');
  const img = (await eAlice('GET', '/api/echo/options')).json.images[0];
  assert.deepEqual([img.format, img.panelCount, img.showPanelNumbers, img.style, img.world], ['collage', 6, true, 'watercolor', 'SOLIS']);
  const bytes = await eAlice('GET', '/api/images/' + done.imageId); assert.equal(bytes.status, 200); assert.equal((await eBob('GET', '/api/images/' + done.imageId)).status, 404);   // private to its owner
});

test('echo: every style works for single and collage; default is realism; the user\'s style is used, not photorealism', async () => {
  const opts = (await eAlice('GET', '/api/echo/options')).json;
  for (const s of opts.styles.slice(1, 4)) {
    const before = (await mlog()).length;
    const { r } = await echoGen(eAlice, { style: s.id, format: 'single', aspect: 'square' }); assert.equal(r.status, 200, JSON.stringify(r.json)); await wait(eAlice, r.json.id);
    const l = (await mlog()).slice(before)[0]; assert.equal(l.size, '1024x1024'); assert.doesNotMatch(l.prompt, /Photorealistic, cinematic realism/, s.id);
  }
  const before = (await mlog()).length;
  const { r } = await echoGen(eAlice, { format: 'single' }); await wait(eAlice, r.json.id);       // no style given
  assert.match((await mlog()).slice(before)[0].prompt, /Photorealistic, cinematic realism/);
});

test('echo: refining keeps format, panel count and style; the original goes to the edits endpoint as a reference', async () => {
  const q = await quoteFor(eAlice, { panelCount: 5 });
  const r0 = await eAlice('POST', '/api/echo/generate', echoBody(q, { panelCount: 5, style: 'comic' })); const d0 = await wait(eAlice, r0.json.id);
  const rq = await quoteFor(eAlice, { refineOf: d0.imageId });
  assert.equal(rq.panelCount, 5); assert.equal(rq.format, 'collage');
  const before = (await mlog()).length;
  const r1 = await eAlice('POST', '/api/echo/generate', { prompt: 'Make the sky a deep violet', adultAttested: true, idempotencyKey: key(), quoteId: rq.quoteId, refineOf: d0.imageId, format: 'single', style: 'anime' });   // attempts to change format/style are ignored
  assert.equal(r1.status, 200, JSON.stringify(r1.json)); const d1 = await wait(eAlice, r1.json.id); assert.equal(d1.state, 'complete');
  const l = (await mlog()).slice(before)[0];
  assert.equal(l.path, '/v1/images/edits'); assert.equal(l.imageParts, 1); assert.match(l.prompt, /EXACTLY 5 DISTINCT story panels/); assert.match(l.prompt, /Comic book illustration/); assert.match(l.prompt, /REFINEMENT/);
  const imgs = (await eAlice('GET', '/api/echo/options')).json.images; const n = imgs.find((i) => i.id === d1.imageId);
  assert.deepEqual([n.panelCount, n.style, n.refinedFrom], [5, 'comic', d0.imageId]); assert.ok(imgs.some((i) => i.id === d0.imageId), 'original is kept for comparison');
});

test('echo: Low/Auto moderation is enforced server-side, persisted, and unavailable to non-testers', async () => {
  const mod = async (api) => { const before = (await mlog()).length; const { r } = await echoGen(api, { format: 'single' }); assert.equal(r.status, 200, JSON.stringify(r.json)); await wait(api, r.json.id); return (await mlog()).slice(before)[0].moderation; };
  assert.equal(await mod(eAlice), 'low');
  assert.equal((await eAlice('POST', '/api/echo/settings', { mode: 'auto' })).json.mode, 'auto');
  assert.equal((await eAlice('GET', '/api/echo/options')).json.moderation.mode, 'auto');       // persisted
  assert.equal(await mod(eAlice), 'auto');
  assert.equal((await eAlice('POST', '/api/echo/settings', { mode: 'low' })).json.mode, 'low');
  assert.equal(await mod(eAlice), 'low');
  assert.equal((await eAlice('POST', '/api/echo/settings', { mode: 'unrestricted' })).status, 400);
  const denied = await eBob('POST', '/api/echo/settings', { mode: 'low' }); assert.equal(denied.status, 403); assert.equal(denied.json.error, 'IMAGE_SETTING_NOT_ALLOWED');
  const q = await quoteFor(eBob); const before = (await mlog()).length;
  const r = await eBob('POST', '/api/echo/generate', echoBody(q, { moderation: 'low', moderationMode: 'low', surface: 'adult' })); await wait(eBob, r.json.id);        // forged fields are ignored
  assert.equal((await mlog()).slice(before)[0].moderation, 'auto');
});

test('echo: validation fails closed before any provider call or spend', async () => {
  const before = (await mlog()).length;
  const q = await quoteFor(eAlice);
  const bad = async (over, code, status = 400) => { const r = await eAlice('POST', '/api/echo/generate', echoBody(q, over)); assert.equal(r.status, status, JSON.stringify(over)); assert.equal(r.json.error, code, JSON.stringify(over)); };
  await bad({ adultAttested: false }, 'ADULT_ATTESTATION_REQUIRED');
  await bad({ prompt: 'a schoolgirl at the market' }, 'BLOCKED_MINOR_TERMS');
  await bad({ prompt: '' }, 'FIELD_INVALID');
  await bad({ refs: ['i:aaaaaaaa', 'i:bbbbbbbb', 'i:cccccccc', 'i:dddddddd'] }, 'FIELD_INVALID');
  await bad({ refs: ['i:doesnotexist1'] }, 'REF_IMAGE_NOT_FOUND', 404);
  await bad({ style: 'realism', world: 'NARNIA' }, 'FIELD_INVALID');
  await bad({ showPanelNumbers: 'yes' }, 'FIELD_INVALID');
  assert.equal((await mlog()).length, before);
  const ok = await eAlice('POST', '/api/echo/generate', echoBody(q)); assert.equal(ok.status, 200);   // the same quote is still good after failed validations
  await wait(eAlice, ok.json.id);
});

test('echo: reference photos need certification, are screened, private, usable as references, deletable', async () => {
  const png = makePng(64, 96, [30, 90, 160]);
  assert.equal((await eAlice('POST', '/api/echo/refs', png)).json.error, 'CERTIFICATION_REQUIRED');
  const up = await eAlice('POST', '/api/echo/refs', png, { 'x-certify': 'self' }); assert.equal(up.status, 200); const ref = up.json.ref;
  assert.ok((await eAlice('GET', '/api/echo/options')).json.refs.some((r) => r.ref === ref));
  assert.equal((await eBob('GET', `/api/echo/refs/${ref.slice(2)}/image`)).status, 404);
  const before = (await mlog()).length; const q = await quoteFor(eAlice, { panelCount: 4 });
  const r = await eAlice('POST', '/api/echo/generate', echoBody(q, { refs: [ref] })); assert.equal(r.status, 200, JSON.stringify(r.json)); await wait(eAlice, r.json.id);
  const l = (await mlog()).slice(before)[0]; assert.equal(l.path, '/v1/images/edits'); assert.equal(l.imageParts, 1);
  assert.equal((await eAlice('DELETE', `/api/echo/refs/${ref.slice(2)}`)).json.ok, true);
  assert.ok(!(await eAlice('GET', '/api/echo/options')).json.refs.some((r2) => r2.ref === ref));
});

test('echo: provider rejection fails the job, refunds the hold, and needs a NEW quote (no automatic paid retry)', async () => {
  const q = await quoteFor(eAlice); const before = (await mlog()).length;
  const r = await eAlice('POST', '/api/echo/generate', echoBody(q, { prompt: 'FORCE_400 market scene' }));
  const d = await wait(eAlice, r.json.id); assert.equal(d.state, 'failed'); assert.equal(d.refunded, true);
  assert.equal((await mlog()).length, before + 1);
  assert.equal((await eAlice('POST', '/api/echo/generate', echoBody(q, { prompt: 'again' }))).json.error, 'IMAGE_QUOTE_INVALID');
});

test('echo: captions and numbers are overlays saved beside the image, never in the art; limits enforced', async () => {
  const { r } = await echoGen(eAlice, { panelCount: 4 }); const d = await wait(eAlice, r.json.id);
  const before = (await eAlice('GET', '/api/images/' + d.imageId)).bytes;
  const ok = await eAlice('POST', '/api/echo/captions', { imageId: d.imageId, captions: ['Bonjour !', 'Ça va ?', '', 'À demain'], showPanelNumbers: true }); assert.equal(ok.status, 200);
  const img = ok.json.images.find((i) => i.id === d.imageId); assert.deepEqual(img.captions, ['Bonjour !', 'Ça va ?', '', 'À demain']); assert.equal(img.showPanelNumbers, true);
  assert.equal((await eAlice('POST', '/api/echo/captions', { imageId: d.imageId, captions: ['a', 'b', 'c', 'd', 'e'] })).status, 400);
  assert.deepEqual((await eAlice('GET', '/api/images/' + d.imageId)).bytes, before);
  assert.equal((await eAlice('DELETE', '/api/images/' + d.imageId)).json.ok, true);
});

test('echo: world must be chosen, compatible with the avatar AND every Telōsian shown, and the scene cannot name another world', async () => {
  const go = async (over) => { await sleep(150); const q = await quoteFor(eAlice, { format: 'single', panelCount: undefined }); return eAlice('POST', '/api/echo/generate', echoBody(q, { format: 'single', ...over })); };
  assert.equal((await go({ world: null })).status, 400);                                            // a world is required
  assert.equal((await go({ species: undefined })).json.error, 'WORLD_SPECIES_REQUIRED');
  assert.equal((await go({ species: ['Merfolk'], world: 'TERRA' })).status, 403);                    // Merfolk cannot enter TERRA
  assert.equal((await go({ species: ['Human', 'Merfolk'], world: 'UMBRA' })).status, 403);           // the Telōsian shown must be able to enter too
  assert.equal((await go({ species: ['Vampire'], world: 'TENEBRIS' })).status, 200);                // permitted
  assert.equal((await go({ prompt: 'A quiet street in UMBRA at night', world: 'TERRA' })).status, 400); // scene names a different world
});

test('echo: Maris Outpost and Solis skies are their own sub-tags; Solis never gets a dark night sky', async () => {
  const go = async (over) => { await sleep(150); const q = await quoteFor(eAlice, { format: 'single', panelCount: undefined }); const r = await eAlice('POST', '/api/echo/generate', echoBody(q, { format: 'single', ...over })); if (r.status === 200) await wait(eAlice, r.json.id); return r; };
  assert.equal((await go({ world: 'MARIS' })).json.error, 'SUBWORLD_REQUIRED');                         // Maris needs Outpost or Deep
  assert.equal((await go({ world: 'MARIS', subWorld: 'deep' })).status, 403);                          // a Human cannot be pictured in the Deep
  assert.equal((await go({ world: 'MARIS', subWorld: 'outpost' })).status, 200);
  assert.equal((await go({ world: 'MARIS', subWorld: 'deep', species: ['Merfolk'] })).status, 200);
  // Solis skies are chosen by the generator from the scene text, never by the user
  assert.equal((await go({ world: 'SOLIS', prompt: 'Two friends at the forge at midnight' })).status, 200);
  assert.equal((await go({ world: 'SOLIS', prompt: 'A trader crossing the polar ice at dusk' })).status, 200);
  assert.equal((await go({ world: 'SOLIS', prompt: 'A busy market at noon', subWorld: 'polar' })).status, 200);   // a forged sub-tag is ignored
  assert.equal((await go({ world: 'TERRA', prompt: 'A polar bear mural in the arctic night' })).status, 200);      // polar words in another world never give the polar sky
  assert.equal((await go({ world: 'SOLIS', prompt: 'A starry night sky over the forge' })).json.error, 'SOLIS_DARK_SKY');
  const all = (await mlog()).map((x) => x.prompt);
  const maris = all.filter((x) => /LOCK \(MARIS/.test(x)).join('\n');
  assert.match(maris, /MARIS \/ OUTPOST/); assert.match(maris, /glass geodesic domes/);
  const solis = all.filter((x) => /LOCK \(SOLIS/.test(x));
  assert.ok(solis.some((x) => /SOLIS \/ NIGHT/.test(x) && /midnight sun/.test(x)));
  assert.ok(!solis.some((x) => /SOLIS \/ POLAR/.test(x)));   // regional maps not uploaded: polar Solis does not exist yet, even when the scene says polar
  assert.ok(solis.some((x) => /SOLIS \/ DAY/.test(x) && /champagne-gold sky with a blue horizon/.test(x)));
  assert.ok(solis.filter((x) => /SOLIS \/ (DAY|NIGHT)/.test(x)).every((x) => /never used here/.test(x)));   // day and night prompts forbid the polar sky
  assert.ok(solis.every((x) => /NEVER HAS A DARK NIGHT SKY/.test(x)));
  const terra = all.filter((x) => /LOCK \(TERRA/.test(x)).join('\n');
  assert.ok(terra.length && !/burgundy|midnight sun|champagne/.test(terra));
});

test('echo: test Sköl allowance = 3 nine-panel collages per image window, charged on accept, refunded on failure, never negative', async () => {
  const w = as(ALICE, W), bw = as(BOB, W);
  const o = (await w('GET', '/api/echo/options')).json;
  assert.equal(o.wallet.cap, 1200); assert.equal(o.wallet.balance, 1200); assert.equal(o.pricing.charged, true); assert.ok(Date.parse(o.wallet.resetsAt) > Date.now() && Date.parse(o.wallet.resetsAt) <= Date.now() + 26 * 3600e3);
  const go = async (over, qover = {}) => { await sleep(150); const q = await quoteFor(w, { panelCount: 9, ...qover }); const r = await w('POST', '/api/echo/generate', echoBody(q, { panelCount: 9, ...over })); return { q, r }; };
  const g1 = await go({}); assert.equal(g1.q.charged, true); assert.equal(g1.q.balance, 1200); assert.equal(g1.q.balanceAfter, 800); assert.equal(g1.r.status, 200, JSON.stringify(g1.r.json)); await wait(w, g1.r.json.id);
  assert.equal((await w('GET', '/api/echo/options')).json.wallet.balance, 800);
  const g2 = await go({}); assert.equal(g2.r.status, 200); await wait(w, g2.r.json.id);
  const bf = await go({ prompt: 'FORCE_400 market scene' }); assert.equal(bf.r.status, 200); await wait(w, bf.r.json.id);          // fails -> refunded
  assert.equal((await w('GET', '/api/echo/options')).json.wallet.balance, 400);
  const g3 = await go({}); assert.equal(g3.r.status, 200); await wait(w, g3.r.json.id);
  const o3 = (await w('GET', '/api/echo/options')).json.wallet; assert.equal(o3.balance, 0);
  await sleep(150); const q4 = await w('POST', '/api/echo/quote', { format: 'collage', panelCount: 4, showPanelNumbers: false });
  assert.equal(q4.status, 402); assert.equal(q4.json.error, 'INSUFFICIENT_SKOL'); assert.equal(q4.json.balance, 0); assert.ok(q4.json.resetsAt);
  assert.equal((await w('POST', '/api/echo/quote', { format: 'single' })).json.error, 'INSUFFICIENT_SKOL');
  const ob = (await bw('GET', '/api/echo/options')).json.wallet; assert.equal(ob.balance, 1200);                                   // another account has its own allowance
});
