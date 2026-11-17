/**
 * Canonical look + reference images for the four prebuilt (starter) Telōs. Pure data + validation, no I/O.
 * Reference files live in public/_refs/<dir>/<role>.jpg (built by tools/make-refs.py from the masters in refs/).
 * They are NEVER served to clients; only the Worker reads them (ASSETS binding) and hands them to the user's DO.
 * Bump `version` whenever a reference file or the locked appearance changes (DOs re-seed on version change).
 * Locked appearance below is written from the approved reference art plus Master 4.5/4.6/4.9; the Master's
 * "presents young / ancient" ages are expressed as adult presenting. Nova's apparent age follows the reference photos.
 */
import { ApiError, containsMinorSignal } from './common.mjs';

export const PREBUILT_VERSION = 'v1';
export const PREBUILT_MODES = ['outfit', 'scene'];

const REF_LABEL = {
  face: (n) => `FACE / IDENTITY reference for ${n} (SUBJECT 1) — reproduce this exact face, skin tone and hair`,
  body: (n) => `BODY reference for ${n} (SUBJECT 1) — build and proportions only; ignore its plain clothing and backdrop`,
  look: (n) => `CANON LOOK reference for ${n} (SUBJECT 1) — signature outfit and styling`
};

export const PREBUILT = Object.freeze({
  nova: {
    name: 'Nova', world: 'TERRA', dir: 'terra-nova', forms: ['default'], defaultForm: 'default',
    world_visual: 'TERRA: contemporary Earth-like city; natural light; architecture studios, blueprints, skyline views.',
    locked: { default: {
      species: 'Human', apparentAge: 'adult woman (match the reference photos)', skinTone: 'deep brown', hair: 'voluminous natural curly afro, copper-brown with auburn highlights',
      eyes: 'dark brown', facialFeatures: 'high cheekbones, composed, perceptive expression', physique: 'lean, athletic',
      marks: 'gold geometric tassel earrings'
    } },
    refs: { default: { face: 'face', body: 'body', look: 'look' } },
    canonLookText: 'olive-green brocade suit over an olive satin blouse, gold jewelry'
  },
  seraphine: {
    name: 'Seraphine', world: 'UMBRA', dir: 'umbra-seraphine', forms: ['default'], defaultForm: 'default',
    world_visual: 'UMBRA: eternal night, gothic architecture, moonlit cityscape, candlelit libraries.',
    locked: { default: {
      species: 'Vampire (adult-presenting)', apparentAge: 'adult woman (match the reference photos)', skinTone: 'pale', hair: 'very long, wavy platinum silver',
      eyes: 'pale blue', facialFeatures: 'sharp, regal, unhurried gaze', physique: 'slender, toned',
      marks: 'dark red-and-black gothic cross pendant and drop earrings, dark nail polish'
    } },
    refs: { default: { face: 'face', body: 'body', look: 'look' } },
    canonLookText: 'dark red and gold velvet, black beaded corset, plum fur-trimmed sequined cape'
  },
  oryn: {
    name: 'Oryn', world: 'SOLIS', dir: 'solis-oryn', forms: ['default'], defaultForm: 'default',
    world_visual: 'SOLIS: warm light through high windows, bronze and copper, ancient records and archives.',
    locked: { default: {
      species: 'Jinn (adult-presenting)', apparentAge: 'adult man (match the reference photos)', skinTone: 'bronze', hair: 'thick black curls, mid-length',
      eyes: 'dark, warm, with ember glowing in the iris at all times', facialHair: 'short full black beard with moustache', physique: 'tall, powerfully built',
      marks: 'gold hoop-and-pendant earrings, stacked gold cuffs and rings'
    } },
    refs: { default: { face: 'face', body: 'body', look: 'look' } },
    canonLookText: 'sleeveless clay-glyph embossed vest over draped rust-brown trousers, sandals'
  },
  aeon: {
    name: 'Æon', world: 'AURIS', dir: 'auris-aeon', forms: ['dragon', 'human'], defaultForm: 'dragon',
    world_visual: 'AURIS: vast cave-city of waterfalls, ancient terraced ruins, candlelight and mist.',
    locked: {
      dragon: {
        species: 'Dragon (default form)', apparentAge: 'ancient, adult', skinTone: 'dark bronze and gold armored scales', facialFeatures: 'long horned head, swept spines, blue-violet eyes',
        physique: 'vast, four-legged, long tail', marks: 'white feathery mane and tail plumes; translucent iridescent wings patterned with fine gold glyphs and circuitry'
      },
      human: {
        species: 'Human guise of Æon, known as Sir Rocco', apparentAge: 'adult man (match the reference photos)', skinTone: 'deep brown', hair: 'white dreadlocks swept back, shaved sides',
        facialHair: 'trimmed white beard and white brows', eyes: 'dark', physique: 'tall, lean and muscular', marks: 'small silver hoop earring'
      }
    },
    refs: { dragon: { face: 'dragon-face', body: 'dragon-body' }, human: { face: 'human-face', body: 'human-body', look: 'human-look' } },
    canonLookText: { dragon: '', human: 'long plum-and-gold embroidered brocade coat over a teal satin shirt, matching wide trousers, silver cross necklaces' }
  }
});

