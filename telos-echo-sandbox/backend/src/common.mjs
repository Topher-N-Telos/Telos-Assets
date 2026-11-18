/** Small shared helpers for the onboarding backend. Pure, no I/O. */
import { IMAGE_QUALITIES, IMAGE_SIZES } from '../../src/openai-image-api.mjs';

export class ApiError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

function num(v, fallback, { min = 0, max = Infinity, int = false } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) return fallback;
  return n;
}

export const DEFAULTS = Object.freeze({
  freeAvatar: 2,            // Master 18.7 (v203): avatar image free + one free redo
  freeTelo: 2,              // Master 30.2 (v203): first Telō free + its first redo free
  freePrebuilt: 6,          // tester build: free outfit/scene generations for prebuilt Telōs (economy not yet specified; owner adjustable)
  quality: 'high', size: '1024x1536',
  maxCallsPerDayUser: 8,    // attempts per user per day (refunded attempts still count toward this cap)
  minSubmitIntervalMs: 5000, maxQueuedUser: 1,
  estUsdPerCall: 0.10,      // conservative reservation; real cost was observed near $0.035 at high quality
  maxUsdPerDay: 2, maxUsdPerMonth: 6,   // well under the OpenAI project's $10 monthly hard limit
  rates: { textIn: 5, imageIn: 8, imageOut: 30 },   // USD per 1M tokens (input rates unverified)
  maxPhotos: 3, maxPhotoBytes: 8 * 1024 * 1024, timeZone: 'America/Detroit'
});

export function parseConfig(env = {}) {
  const d = DEFAULTS;
  const quality = IMAGE_QUALITIES.includes(env.ONBOARDING_QUALITY) ? env.ONBOARDING_QUALITY : d.quality;
  const size = IMAGE_SIZES.includes(env.ONBOARDING_SIZE) ? env.ONBOARDING_SIZE : d.size;
  return {
    freeAvatar: num(env.FREE_AVATAR_GENERATIONS, d.freeAvatar, { min: 0, max: 20, int: true }),
    freeTelo: num(env.FREE_TELO_GENERATIONS, d.freeTelo, { min: 0, max: 20, int: true }),
    freePrebuilt: num(env.FREE_PREBUILT_GENERATIONS, d.freePrebuilt, { min: 0, max: 100, int: true }),
    quality, size,
    model: String(env.IMAGE_MODEL || 'gpt-image-2.6-sunburst'),
    maxCallsPerDayUser: num(env.MAX_CALLS_PER_DAY_USER, d.maxCallsPerDayUser, { min: 1, max: 200, int: true }),
    minSubmitIntervalMs: num(env.MIN_SUBMIT_INTERVAL_MS, d.minSubmitIntervalMs, { min: 0, max: 600000, int: true }),
    maxQueuedUser: num(env.MAX_QUEUED_USER, d.maxQueuedUser, { min: 1, max: 5, int: true }),
    estUsdPerCall: num(env.EST_USD_PER_CALL, d.estUsdPerCall, { min: 0.01, max: 5 }),
    maxUsdPerDay: num(env.MAX_USD_PER_DAY, d.maxUsdPerDay, { min: 0.1, max: 100 }),
    maxUsdPerMonth: num(env.MAX_USD_PER_MONTH, d.maxUsdPerMonth, { min: 0.1, max: 1000 }),
    rates: {
      textIn: num(env.RATE_TEXT_IN_PER_M, d.rates.textIn, { min: 0, max: 1000 }),
      imageIn: num(env.RATE_IMAGE_IN_PER_M, d.rates.imageIn, { min: 0, max: 1000 }),
      imageOut: num(env.RATE_IMAGE_OUT_PER_M, d.rates.imageOut, { min: 0, max: 1000 })
    },
    maxPhotos: d.maxPhotos, maxPhotoBytes: d.maxPhotoBytes,
    timeZone: typeof env.TIME_ZONE === 'string' && env.TIME_ZONE ? env.TIME_ZONE : d.timeZone,
    generationEnabled: env.GENERATION_ENABLED !== 'false',
    allowPhotoUploads: env.ALLOW_PHOTO_UPLOADS !== 'false'
  };
}

export function costFromUsage(usage, rates) {
  if (!usage || typeof usage !== 'object') return null;
  const out = Number(usage.output_tokens);
  if (!Number.isFinite(out)) return null;
  const d = usage.input_tokens_details || {};
  const textIn = Number.isFinite(Number(d.text_tokens)) ? Number(d.text_tokens) : Number(usage.input_tokens) || 0;
  const imgIn = Number.isFinite(Number(d.image_tokens)) ? Number(d.image_tokens) : 0;
  return Math.round(((textIn * rates.textIn + imgIn * rates.imageIn + out * rates.imageOut) / 1e6) * 10000) / 10000;
}

