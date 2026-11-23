/**
 * Claude relay: POST /api/claude. The hosted app has no other way to reach Claude, because the page's CSP only allows
 * same-origin requests. The caller is already authenticated by the Worker (Access JWT + allowlist) and CSRF-checked.
 * Rules, each with a test:
 *  - The API key lives only in the Worker secret ANTHROPIC_API_KEY and is never sent to or readable by the browser.
 *  - The browser chooses only the system text, the messages and a token budget. The model is fixed by the Worker.
 *  - Sizes are capped; roles are limited to user/assistant; max_tokens is clamped.
 *  - Each account has a daily call cap (CLAUDE_DAILY_CAP, default 400) kept in that account's own Durable Object.
 *  - Failures return fixed codes, never raw upstream text.
 *  - CLAUDE_ENABLED = "false" switches the relay off.
 */
export const RELAY_LIMITS = Object.freeze({ system: 40000, message: 40000, messages: 60, total: 160000, maxTokens: 4096, defaultTokens: 1024, timeoutMs: 85000 });
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_DAILY_CAP = 400;

export class RelayError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

export function normalizeRelayBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RelayError(400, 'BODY_INVALID');
  const allowed = ['system', 'messages', 'max_tokens', 'model'];   // model is accepted from older clients but ignored
  if (Object.keys(b).some((k) => !allowed.includes(k))) throw new RelayError(400, 'FIELD_INVALID');
  const system = b.system === undefined ? '' : b.system;
  if (typeof system !== 'string' || system.length > RELAY_LIMITS.system) throw new RelayError(400, 'SYSTEM_INVALID');
  const msgs = b.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > RELAY_LIMITS.messages) throw new RelayError(400, 'MESSAGES_INVALID');
  let total = system.length;
  const messages = msgs.map((m) => {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.length || m.content.length > RELAY_LIMITS.message) throw new RelayError(400, 'MESSAGES_INVALID');
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > RELAY_LIMITS.total) throw new RelayError(413, 'REQUEST_TOO_LARGE');
  if (messages[0].role !== 'user') throw new RelayError(400, 'MESSAGES_INVALID');
  let maxTokens = b.max_tokens === undefined ? RELAY_LIMITS.defaultTokens : b.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new RelayError(400, 'MAX_TOKENS_INVALID');
  maxTokens = Math.min(maxTokens, RELAY_LIMITS.maxTokens);
  return { system, messages, maxTokens };
}

/** Returns { status, json }. `stub` is the caller's own UserState Durable Object (claudeTick enforces the daily cap). */
export async function relayClaude({ body, env, stub, fetchImpl = fetch }) {
  try {
    if (env.CLAUDE_ENABLED === 'false') throw new RelayError(503, 'CLAUDE_DISABLED');
    if (!env.ANTHROPIC_API_KEY) throw new RelayError(503, 'CLAUDE_NOT_CONFIGURED');
    const { system, messages, maxTokens } = normalizeRelayBody(body);
    const cap = Number.isInteger(Number(env.CLAUDE_DAILY_CAP)) && Number(env.CLAUDE_DAILY_CAP) > 0 ? Number(env.CLAUDE_DAILY_CAP) : DEFAULT_DAILY_CAP;
    const tick = await stub.claudeTick(cap);
    if (!tick || tick.ok !== true) throw new RelayError(429, 'CLAUDE_DAILY_CAP');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), RELAY_LIMITS.timeoutMs);
    let r;
    try {
      r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.CLAUDE_MODEL || DEFAULT_MODEL, max_tokens: maxTokens, ...(system ? { system } : {}), messages })
      });
    } catch { throw new RelayError(504, 'CLAUDE_TIMEOUT'); } finally { clearTimeout(timer); }
    if (r.status === 429 || r.status === 529) throw new RelayError(503, 'CLAUDE_BUSY');
    if (!r.ok) throw new RelayError(502, 'CLAUDE_UPSTREAM');
    const d = await r.json().catch(() => null);
    if (!d || !Array.isArray(d.content)) throw new RelayError(502, 'CLAUDE_UPSTREAM');
    return { status: 200, json: { content: d.content.filter((c) => c && c.type === 'text').map((c) => ({ type: 'text', text: String(c.text ?? '') })), stop_reason: d.stop_reason ?? null } };
  } catch (e) {
    if (e instanceof RelayError) return { status: e.status, json: { error: e.code } };
    return { status: 500, json: { error: 'CLAUDE_RELAY_ERROR' } };
  }
}
