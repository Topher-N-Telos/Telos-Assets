import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelayBody, relayClaude, RELAY_LIMITS } from '../../src/claude-relay.mjs';

const okBody = { system: 'You are a scribe.', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 200 };
const stubOk = { claudeTick: async () => ({ ok: true }) };
const upstream = (status, json) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const env = { ANTHROPIC_API_KEY: 'sk-test' };

test('valid body is normalized and max_tokens clamped', () => {
  const n = normalizeRelayBody({ ...okBody, max_tokens: 999999, model: 'whatever' });
  assert.equal(n.maxTokens, RELAY_LIMITS.maxTokens);
  assert.deepEqual(n.messages, okBody.messages);
});
test('unknown fields, bad roles, empty and oversized input are rejected', () => {
  for (const bad of [{ ...okBody, tools: [] }, { ...okBody, messages: [{ role: 'system', content: 'x' }] }, { ...okBody, messages: [] },
    { ...okBody, messages: [{ role: 'assistant', content: 'x' }] }, { ...okBody, system: 'x'.repeat(RELAY_LIMITS.system + 1) },
    { ...okBody, max_tokens: 0 }, null, [], { ...okBody, messages: [{ role: 'user', content: 'x'.repeat(RELAY_LIMITS.message + 1) }] }]) {
    assert.throws(() => normalizeRelayBody(bad));
  }
});
test('key and model: model is fixed by the Worker, key goes only upstream', async () => {
  let seen;
  const r = await relayClaude({ body: { ...okBody, model: 'attacker-model' }, env: { ...env, CLAUDE_MODEL: 'claude-test' }, stub: stubOk,
    fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use' }], stop_reason: 'end_turn', usage: { secret: 1 } }) }; } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' });
  assert.equal(seen.u, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.o.headers['x-api-key'], 'sk-test');
  assert.equal(JSON.parse(seen.o.body).model, 'claude-test');
});
test('not configured, disabled, daily cap, upstream errors use fixed codes', async () => {
  assert.equal((await relayClaude({ body: okBody, env: {}, stub: stubOk })).json.error, 'CLAUDE_NOT_CONFIGURED');
  assert.equal((await relayClaude({ body: okBody, env: { ...env, CLAUDE_ENABLED: 'false' }, stub: stubOk })).json.error, 'CLAUDE_DISABLED');
  const capped = await relayClaude({ body: okBody, env, stub: { claudeTick: async () => ({ ok: false }) }, fetchImpl: upstream(200, {}) });
  assert.deepEqual([capped.status, capped.json.error], [429, 'CLAUDE_DAILY_CAP']);
  const busy = await relayClaude({ body: okBody, env, stub: stubOk, fetchImpl: upstream(429, { error: 'secret detail' }) });
  assert.deepEqual([busy.status, busy.json], [503, { error: 'CLAUDE_BUSY' }]);
  const bad = await relayClaude({ body: okBody, env, stub: stubOk, fetchImpl: upstream(500, { error: 'secret detail' }) });
  assert.deepEqual([bad.status, bad.json], [502, { error: 'CLAUDE_UPSTREAM' }]);
  const down = await relayClaude({ body: okBody, env, stub: stubOk, fetchImpl: async () => { throw new Error('boom sk-test'); } });
  assert.deepEqual([down.status, down.json], [504, { error: 'CLAUDE_TIMEOUT' }]);
});
test('an invalid request does not use up the daily allowance', async () => {
  let ticks = 0;
  const r = await relayClaude({ body: { messages: [] }, env, stub: { claudeTick: async () => { ticks++; return { ok: true }; } } });
  assert.equal(r.status, 400); assert.equal(ticks, 0);
});