export const prebuiltIds = Object.keys(PREBUILT);

/** Reference files (role -> path under /_refs/) for a given request. 'look' is dropped when the user asks for a new outfit. */
export function refPlan(charId, form, hasOutfit) {
  const c = PREBUILT[charId]; const set = c.refs[form];
  return Object.entries(set).filter(([role]) => !(role === 'look' && hasOutfit))
    .map(([role, file]) => ({ role, file: `${c.dir}/${file}.jpg`, label: REF_LABEL[role](c.name) }));
}
export const allRefFiles = (charId) => [...new Set(Object.values(PREBUILT[charId].refs).flatMap((s) => Object.values(s)))].map((f) => `${PREBUILT[charId].dir}/${f}.jpg`);

const text = (v, max, field) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw new ApiError(400, 'FIELD_INVALID', { field });
  return v.trim();
};

/** Validates the prebuilt-Telō request body (the character comes from the URL, never trusted from the body). */
export function normalizePrebuilt(charId, body) {
  const c = PREBUILT[charId];
  if (!c) throw new ApiError(404, 'NOT_FOUND');
  const mode = body?.mode;
  if (!PREBUILT_MODES.includes(mode)) throw new ApiError(400, 'FIELD_INVALID', { field: 'mode' });
  const form = body.form === undefined || body.form === null || body.form === '' ? c.defaultForm : body.form;
  if (!c.forms.includes(form)) throw new ApiError(400, 'FIELD_INVALID', { field: 'form' });
  const outfit = text(body.outfit, 300, 'outfit');
  const scene = text(body.scene, 500, 'scene');
  const direction = text(body.direction, 600, 'direction');
  if (mode === 'outfit' && !outfit) throw new ApiError(400, 'FIELD_REQUIRED', { field: 'outfit' });
  if (mode === 'scene' && !scene) throw new ApiError(400, 'FIELD_REQUIRED', { field: 'scene' });
  if (containsMinorSignal(outfit, scene, direction)) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  const key = String(body.idempotencyKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new ApiError(400, 'FIELD_INVALID', { field: 'idempotencyKey' });
  return { kind: 'prebuilt', charId, form, mode, outfit, scene, direction, idempotencyKey: key, photoIds: [] };
}

/** Everything runJob needs for a prebuilt job, derived only from trusted canon + validated fields. */
export function prebuiltScene(p) {
  const c = PREBUILT[p.charId];
  const locked = c.locked[p.form];
  const look = typeof c.canonLookText === 'string' ? c.canonLookText : c.canonLookText[p.form];
  const outfit = p.outfit || look || '';
  const intro = p.mode === 'outfit'
    ? `${c.name} in ${c.world}, shown full length wearing the requested new outfit, relaxed natural pose.`
    : `${c.name} in the following moment in ${c.world}: ${p.scene}`;
  return {
    sceneIntro: intro, displayName: c.name, locked, outfit, worldVisual: c.world_visual,
    artDirection: [p.mode === 'outfit' ? `New outfit: ${p.outfit}` : '', p.direction].filter(Boolean).join('\n'),
    mode: p.mode === 'outfit' ? 'portrait' : 'cinematic'
  };
}
