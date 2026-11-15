/**
 * Pure logic: config parsing, cost estimation, and the guards against repeated/accidental/expensive
 * generation. No I/O, so it is unit-tested directly. Spend figures are ESTIMATES; the OpenAI
 * dashboard (and the project's hard $10/month limit) is the source of truth.
 */
export const DEFAULTS = Object.freeze({
  maxCallsPerDay: 20,
  maxUsdPerDay: 3,
  maxUsdPerMonth: 8,        // stop well before the project's $10 hard limit
  estUsdPerCall: 0.35,      // conservative reservation until real usage is observed
  minSubmitIntervalMs: 5000,
  maxQueued: 3,
  maxBatch: 3,
  duplicateWindowMs: 120000,
  skolPerImage: 20,         // stand-in only; matches Master 12.3 "standard moment" price, no real charge
  startingSkol: 1000,
  // USD per 1M tokens. Image output ($30) is on the model page; the input rates are UNVERIFIED for 2.6.
  rates: { textIn: 5, imageIn: 8, imageOut: 30 },
  timeZone: 'America/Detroit'
});

function num(v, fallback, { min = 0, max = Infinity, int = false } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) return fallback;
  return n;
}

export function parseConfig(env = {}) {
  const d = DEFAULTS;
  return {
    maxCallsPerDay: num(env.MAX_CALLS_PER_DAY, d.maxCallsPerDay, { min: 1, max: 500, int: true }),
    maxUsdPerDay: num(env.MAX_USD_PER_DAY, d.maxUsdPerDay, { min: 0.1, max: 50 }),
    maxUsdPerMonth: num(env.MAX_USD_PER_MONTH, d.maxUsdPerMonth, { min: 0.1, max: 500 }),
    estUsdPerCall: num(env.EST_USD_PER_CALL, d.estUsdPerCall, { min: 0.01, max: 5 }),
    minSubmitIntervalMs: num(env.MIN_SUBMIT_INTERVAL_MS, d.minSubmitIntervalMs, { min: 0, max: 600000, int: true }),
    maxQueued: num(env.MAX_QUEUED, d.maxQueued, { min: 1, max: 10, int: true }),
    maxBatch: num(env.MAX_BATCH, d.maxBatch, { min: 1, max: 5, int: true }),
    duplicateWindowMs: num(env.DUPLICATE_WINDOW_MS, d.duplicateWindowMs, { min: 0, max: 3600000, int: true }),
    skolPerImage: num(env.SKOL_PER_IMAGE, d.skolPerImage, { min: 0, max: 100000, int: true }),
    startingSkol: num(env.STARTING_SKOL, d.startingSkol, { min: 0, max: 10000000, int: true }),
    rates: {
      textIn: num(env.RATE_TEXT_IN_PER_M, d.rates.textIn, { min: 0, max: 1000 }),
      imageIn: num(env.RATE_IMAGE_IN_PER_M, d.rates.imageIn, { min: 0, max: 1000 }),
      imageOut: num(env.RATE_IMAGE_OUT_PER_M, d.rates.imageOut, { min: 0, max: 1000 })
    },
    timeZone: typeof env.TIME_ZONE === 'string' && env.TIME_ZONE ? env.TIME_ZONE : d.timeZone,
    generationEnabled: env.GENERATION_ENABLED !== 'false',
    allowLowModeration: env.ALLOW_LOW_MODERATION === 'true',
    ownerAdultAttested: env.OWNER_ADULT_ATTESTED === 'true',
    models: String(env.IMAGE_MODELS || 'gpt-image-2.6-sunburst,gpt-image-2.6-flare').split(',').map((s) => s.trim()).filter(Boolean)
  };
}

/** USD estimate from the provider's usage object. Returns null when usage is missing/unusable. */
export function costFromUsage(usage, rates) {
  if (!usage || typeof usage !== 'object') return null;
  const out = Number(usage.output_tokens);
  if (!Number.isFinite(out)) return null;
  const d = usage.input_tokens_details || {};
  const textIn = Number.isFinite(Number(d.text_tokens)) ? Number(d.text_tokens) : Number(usage.input_tokens) || 0;
  const imgIn = Number.isFinite(Number(d.image_tokens)) ? Number(d.image_tokens) : 0;
  const usd = (textIn * rates.textIn + imgIn * rates.imageIn + out * rates.imageOut) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

function parts(ts, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(ts)); // YYYY-MM-DD
}
export const dayKey = (ts, tz) => parts(ts, tz);
export const monthKey = (ts, tz) => parts(ts, tz).slice(0, 7);

/** Stable hash of the normalized generation parameters (for quote binding and duplicate detection). */
export async function hashParams(obj) {
  const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
    : Array.isArray(v) ? v.map(stable) : v);
  const data = new TextEncoder().encode(JSON.stringify(stable(obj)));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reserve estimate per call: never below the configured figure; grows if real calls cost more. */
export function reservePerCall(cfg, observedAvgUsd) {
  return Math.max(cfg.estUsdPerCall, Number.isFinite(observedAvgUsd) ? observedAvgUsd * 1.25 : 0);
}

/**
 * Decide whether a batch may be created.
 * counters: { callsToday, usdToday, usdMonth, queuedOrWorking, lastSubmitAt }
 * recentBatches: [{ hash, ts }]
 */
export function evaluateLimits({ cfg, now, count, paused, counters, paramsHash, recentBatches = [], allowDuplicate = false, reserveUsd }) {
  const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
  if (paused || !cfg.generationEnabled) return fail('GENERATION_PAUSED');
  if (!Number.isInteger(count) || count < 1 || count > cfg.maxBatch) return fail('BATCH_SIZE_INVALID', { max: cfg.maxBatch });
  const since = now - counters.lastSubmitAt;
  if (counters.lastSubmitAt && since < cfg.minSubmitIntervalMs) {
    return fail('TOO_SOON', { retryAfterMs: cfg.minSubmitIntervalMs - since });
  }
  if (counters.queuedOrWorking + count > cfg.maxQueued) return fail('TOO_MANY_QUEUED', { max: cfg.maxQueued });
  if (!allowDuplicate && recentBatches.some((b) => b.hash === paramsHash && now - b.ts < cfg.duplicateWindowMs)) {
    return fail('DUPLICATE_RECENT');
  }
  if (counters.callsToday + count > cfg.maxCallsPerDay) return fail('DAILY_CALL_CAP', { cap: cfg.maxCallsPerDay });
  const add = reserveUsd * count;
  if (counters.usdToday + add > cfg.maxUsdPerDay) return fail('DAILY_USD_CAP', { cap: cfg.maxUsdPerDay });
  if (counters.usdMonth + add > cfg.maxUsdPerMonth) return fail('MONTHLY_USD_CAP', { cap: cfg.maxUsdPerMonth });
  return { ok: true, estUsd: Math.round(add * 1000) / 1000 };
}

/** Heuristic backstop only (NOT age verification): refuses text that signals minors. */
const MINOR_TERMS = /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|toddler|infant|baby|preteen|pre-teen|schoolboy|schoolgirl|juvenile|loli|lolita|shota|(?:[1-9]|1[0-7])[- ]?(?:yo|y\/o|years?[- ]old))\b/i;
export function containsMinorSignal(...texts) {
  return texts.some((t) => typeof t === 'string' && MINOR_TERMS.test(t));
}
