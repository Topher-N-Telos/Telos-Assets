import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, costFromUsage, evaluateLimits, hashParams, reservePerCall, containsMinorSignal, dayKey, monthKey } from '../../src/limits.mjs';
import { verifyAccessJwt, authenticate, AuthError, _resetJwksCache } from '../../src/auth.mjs';

const cfg = parseConfig({});
const base = { cfg, now: 1_000_000, count: 1, paused: false, paramsHash: 'h1', reserveUsd: 0.35,
  counters: { callsToday: 0, usdToday: 0, usdMonth: 0, queuedOrWorking: 0, lastSubmitAt: 0 }, recentBatches: [] };
const lim = (over) => evaluateLimits({ ...base, ...over, counters: { ...base.counters, ...(over?.counters || {}) } });

test('config: safe defaults, bad values fall back, low moderation and attestation default OFF', () => {
  assert.equal(cfg.maxUsdPerMonth, 8);
  assert.equal(cfg.allowLowModeration, false);
  assert.equal(cfg.ownerAdultAttested, false);
  const weird = parseConfig({ MAX_CALLS_PER_DAY: '-5', MAX_USD_PER_DAY: 'abc', MAX_BATCH: '99' });
  assert.equal(weird.maxCallsPerDay, 20); assert.equal(weird.maxUsdPerDay, 3); assert.equal(weird.maxBatch, 3);
  assert.equal(parseConfig({ ALLOW_LOW_MODERATION: 'TRUE' }).allowLowModeration, false); // exact 'true' only
  assert.equal(parseConfig({ GENERATION_ENABLED: 'false' }).generationEnabled, false);
});

test('limits: each guard trips with its own code', () => {
  assert.equal(lim({}).ok, true);
  assert.equal(lim({ paused: true }).code, 'GENERATION_PAUSED');
  assert.equal(lim({ count: 4 }).code, 'BATCH_SIZE_INVALID');
  assert.equal(lim({ count: 0 }).code, 'BATCH_SIZE_INVALID');
  const soon = lim({ counters: { lastSubmitAt: base.now - 1000 } });
  assert.equal(soon.code, 'TOO_SOON'); assert.equal(soon.retryAfterMs, 4000);
  assert.equal(lim({ counters: { queuedOrWorking: 3 } }).code, 'TOO_MANY_QUEUED');
  assert.equal(lim({ counters: { callsToday: 20 } }).code, 'DAILY_CALL_CAP');
  assert.equal(lim({ counters: { usdToday: 2.9 } }).code, 'DAILY_USD_CAP');
  assert.equal(lim({ counters: { usdMonth: 7.9 } }).code, 'MONTHLY_USD_CAP');
});

test('limits: identical batch within the window is refused unless explicitly allowed', () => {
  const recent = [{ hash: 'h1', ts: base.now - 10_000 }];
  assert.equal(lim({ recentBatches: recent }).code, 'DUPLICATE_RECENT');
  assert.equal(lim({ recentBatches: recent, allowDuplicate: true }).ok, true);
  assert.equal(lim({ recentBatches: [{ hash: 'h1', ts: base.now - 999_999 }] }).ok, true);
  assert.equal(lim({ recentBatches: [{ hash: 'other', ts: base.now - 10 }] }).ok, true);
});

test('limits: a batch is costed as a whole, not per call', () => {
  assert.equal(lim({ count: 3, counters: { usdToday: 2.0 } }).code, 'DAILY_USD_CAP'); // 2.0 + 3*0.35 > 3
  assert.equal(lim({ count: 3, counters: { callsToday: 18 } }).code, 'DAILY_CALL_CAP');
});

test('cost: computed from usage tokens; null when usage missing; reserve never below the floor', () => {
  const usd = costFromUsage({ input_tokens: 1200, output_tokens: 6000, input_tokens_details: { text_tokens: 400, image_tokens: 800 } }, cfg.rates);
  assert.equal(usd, Math.round(((400 * 5 + 800 * 8 + 6000 * 30) / 1e6) * 10000) / 10000);
  assert.equal(costFromUsage(null, cfg.rates), null);
  assert.equal(costFromUsage({ input_tokens: 5 }, cfg.rates), null);
  assert.equal(reservePerCall(cfg, 0.1), 0.35);
  assert.equal(reservePerCall(cfg, 0.5), 0.625);
  assert.equal(reservePerCall(cfg, undefined), 0.35);
});

test('hashParams is order-independent and sensitive to content', async () => {
  assert.equal(await hashParams({ a: 1, b: [1, 2], c: { x: 1, y: 2 } }), await hashParams({ c: { y: 2, x: 1 }, b: [1, 2], a: 1 }));
  assert.notEqual(await hashParams({ a: 1 }), await hashParams({ a: 2 }));
});

