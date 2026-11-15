/** End-to-end: REAL Worker + Durable Objects in local workerd, fake OpenAI. No network, no key, no spend. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-openai.mjs';
import { makePng } from './png.mjs';

const A = 'http://localhost:8787', B = 'http://localhost:8788', C = 'http://localhost:8789', MOCK = 8799;
let mock, procs = [];
const OWNER = 'owner@example.com', ALICE = 'alice@example.com', BOB = 'bob@example.com', EVE = 'eve@example.com';
const BASE = { OWNER_EMAIL: OWNER, ALLOWED_EMAILS: `${ALICE},${BOB}`, DEV_BYPASS_AUTH: 'true', OPENAI_API_BASE: `http://127.0.0.1:${MOCK}/v1`, OPENAI_API_KEY: 'mock-key', MIN_SUBMIT_INTERVAL_MS: 100 };

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
    launch(8787, BASE),
    launch(8788, {}),                                                                   // no auth config at all
    launch(8789, { ...BASE, MAX_USD_PER_DAY: 0.45, EST_USD_PER_CALL: 0.1 })           // tiny global cap
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
const gen = async (api, kind, over) => { const r = await api('POST', `/api/onboarding/${kind}/generate`, body(over)); return r; };
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
  const r = await fetch(A + '/', { headers: { 'x-dev-email': ALICE } }); const html = await r.text();
  const csp = r.headers.get('content-security-policy'); const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)[1];
  assert.ok(html.includes(`nonce="${nonce}"`)); assert.ok(!html.includes('__NONCE__')); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(A + '/api/me/purge', { method: 'POST', body: '{}', headers: { 'x-dev-email': ALICE } })).status, 403);
  assert.equal((await fetch(A + '/api/me/purge', { method: 'POST', body: '{}', headers: { 'x-dev-email': ALICE, 'x-telos': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await alice('GET', '/api/_admin/summary')).status, 403);
  assert.equal((await alice('POST', '/api/_admin/pause', { paused: true })).status, 403);
  assert.equal((await alice('POST', `/api/_admin/user/${ALICE}/allowance`, { kind: 'avatar', extra: 5 })).status, 403);
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
  await wait(bob, r1.json.id); assert.equal(mockLog.length - n, 1);
  assert.equal((await bob('GET', '/api/me')).json.telo.remaining, 1);
});

test('provider rejection refunds the free try (FORCE_400)', async () => {
  await sleep(150);
  const before = (await bob('GET', '/api/me')).json.telo.remaining;
  const r = await gen(bob, 'telo', { fields: { description: 'FORCE_400 a man by the sea' } }); assert.equal(r.status, 200);
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
  assert.equal((await alice('POST', '/api/onboarding/avatar/generate', body({ photoIds: [u1.json.id] }))).status, 404);
  await sleep(150);
  const r = await bob('POST', '/api/onboarding/avatar/generate', body({ photoIds: [u1.json.id, u2.json.id] })); assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = await wait(bob, r.json.id); assert.equal(j.state, 'complete', JSON.stringify(j));
  const sent = mockLog.at(-1); assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 2);
  assert.equal((await bob('POST', `/api/onboarding/avatar/accept`, { imageId: 'nope' })).status, 404);
  const acc = await bob('POST', `/api/onboarding/avatar/accept`, { imageId: j.imageId }); assert.equal(acc.json.avatar.acceptedImageId, j.imageId);
  assert.equal((await bob('GET', `/api/uploads/${u1.json.id}/image`)).status, 404);           // photos deleted on accept
  assert.equal((await bob('GET', '/api/me')).json.uploads.length, 0);
  assert.equal((await bob('POST', '/api/onboarding/avatar/generate', body())).json.error, 'ALREADY_ACCEPTED');
});

test('Telō imported-character references (14B.1A): rights certification, separate from avatar photos, edits endpoint, accept clears only telo refs', async () => {
  await sleep(150);
  const png = makePng(64, 96, [40, 60, 90]);
  const r1 = await alice('POST', '/api/uploads', png, { 'x-certify': 'rights' }); assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const av = await alice('POST', '/api/uploads', png, { 'x-certify': 'self' }); assert.equal(av.status, 200);
  assert.equal((await alice('POST', '/api/onboarding/avatar/generate', body({ photoIds: [r1.json.id] }))).json.error, 'PHOTO_WRONG_PURPOSE');
  assert.equal((await alice('POST', '/api/onboarding/telo/generate', body({ photoIds: [av.json.id] }))).json.error, 'PHOTO_WRONG_PURPOSE');
  const g = await alice('POST', '/api/onboarding/telo/generate', body({ photoIds: [r1.json.id] })); assert.equal(g.status, 200, JSON.stringify(g.json));
  const j = await wait(alice, g.json.id); assert.equal(j.state, 'complete', JSON.stringify(j));
  const sent = mockLog.at(-1); assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.imageParts, 1);
  await alice('POST', '/api/onboarding/telo/accept', { imageId: j.imageId });
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
    const a = await owner('POST', '/api/onboarding/avatar/accept', { imageId: j.imageId }); assert.equal(a.status, 200); }
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