const dayStr = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
export const dayKey = (ts, tz) => dayStr(ts, tz);
export const monthKey = (ts, tz) => dayStr(ts, tz).slice(0, 7);

/** Heuristic backstop only (NOT age verification): refuses text that signals minors. */
const MINOR_TERMS = /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|toddler|infant|baby|preteen|pre-teen|schoolboy|schoolgirl|juvenile|loli|lolita|shota|(?:[1-9]|1[0-7])[- ]?(?:yo|y\/o|years?[- ]old))\b/i;
export const containsMinorSignal = (...texts) => texts.some((t) => typeof t === 'string' && MINOR_TERMS.test(t));

/** Identify an upload from magic bytes; never trust the client's Content-Type. */
export function sniffImage(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** First integer in a free-text age ("34", "early 30s", "mid-40s"). null when none. */
export const firstNumber = (s) => { const m = String(s ?? '').match(/(\d{1,3})/); return m ? Number(m[1]) : null; };

export const KINDS = ['avatar', 'telo'];
// A Telō created AFTER onboarding gets its own image package under the scoped kind 'telo~<teloId>' (own free unit and redos, own images).
// Behaves exactly like 'telo' everywhere except storage/allotment, which key on the full string. baseKind() gives the behavioural kind.
export const TELO_SCOPED = /^telo~[A-Za-z0-9_-]{1,40}$/;
export const isKind = (k) => KINDS.includes(k) || TELO_SCOPED.test(k);
export const baseKind = (k) => (TELO_SCOPED.test(k) ? 'telo' : k);

const FIELDS = ['species', 'apparentAge', 'height', 'bodyType', 'skinTone', 'facialFeatures', 'eyes', 'hair', 'facialHair', 'bodyHair', 'marks', 'physique', 'mobilityAids'];
const str = (v, max, field, required = false) => {
  if (v === undefined || v === null || v === '') { if (required) throw new ApiError(400, 'FIELD_REQUIRED', { field }); return ''; }
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'FIELD_INVALID', { field });
  return v.trim();
};

/**
 * Validates the onboarding request body. Adult status is FAIL-CLOSED: the user must attest the person
 * depicted is an adult AND give an apparent age with no number under 18. This is a backstop, not age verification.
 */
export function normalizeOnboarding(kind, body) {
  if (!isKind(kind)) throw new ApiError(404, 'NOT_FOUND');
  const f = body?.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new ApiError(400, 'FIELD_INVALID', { field: 'fields' });
  const canon = {};
  for (const k of FIELDS) { const s = str(f[k], 300, `fields.${k}`, k === 'apparentAge'); if (s) canon[k] = s; }
  const name = str(f.name, 60, 'fields.name');
  const description = str(f.description, 1500, 'fields.description', true);
  const style = str(f.style, 200, 'fields.style');
  const world = str(f.world, 500, 'fields.world');
  const outfit = str(f.outfit, 300, 'fields.outfit');
  if (body.adultAttested !== true) throw new ApiError(400, 'ADULT_ATTESTATION_REQUIRED');
  const age = firstNumber(canon.apparentAge);
  if (age !== null && age < 18) throw new ApiError(400, 'CHARACTER_AGE_NOT_ADULT');
  if (containsMinorSignal(name, description, style, world, outfit, ...Object.values(canon))) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  const key = String(body.idempotencyKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new ApiError(400, 'FIELD_INVALID', { field: 'idempotencyKey' });
  const photoIds = body.photoIds ?? [];
  if (!Array.isArray(photoIds) || photoIds.length > 3 || photoIds.some((i) => typeof i !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(i))) throw new ApiError(400, 'FIELD_INVALID', { field: 'photoIds' });
  // Telō and avatar onboarding are a two-image package (full-length + face close-up, one free allotment unit). 'full' / 'face' redo ONE image (one unit each).
  const part = (baseKind(kind) === 'telo' || kind === 'avatar') ? (body.part ?? 'package') : 'full';
  if (!['package', 'full', 'face'].includes(part)) throw new ApiError(400, 'FIELD_INVALID', { field: 'part' });
  const refImageId = body.refImageId ?? '';
  if (part === 'face' && !/^[A-Za-z0-9_-]{6,64}$/.test(String(refImageId))) throw new ApiError(400, 'FIELD_INVALID', { field: 'refImageId' });
  return { kind, name, canon, description, style, world, outfit, photoIds, idempotencyKey: key, part, ...(part === 'face' ? { refImageId: String(refImageId) } : {}) };
}