test('day/month keys follow the configured time zone', () => {
  const ts = Date.UTC(2026, 10, 15, 3, 30); // 03:30 UTC = 22:30 on the 14th in Detroit
  assert.equal(dayKey(ts, 'America/Detroit'), '2026-11-14');
  assert.equal(dayKey(ts, 'UTC'), '2026-11-15');
  assert.equal(monthKey(ts, 'America/Detroit'), '2026-11');
});

test('minor-signal heuristic blocks obvious terms and spares ordinary words', () => {
  for (const t of ['a young child', 'teen boy', '16 year old', '15yo', 'schoolgirl', 'toddler', 'loli', 'underage']) assert.equal(containsMinorSignal(t), true, t);
  for (const t of ['tall man in black briefs', 'boyfriend and girlfriend by the sea', 'he is 35 years old', 'kidney bean salad', '']) assert.equal(containsMinorSignal(t), false, t);
});

// ---------- Cloudflare Access JWT ----------
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function makeIdp() {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = async (payload, header = { alg: 'RS256', kid: 'k1' }, key = kp.privateKey) => {
    const input = `${enc(header)}.${enc(payload)}`;
    const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))).toString('base64url');
    return `${input}.${sig}`;
  };
  const fetchFn = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  return { sign, fetchFn, kp };
}
const NOW = Date.UTC(2026, 10, 15, 12);
const good = { iss: 'https://team.cloudflareaccess.com', aud: ['AUD123'], email: 'Owner@Example.com', exp: NOW / 1000 + 600, iat: NOW / 1000 };
const args = { teamDomain: 'team.cloudflareaccess.com', aud: 'AUD123', ownerEmail: 'owner@example.com', now: NOW };

test('access jwt: valid token for the owner passes (email compare is case-insensitive)', async () => {
  _resetJwksCache(); const { sign, fetchFn } = await makeIdp();
  assert.deepEqual(await verifyAccessJwt({ ...args, token: await sign(good), fetchFn }), { email: 'owner@example.com' });
});

test('access jwt: every wrong claim, bad signature, alg and config is refused', async () => {
  _resetJwksCache(); const { sign, fetchFn } = await makeIdp();
  const code = async (over, extra = {}) => verifyAccessJwt({ ...args, fetchFn, ...extra, token: await sign({ ...good, ...over }) }).then(() => 'OK', (e) => e.code);
  assert.equal(await code({ aud: ['OTHER'] }), 'BAD_AUDIENCE');
  assert.equal(await code({ iss: 'https://evil.example' }), 'BAD_ISSUER');
  assert.equal(await code({ exp: NOW / 1000 - 1 }), 'TOKEN_EXPIRED');
  assert.equal(await code({ exp: undefined }), 'TOKEN_EXPIRED');
  assert.equal(await code({ email: 'someone@else.com' }), 'NOT_OWNER');
  assert.equal(await code({ email: undefined }), 'NOT_OWNER');
  // signature made by a different key
  const other = await makeIdp();
  const forged = await other.sign(good);
  await assert.rejects(verifyAccessJwt({ ...args, fetchFn, token: forged }), { code: 'BAD_SIGNATURE' });
  // alg none / garbage / missing
  const none = `${enc({ alg: 'none', kid: 'k1' })}.${enc(good)}.`;
  await assert.rejects(verifyAccessJwt({ ...args, fetchFn, token: none }), { code: 'BAD_TOKEN' });
  await assert.rejects(verifyAccessJwt({ ...args, fetchFn, token: 'a.b' }), { code: 'NO_TOKEN' });
  await assert.rejects(verifyAccessJwt({ ...args, fetchFn, token: null }), { code: 'NO_TOKEN' });
  // fail closed when unconfigured
  for (const k of ['teamDomain', 'aud', 'ownerEmail']) {
    await assert.rejects(verifyAccessJwt({ ...args, [k]: '', fetchFn, token: await sign(good) }), { code: 'AUTH_NOT_CONFIGURED' });
  }
});

test('authenticate: dev bypass only on loopback host AND flag; never on a public hostname', async () => {
  const mk = (host, headers = {}) => new Request(`https://${host}/api/state`, { headers });
  const env = { DEV_BYPASS_AUTH: 'true', OWNER_EMAIL: 'owner@example.com' };
  assert.deepEqual(await authenticate(mk('localhost'), env), { email: 'owner@example.com' });
  await assert.rejects(authenticate(mk('telos.example.workers.dev'), env), (e) => e instanceof AuthError && e.code === 'AUTH_NOT_CONFIGURED');
  await assert.rejects(authenticate(mk('localhost'), { ...env, DEV_BYPASS_AUTH: 'false' }), { code: 'AUTH_NOT_CONFIGURED' });
});
