/** Pure validation/normalization for everything the browser sends. Throws ApiError with a stable code. */
import { containsMinorSignal } from './limits.mjs';
import { IMAGE_QUALITIES, IMAGE_SIZES } from '../../src/openai-image-api.mjs';

export class ApiError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

export const CANON_FIELDS = ['species', 'apparentAge', 'height', 'bodyType', 'skinTone', 'facialFeatures',
  'eyes', 'hair', 'facialHair', 'bodyHair', 'marks', 'physique', 'anatomy', 'mobilityAids'];
export const REF_ROLES = ['face', 'body', 'garment', 'other'];
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const str = (v, max, field, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, 'FIELD_REQUIRED', { field });
    return '';
  }
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'FIELD_INVALID', { field });
  return v.trim();
};

/** Canon: each known field is a string, or null meaning "confirmed absent". Unknown keys are dropped. */
export function normalizeCanon(raw) {
  const out = {};
  if (raw === undefined) return out;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ApiError(400, 'FIELD_INVALID', { field: 'canon' });
  for (const k of CANON_FIELDS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (v === null) { out[k] = null; continue; }
    const s = str(v, 300, `canon.${k}`);
    if (s) out[k] = s;
  }
  if (containsMinorSignal(...Object.values(out))) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  return out;
}

export function normalizeCharacterInput(body) {
  const name = str(body?.name, 60, 'name', { required: true });
  if (containsMinorSignal(name)) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  return { name, canon: normalizeCanon(body?.canon), adultAttested: body?.adultAttested === true };
}

export function normalizeParams(raw, cfg) {
  if (!raw || typeof raw !== 'object') throw new ApiError(400, 'FIELD_INVALID', { field: 'params' });
  const ids = raw.characterIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 4 || ids.some((i) => typeof i !== 'string' || !ID_RE.test(i)) || new Set(ids).size !== ids.length) {
    throw new ApiError(400, 'FIELD_INVALID', { field: 'characterIds' });
  }
  const worldRefIds = raw.worldRefIds ?? [];
  if (!Array.isArray(worldRefIds) || worldRefIds.length > 3 || worldRefIds.some((i) => typeof i !== 'string' || !ID_RE.test(i))) {
    throw new ApiError(400, 'FIELD_INVALID', { field: 'worldRefIds' });
  }
  const outfits = {};
  for (const id of ids) {
    const o = str(raw.outfits?.[id], 300, 'outfits');
    if (o) outfits[id] = o;
  }
  const model = raw.model ?? cfg.models[0];
  if (!cfg.models.includes(model)) throw new ApiError(400, 'MODEL_NOT_ALLOWED');
  const moderation = raw.moderation ?? 'auto';
  if (!['auto', 'low'].includes(moderation)) throw new ApiError(400, 'FIELD_INVALID', { field: 'moderation' });
  const quality = raw.quality ?? 'high';
  const size = raw.size ?? '1024x1536';
  if (!IMAGE_QUALITIES.includes(quality)) throw new ApiError(400, 'FIELD_INVALID', { field: 'quality' });
  if (!IMAGE_SIZES.includes(size)) throw new ApiError(400, 'FIELD_INVALID', { field: 'size' });
  const surface = raw.surface ?? 'sfw';
  if (!['sfw', 'adult'].includes(surface)) throw new ApiError(400, 'FIELD_INVALID', { field: 'surface' });
  if (surface === 'adult' && !cfg.ownerAdultAttested) throw new ApiError(400, 'ADULT_SURFACE_DISABLED');
  // 'low' is an explicit manual choice, only on the adult surface, and only when the owner enabled it server-side.
  if (moderation === 'low' && (surface !== 'adult' || !cfg.allowLowModeration)) throw new ApiError(400, 'LOW_MODERATION_NOT_ALLOWED');
  const mode = raw.mode ?? 'cinematic';
  if (!['cinematic', 'portrait'].includes(mode)) throw new ApiError(400, 'FIELD_INVALID', { field: 'mode' });
  const count = raw.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > cfg.maxBatch) throw new ApiError(400, 'BATCH_SIZE_INVALID', { max: cfg.maxBatch });

  const p = {
    characterIds: ids, worldRefIds, outfits,
    sceneText: str(raw.sceneText, 1500, 'sceneText', { required: true }),
    worldText: str(raw.worldText, 1500, 'worldText'),
    locationText: str(raw.locationText, 200, 'locationText'),
    artDirection: str(raw.artDirection, 1500, 'artDirection'),
    garmentPhysics: str(raw.garmentPhysics, 800, 'garmentPhysics'),
    useGarmentPhysics: raw.useGarmentPhysics === true,
    garmentType: str(raw.garmentType, 60, 'garmentType'),
    condition: str(raw.condition, 40, 'condition'),
    label: str(raw.label, 60, 'label'),
    model, moderation, quality, size, count, surface, mode,
    allowDuplicate: raw.allowDuplicate === true
  };
  if (containsMinorSignal(p.sceneText, p.worldText, p.locationText, p.artDirection, p.garmentPhysics, p.garmentType, p.label, ...Object.values(outfits))) {
    throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  }
  return p;
}

/** Text appended to the art direction. Garment construction is only included when the owner opts in. */
export function composeArtDirection(p) {
  const parts = [];
  if (p.artDirection) parts.push(p.artDirection);
  if (p.useGarmentPhysics && p.garmentPhysics) parts.push(`GARMENT CONSTRUCTION: ${p.garmentPhysics}`);
  return parts.join('\n');
}

/** Identify an upload from its magic bytes; never trust the client's Content-Type. */
export function sniffImage(bytes) {
  const b = bytes;
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export function normalizeScore(raw) {
  const out = {};
  for (const k of ['identity', 'anatomy', 'fabric', 'costume', 'scene']) {
    const v = raw?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new ApiError(400, 'FIELD_INVALID', { field: k });
    out[k] = v;
  }
  out.notes = str(raw?.notes, 500, 'notes');
  out.garment = str(raw?.garment, 60, 'garment');
  out.condition = str(raw?.condition, 40, 'condition');
  return out;
}

/** CSV cell with spreadsheet-formula injection guard. */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
