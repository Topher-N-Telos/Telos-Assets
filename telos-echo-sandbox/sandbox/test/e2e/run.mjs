/**
 * End-to-end test against the REAL Worker + Durable Object running in local workerd (wrangler dev --local),
 * with a local mock standing in for OpenAI. No network, no real key, no spend.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-openai.mjs';
import { makePng } from './png.mjs';

const A = 'http://localhost:8787', B = 'http://localhost:8788', MOCK = 8799;
let mock, procs = [];

function launch(port, vars) {
  const args = ['wrangler', 'dev', '--local', '--port', String(port), '--persist-to', mkdtempSync(join(tmpdir(), 'telos-e2e-')), '--inspector-port', String(port + 100)];
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
    launch(8787, { DEV_BYPASS_AUTH: 'true', OWNER_EMAIL: 'owner@example.com', OPENAI_API_BASE: `http://127.0.0.1:${MOCK}/v1`, OPENAI_API_KEY: 'mock-key',
      MIN_SUBMIT_INTERVAL_MS: 200, MAX_CALLS_PER_DAY: 11, MAX_QUEUED: 5, ALLOW_LOW_MODERATION: 'true', OWNER_ADULT_ATTESTED: 'true' }),
    launch(8788, {}) // secured: no auth configuration at all
  ]);
});
after(async () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
  mock?.server.close();
});

const call = async (base, method, path, body, headers = {}) => {
  const opt = { method, headers: { 'x-sandbox': '1', ...headers } };
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) opt.body = body;
  else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(base + path, opt);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, json: ct.includes('json') ? await r.json() : null, bytes: ct.includes('json') || ct.includes('text') ? null : Buffer.from(await r.arrayBuffer()), text: ct.includes('text') ? await r.text() : null };
};
const api = (m, p, b) => call(A, m, p, b);
const ok = async (m, p, b) => { const r = await api(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const wait = async (batchId, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const b = await ok('GET', '/api/batches/' + batchId);
    if (b.jobs.every((j) => ['complete', 'failed', 'cancelled'].includes(j.state))) return b;
    if (Date.now() > end) throw new Error('batch timeout ' + JSON.stringify(b.jobs));
    await new Promise((r) => setTimeout(r, 250));
  }
};
const baseParams = (ids, over = {}) => ({ characterIds: ids, sceneText: 'Two men talk on a coastal balcony at dusk.', worldText: 'Amber coastal architecture.', artDirection: 'warm natural light', label: 'balcony', garmentType: 'brief', condition: 'dry', ...over });
const gen = async (params) => { const q = await ok('POST', '/api/quote', { params }); assert.equal(q.preflight.ok, true, JSON.stringify(q.preflight)); return { q, g: await ok('POST', '/api/generate', { quoteId: q.quoteId, confirm: true }) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = {};
test('secured instance refuses everything without Cloudflare Access (fails closed)', async () => {
  for (const p of ['/', '/api/state', '/api/images/abc', '/api/export.csv']) {
    const r = await call(B, 'GET', p);
    assert.equal(r.status, 503, p); assert.equal(r.json.error, 'AUTH_NOT_CONFIGURED');
  }
  const forged = await call(B, 'GET', '/api/state', undefined, { 'Cf-Access-Jwt-Assertion': 'a.b.c' });
  assert.equal(forged.status, 503);
});

test('page: CSP nonce, no leftover placeholder, hardened headers; API: CSRF guard', async () => {
  const r = await fetch(A + '/'); const html = await r.text();
  const csp = r.headers.get('content-security-policy');
  const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)[1];
  assert.ok(html.includes(`nonce="${nonce}"`)); assert.ok(!html.includes('__NONCE__'));
  assert.match(csp, /default-src 'none'/); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await fetch(A + '/api/pause', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(A + '/api/pause', { method: 'POST', body: '{}', headers: { 'x-sandbox': '1', origin: 'https://evil.example' } })).status, 403);
});

test('characters, references (magic-byte checked, chunk-exact), minor/age guards', async () => {
  const oryn = await ok('POST', '/api/characters', { name: 'Oryn', adultAttested: true, canon: { apparentAge: 'mid-30s', skinTone: 'warm brown', bodyHair: 'dense, natural', facialHair: null } });
  const pnigo = await ok('POST', '/api/characters', { name: 'Pnígo', adultAttested: true, canon: { apparentAge: 'early 30s', skinTone: 'deep umber' } });
  ctx.oryn = oryn.id; ctx.pnigo = pnigo.id;
  const face = makePng(64, 96, [10, 20, 30]), body = makePng(64, 96, [30, 20, 10]);
  for (const [b, role] of [[face, 'face'], [body, 'body']]) {
    const r = await call(A, 'POST', `/api/refs?characterId=${ctx.oryn}&role=${role}&label=test`, b);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal((await call(A, 'POST', `/api/refs?characterId=${ctx.oryn}&role=face`, Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.equal((await call(A, 'POST', `/api/refs?characterId=${ctx.oryn}&role=face`, Buffer.from('GIF89a......'))).status, 415);
  // big PNG crosses the 900 KB chunk boundary: bytes must round-trip identically
  const big = makePng(32, 48, [1, 2, 3], 2_500_000);
  const w = await call(A, 'POST', '/api/refs?world=1&role=other&label=balcony', big); assert.equal(w.status, 200);
  const back = await call(A, 'GET', `/api/refs/${w.json.id}/image`);
  assert.equal(createHash('sha256').update(back.bytes).digest('hex'), createHash('sha256').update(big).digest('hex'));
  ctx.worldRef = w.json.id;
  // reference limit per character
  await call(A, 'POST', `/api/refs?characterId=${ctx.oryn}&role=other`, makePng());
  assert.equal((await call(A, 'POST', `/api/refs?characterId=${ctx.oryn}&role=other`, makePng())).json.error, 'TOO_MANY_REFERENCES');
  // minors / unattested characters
  assert.equal((await api('POST', '/api/characters', { name: 'Kid', canon: { apparentAge: '15 year old' } })).json.error, 'BLOCKED_MINOR_TERMS');
  const noAge = await ok('POST', '/api/characters', { name: 'NoAge', adultAttested: true, canon: {} });
  const unatt = await ok('POST', '/api/characters', { name: 'Unattested', adultAttested: false, canon: { apparentAge: '40s' } });
  assert.equal((await api('POST', '/api/quote', { params: baseParams([noAge.id]) })).json.error, 'CHARACTER_AGE_NOT_ATTESTED');
  assert.equal((await api('POST', '/api/quote', { params: baseParams([unatt.id]) })).json.error, 'CHARACTER_AGE_NOT_ATTESTED');
  await api('DELETE', '/api/characters/' + noAge.id); await api('DELETE', '/api/characters/' + unatt.id);
  assert.equal((await api('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'a teenage boy on a balcony' }) })).json.error, 'BLOCKED_MINOR_TERMS');
  assert.equal((await api('POST', '/api/quote', { params: baseParams([ctx.oryn], { model: 'gpt-4o' }) })).json.error, 'MODEL_NOT_ALLOWED');
});

test('generate with references: edits endpoint, auto moderation, wallet + usage recorded, idempotent replay', async () => {
  const s0 = await ok('GET', '/api/state'); assert.equal(s0.wallet.available, 1000); assert.equal(s0.config.keyConfigured, true);
  const params = baseParams([ctx.oryn, ctx.pnigo], { worldRefIds: [ctx.worldRef], outfits: { [ctx.oryn]: 'charcoal opaque briefs' } });
  const q = await ok('POST', '/api/quote', { params });
  assert.equal(q.amountSkol, 20); assert.equal(q.endpoint, 'edits'); assert.equal(q.referenceCount, 4); // Oryn x3 + environment x1
  assert.ok(q.warnings.includes('NO_REFERENCE_FOR:Pnígo'));
  assert.equal((await api('POST', '/api/generate', { quoteId: q.quoteId })).json.error, 'PRICE_CONFIRMATION_REQUIRED');
  const g = await ok('POST', '/api/generate', { quoteId: q.quoteId, confirm: true });
  const b = await wait(g.batchId);
  assert.equal(b.jobs[0].state, 'complete', JSON.stringify(b.jobs));
  const sent = mockLog.at(-1);
  assert.equal(sent.path, '/v1/images/edits'); assert.equal(sent.moderation, 'auto'); assert.equal(sent.model, 'gpt-image-2.6-sunburst');
  assert.equal(sent.imageParts, 4); assert.equal(sent.quality, 'high'); assert.equal(sent.size, '1024x1536'); assert.equal(sent.hasSafetyId, false);
  const s1 = await ok('GET', '/api/state');
  assert.equal(s1.wallet.available, 980); assert.equal(s1.wallet.held, 0);
  assert.ok(s1.counters.usdToday > 0.19 && s1.counters.usdToday < 0.21, String(s1.counters.usdToday));
  const img = await api('GET', '/api/images/' + b.jobs[0].image_id);
  assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(img.bytes[1], 0x50); assert.match(img.headers.get('cache-control'), /no-store/);
  // replay: same quote, no new provider call, no new charge
  const calls = mockLog.length;
  const again = await ok('POST', '/api/generate', { quoteId: q.quoteId, confirm: true });
  assert.equal(again.replay, true); await sleep(500); assert.equal(mockLog.length, calls);
  assert.equal((await ok('GET', '/api/state')).wallet.available, 980);
  ctx.firstImage = b.jobs[0].image_id; ctx.firstParams = params;
});

test('identical request is blocked as a duplicate unless explicitly allowed', async () => {
  await sleep(300);
  const q = await ok('POST', '/api/quote', { params: ctx.firstParams });
  assert.equal(q.preflight.code, 'DUPLICATE_RECENT');
  const r = await api('POST', '/api/generate', { quoteId: q.quoteId, confirm: true });
  assert.equal(r.status, 429); assert.equal(r.json.error, 'DUPLICATE_RECENT');
});

test('rate guard: submitting again immediately is refused', async () => {
  const p1 = baseParams([ctx.oryn], { sceneText: 'Oryn reads on the terrace.' });
  const { g } = await gen(p1); await wait(g.batchId);
  const q = await ok('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'Oryn pours tea.' }) });
  await ok('POST', '/api/generate', { quoteId: q.quoteId, confirm: true }).then(async (r) => wait(r.batchId));
  // two submits <200ms apart: second is TOO_SOON
  await sleep(250);
  const qa = await ok('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'Oryn walks the shore A.' }) });
  const qb = await ok('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'Oryn walks the shore B.' }) });
  const [ra, rb] = [await api('POST', '/api/generate', { quoteId: qa.quoteId, confirm: true }), await api('POST', '/api/generate', { quoteId: qb.quoteId, confirm: true })];
  assert.deepEqual([ra.status, rb.status].sort(), [200, 429].sort()); assert.equal(rb.json.error, 'TOO_SOON');
  await wait(qa.quoteId);
  ctx.callsSoFar = 4;
});

test('provider failure: job fails, hold released, no image, private diagnostics available, key never leaks', async () => {
  await sleep(300);
  const before = (await ok('GET', '/api/state')).wallet;
  const { g } = await gen(baseParams([ctx.oryn], { sceneText: 'FORCE_400 scene on a balcony', label: 'fail' }));
  const b = await wait(g.batchId);
  assert.equal(b.jobs[0].state, 'failed'); assert.equal(b.jobs[0].failure, 'IMAGE_PROVIDER_HTTP_400'); assert.equal(b.jobs[0].image_id, null);
  const after = (await ok('GET', '/api/state')).wallet;
  assert.equal(after.available, before.available); assert.equal(after.held, 0);
  const d = await ok('GET', `/api/jobs/${b.jobs[0].id}/diag`); assert.match(d.detail, /moderation_blocked/);
  for (const p of ['/api/state', '/api/batches', '/api/gallery', '/api/export.csv', `/api/jobs/${b.jobs[0].id}/diag`]) {
    const r = await fetch(A + p); assert.ok(!(await r.text()).includes('mock-key'), p);
  }
  assert.equal(mockLog.filter((e) => e.path.includes('FORCE')).length, 0);
});

test('batch of 3 repeats: three calls, three images, wallet charged per image', async () => {
  await sleep(300);
  const before = (await ok('GET', '/api/state')).wallet.available;
  const n = mockLog.length;
  const { g } = await gen(baseParams([ctx.oryn, ctx.pnigo], { count: 3, label: 'repeat-brief', sceneText: 'Both men on the balcony, repeat test.' }));
  const b = await wait(g.batchId);
  assert.deepEqual(b.jobs.map((j) => j.state), ['complete', 'complete', 'complete']);
  assert.equal(mockLog.length - n, 3);
  assert.equal((await ok('GET', '/api/state')).wallet.available, before - 60);
  ctx.repeat = b.jobs.map((j) => j.image_id);
});

test('text-only generation uses the generations endpoint', async () => {
  await sleep(300);
  const solo = await ok('POST', '/api/characters', { name: 'Solo', adultAttested: true, canon: { apparentAge: '50s' } });
  const { g } = await gen(baseParams([solo.id], { sceneText: 'Solo at dawn.' })); const b = await wait(g.batchId);
  assert.equal(b.jobs[0].state, 'complete'); assert.equal(mockLog.at(-1).path, '/v1/images/generations'); assert.equal(mockLog.at(-1).imageParts, 0);
});

test('moderation: low only on adult surface by explicit choice; adult surface alone stays auto', async () => {
  await sleep(300);
  assert.equal((await api('POST', '/api/quote', { params: baseParams([ctx.oryn], { moderation: 'low' }) })).json.error, 'LOW_MODERATION_NOT_ALLOWED');
  const a1 = await gen(baseParams([ctx.oryn], { surface: 'adult', sceneText: 'Adult surface, auto.' })); await wait(a1.g.batchId);
  assert.equal(mockLog.at(-1).moderation, 'auto');
  await sleep(300);
  const a2 = await gen(baseParams([ctx.oryn], { surface: 'adult', moderation: 'low', sceneText: 'Adult surface, low.' })); await wait(a2.g.batchId);
  assert.equal(mockLog.at(-1).moderation, 'low');
});

test('daily call cap stops further generation (cap = 11 in this run)', async () => {
  await sleep(300);
  const q = await ok('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'One too many.' }) });
  assert.equal(q.preflight.code, 'DAILY_CALL_CAP');
  assert.equal((await api('POST', '/api/generate', { quoteId: q.quoteId, confirm: true })).json.error, 'DAILY_CALL_CAP');
});

test('pause switch blocks generation and can be lifted', async () => {
  await ok('POST', '/api/pause', { paused: true });
  const q = await ok('POST', '/api/quote', { params: baseParams([ctx.oryn], { sceneText: 'Paused.' }) });
  assert.equal(q.preflight.code, 'GENERATION_PAUSED');
  assert.equal((await api('POST', '/api/generate', { quoteId: q.quoteId, confirm: true })).json.error, 'GENERATION_PAUSED');
  await ok('POST', '/api/pause', { paused: false });
});

test('scoring, repeat-consistency report, CSV export (formula-safe), delete, purge', async () => {
  const sc = [[5, 5, 4], [4, 5, 2], [2, 4, 3]];
  for (const [i, id] of ctx.repeat.entries()) await ok('POST', `/api/images/${id}/score`, { identity: sc[i][0], anatomy: sc[i][1], fabric: sc[i][2], notes: i === 0 ? '=HYPERLINK("x")' : 'ok' });
  assert.equal((await api('POST', `/api/images/${ctx.repeat[0]}/score`, { identity: 9 })).status, 400);
  const rep = await ok('GET', '/api/report');
  const g = rep.byRepeatGroup.find((x) => x.n === 3); assert.ok(g, JSON.stringify(rep.byRepeatGroup));
  assert.deepEqual(g.identity, { avg: 3.67, min: 2, max: 5 }); assert.deepEqual(g.fabric, { avg: 3, min: 2, max: 4 });
  assert.ok(rep.byGarment.some((x) => x.key.startsWith('brief / dry')));
  const csv = await (await fetch(A + '/api/export.csv')).text();
  assert.ok(csv.startsWith('image_id,created,label')); assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`)); assert.ok(!/,=HYPERLINK/.test(csv));
  const gal = await ok('GET', '/api/gallery'); assert.ok(gal.length >= 8); assert.ok(gal.every((x) => x.refIds));
  await ok('DELETE', '/api/images/' + ctx.repeat[2]); assert.equal((await api('GET', '/api/images/' + ctx.repeat[2])).status, 404);
  assert.equal((await api('POST', '/api/purge', { confirm: 'nope' })).status, 400);
  await ok('POST', '/api/purge', { confirm: 'DELETE EVERYTHING' });
  const s = await ok('GET', '/api/state'); assert.equal(s.characters.length, 0); assert.equal((await ok('GET', '/api/gallery')).length, 0);
  assert.equal((await api('GET', '/api/images/' + ctx.firstImage)).status, 404);
});
