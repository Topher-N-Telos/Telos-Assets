import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOnboarding, containsMinorSignal, sniffImage, costFromUsage, parseConfig, firstNumber } from '../../src/common.mjs';
import { verifyAccessJwt, parseEmails, authenticate } from '../../src/auth.mjs';

const ok = { fields: { description: 'a man', apparentAge: '30' }, adultAttested: true, idempotencyKey: 'k'.repeat(20) };
test('normalize: valid, and every fail-closed adult rule', () => {
  assert.equal(normalizeOnboarding('avatar', ok).kind, 'avatar');
  assert.throws(() => normalizeOnboarding('avatar', { ...ok, adultAttested: false }), /ADULT_ATTESTATION_REQUIRED/);
  assert.throws(() => normalizeOnboarding('avatar', { ...ok, fields: { ...ok.fields, apparentAge: '16' } }), /CHARACTER_AGE_NOT_ADULT/);
  assert.throws(() => normalizeOnboarding('avatar', { ...ok, fields: { description: 'a man' } }), /FIELD_REQUIRED/);
  assert.throws(() => normalizeOnboarding('avatar', { ...ok, fields: { ...ok.fields, description: 'a young child' } }), /BLOCKED_MINOR_TERMS/);
  assert.throws(() => normalizeOnboarding('avatar', { ...ok, idempotencyKey: 'short' }), /FIELD_INVALID/);
  assert.throws(() => normalizeOnboarding('x', ok), /NOT_FOUND/);
  assert.deepEqual(normalizeOnboarding('telo', { ...ok, photoIds: ['abcdefgh'] }).photoIds, ['abcdefgh']);   // 14B.1A
});
test('helpers', () => {
  assert.ok(containsMinorSignal('a 12 year old')); assert.ok(!containsMinorSignal('a grown man'));
  assert.equal(firstNumber('early 30s'), 30);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), 'image/png');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=1>......')), null);
  const r = parseConfig({}).rates;
  assert.equal(costFromUsage({ output_tokens: 1000000 }, r), 30);
  assert.equal(costFromUsage(null, r), null);
  assert.equal(parseConfig({ MAX_USD_PER_DAY: 'abc' }).maxUsdPerDay, 2);
  assert.equal(parseConfig({ ONBOARDING_QUALITY: 'ultra' }).quality, 'high');
});
test('auth fails closed and allowlist parsing', async () => {
  assert.deepEqual([...parseEmails('A@x.com, b@y.com;bad')], ['a@x.com', 'b@y.com']);
  await assert.rejects(verifyAccessJwt({ token: 'a.b.c', teamDomain: '', aud: '', ownerEmail: '', allowedEmails: '' }), { code: 'AUTH_NOT_CONFIGURED' });
  await assert.rejects(verifyAccessJwt({ token: 'junk', teamDomain: 't.example', aud: 'x', ownerEmail: 'o@x.com' }), { code: 'NO_TOKEN' });
  await assert.rejects(authenticate(new Request('https://x.workers.dev/api/me', { headers: { 'x-dev-email': 'o@x.com' } }), { DEV_BYPASS_AUTH: 'true', OWNER_EMAIL: 'o@x.com' }), { code: 'AUTH_NOT_CONFIGURED' }); // bypass refused off loopback
});
