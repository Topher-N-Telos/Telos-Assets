/**
 * Echō image generation: Single Image or Collage (4–9 panels). Pure data + validation, no I/O.
 *  - A collage is ONE canvas = ONE provider request (n:1) = ONE image use, whatever the panel count.
 *  - Sköl prices are NEVER invented here. The six collage prices come from the COLLAGE_SKOL_PRICES setting (strictly increasing);
 *    a single image uses Master 30.2's "Photo (beyond daily credits) 20 sköl" unless SINGLE_SKOL_PRICE overrides it.
 *    With no ladder configured, quotes fail closed (IMAGE_PRICING_UNAVAILABLE).
 *  - The style list is the Master's (7.4 / 12.2) and is the ONE list: the app reads it from the Worker.
 *  - World looks are the Master's "City Grammar by World" text (Section 3), used as visual canon for scenes.
 */
import { ApiError, containsMinorSignal } from './common.mjs';

export const COLLAGE_COUNTS = Object.freeze([4, 5, 6, 7, 8, 9]);
/** Panels per row. Every row fills the full width, so odd counts never leave an empty cell. */
export const COLLAGE_ROWS = Object.freeze({ 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 2, 2], 8: [4, 4], 9: [3, 3, 3] });
export const COLLAGE_SIZE = '1536x1024';
export const SINGLE_SIZES = Object.freeze({ portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024' });
export const DEFAULT_STYLE = 'realism';
export const MAX_ECHO_REFS = 3;
export const QUOTE_TTL_MS = 10 * 60 * 1000;
export const SINGLE_SKOL_DEFAULT = 20;     // Master 30.2: Photo (beyond daily credits) = 20 sköl

/** Normalized per-panel rectangles (0..1) — used for the number overlay and for caption bubbles. */
export function panelRects(count) {
  const rows = COLLAGE_ROWS[count]; if (!rows) throw new RangeError('INVALID_PANEL_COUNT');
  let index = 0;
  return rows.flatMap((cells, row) => Array.from({ length: cells }, (_, col) => ({ index: ++index, x: col / cells, y: row / rows.length, width: 1 / cells, height: 1 / rows.length })));
}

export const STYLES = Object.freeze([
  { id: 'realism', label: 'Realism', tier: 'base', prompt: 'Photorealistic, cinematic realism with naturally motivated lighting, believable movement, candid and unposed composition.' },
  { id: 'anime', label: 'Anime', tier: 'base', prompt: 'Anime illustration: clean line art, expressive eyes, cel shading, painterly cinematic backgrounds.' },
  { id: 'cartoon', label: 'Cartoon', tier: 'base', prompt: 'Cartoon illustration: bold clean outlines, flat shaded colour, expressive simplified shapes.' },
  { id: 'watercolor', label: 'Watercolor', tier: 'base', prompt: 'Watercolor painting: soft translucent washes, visible paper texture, gently bleeding edges.' },
  { id: 'comic', label: 'Comic Book', tier: 'base', prompt: 'Comic book illustration: bold ink lines, flat colour blocking, graphic shadow, subtle halftone texture.' },
  { id: 'ghibli', label: 'Studio Ghibli-inspired', tier: 'premium', prompt: 'Gentle hand-painted animated-film look: lush painterly backgrounds, soft natural light, warm expressive characters.' },
  { id: 'oil', label: 'Oil Painting', tier: 'premium', prompt: 'Oil painting: visible brushwork, rich pigment, dramatic chiaroscuro, canvas texture.' },
  { id: 'fantasy', label: 'Fantasy Epic', tier: 'premium', prompt: 'Epic fantasy illustration: grand scale, rich colour, heroic lighting, detailed concept-art finish.' },
  { id: 'cyberpunk', label: 'Cyberpunk Neon', tier: 'echo', prompt: 'Cyberpunk neon: rain-slicked surfaces, glowing signage, deep shadow, saturated neon light.' },
  { id: 'scifi', label: 'Sci-Fi Cinematic', tier: 'echo', prompt: 'Cinematic science fiction: cold vast spaces, clean practical lighting, station and starfield scale.' },
  { id: 'noir', label: 'Noir', tier: 'echo', prompt: 'Film noir: high-contrast monochrome, hard shadow, venetian-blind light, smoky atmosphere.' },
  { id: 'pixel', label: 'Pixel Art', tier: 'echo', prompt: 'Pixel art: crisp limited-palette pixels, retro game sensibility, clear readable silhouettes.' }
]);
const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));
/** The app's avatar picker stores the label ("Comic Book"); map either form to an id, defaulting to realism. */
export function styleId(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (STYLE_BY_ID[s]) return s;
  return STYLES.find((x) => x.label.toLowerCase() === s)?.id ?? DEFAULT_STYLE;
}
export const stylePrompt = (id) => (STYLE_BY_ID[id] ?? STYLE_BY_ID[DEFAULT_STYLE]).prompt;

export const WORLD_IDS = Object.freeze(['TERRA', 'UMBRA', 'AXIOM', 'AURIS', 'SOLIS', 'AEONIS', 'VELA', 'TENEBRIS', 'MARIS']);
/** Master, Section 3 "City Grammar by World" (verbatim). */
export const WORLD_VISUAL = Object.freeze({
  TERRA: 'The city as it is. Photorealistic, cinematic. Contemporary architecture. The reference world.',
  UMBRA: 'Stone and iron. Gothic vertical. Streets compressed and narrowed. Crimson lamplight. Perpetual dusk or deep night. Towers rather than sprawl.',
  AXIOM: 'The city pushed forward into signal saturation. Recognizable street grid, denser and more vertical. Every surface a screen or reflective panel. Neon at street level, clean signal light above.',
  AURIS: 'The city grown with its geography. Rivers wider and more central. Living architecture — wood still alive, stone shaped rather than cut. Floating elements. The city breathes.',
  SOLIS: 'Fire-stone and forge-craft. Warm stone, copper and bronze, open flame as civic light. Lower and more human-scaled, built around courtyards and gathering spaces. Solar and thermal infrastructure.',
  AEONIS: 'Marble and impossible light. Civic buildings are temples — the primary architecture. Light comes from within the buildings. Structures that should not stand but do.',
  VELA: 'Station architecture. Modular, functional, oriented outward. The city reads as outpost rather than settled civilization. Built for expansion, pressure, and the frontier.',
  TENEBRIS: 'Victorian — the period that got closest before modernity intervened. Gas lamps. Cobblestone. Fog never clears. The city stopped developing at a specific moment and has been accumulating dread since.',
  MARIS: 'Underwater. Same coastlines and river systems but filled. Pressure habitats, coral towers, bioluminescent civic lighting. The city extends down rather than up.'
});

/** Instructions for ONE canvas holding several panels. Text overlays (numbers, captions, dialogue) are added by Telōs afterwards. */
export function collagePrompt(count, styleLabel) {
  const rows = COLLAGE_ROWS[count]; if (!rows) throw new RangeError('INVALID_PANEL_COUNT');
  return `COLLAGE FORMAT: Create ONE continuous image canvas containing EXACTLY ${count} DISTINCT story panels.\n` +
    `Reading order: left-to-right, top-to-bottom. Use ${rows.length} rows with ${rows.join(', ')} panels respectively. Every row fills the full width; leave no empty slots.\n` +
    `Each panel is a different sequential narrative beat, never copies of one pose. Keep clean, even gutters between panels.\n` +
    `Use the SAME art treatment (${styleLabel}) in every panel. Keep every character's identity, skin tone, wardrobe, and the location consistent from panel to panel.\n` +
    `NO printed panel numbers, captions, subtitles, speech bubbles, logos or any lettering anywhere: Telōs adds numbers and dialogue afterwards as editable overlays.`;
}

/** Sköl prices. Collage ladder must be complete, whole, and strictly increasing. Returns null when not configured. */
export function skolPrices(env = {}) {
  let ladder = null;
  if (env.COLLAGE_SKOL_PRICES) {
    let raw; try { raw = JSON.parse(env.COLLAGE_SKOL_PRICES); } catch { raw = null; }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      let last = 0, ok = true; const out = {};
      for (const n of COLLAGE_COUNTS) { const v = raw[n]; if (!Number.isSafeInteger(v) || v <= last || v > 1e7) { ok = false; break; } out[n] = v; last = v; }
      if (ok) ladder = out;
    }
  }
  const s = Number(env.SINGLE_SKOL_PRICE);
  const single = Number.isSafeInteger(s) && s > 0 && s <= 1e7 ? s : SINGLE_SKOL_DEFAULT;
  return { single, collage: ladder };
}
export function priceFor(prices, format, panelCount) {
  if (format === 'single') return prices.single;
  return prices.collage ? prices.collage[panelCount] : null;
}

const bad = (field) => new ApiError(400, 'FIELD_INVALID', { field });
const text = (v, max, field, req = false) => {
  if (v === undefined || v === null || v === '') { if (req) throw bad(field); return ''; }
  if (typeof v !== 'string' || v.length > max) throw bad(field);
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (req && !s) throw bad(field);
  return s;
};
const REF = /^((i|u):[A-Za-z0-9_-]{6,40}|s:[a-f0-9]{32})$/;   // i: own generated image, u: own uploaded photo, s: a venue interior shipped with the app (scene reference, never a person)

/** Which worlds a species may enter (native first). Mirrors the app's SPECIES_WORLDS table; an unlisted species is unrestricted, as in the app. */
export const SPECIES_WORLDS = Object.freeze({"Human": {"native": "TERRA", "permitted": ["UMBRA", "SOLIS", "AURIS", "VELA", "TENEBRIS", "AEONIS", "AXIOM", "MARIS"]}, "Rootkin": {"native": "TERRA", "permitted": ["UMBRA", "AXIOM", "AURIS", "SOLIS", "AEONIS", "TENEBRIS", "MARIS"]}, "Vampire": {"native": "UMBRA", "permitted": ["AEONIS", "TENEBRIS", "AURIS"]}, "Sorcerer": {"native": "UMBRA", "permitted": ["AURIS", "AEONIS", "TENEBRIS"]}, "Wraith": {"native": "UMBRA", "permitted": ["TENEBRIS", "AEONIS"]}, "Shadow Sage": {"native": "UMBRA", "permitted": ["TERRA", "AXIOM"]}, "Vesper": {"native": "UMBRA", "permitted": ["TENEBRIS"]}, "Cyborg": {"native": "AXIOM", "permitted": ["VELA", "TERRA"]}, "Android": {"native": "AXIOM", "permitted": ["VELA", "TERRA"]}, "Pixel Sprite": {"native": "AXIOM", "permitted": ["SOLIS"]}, "Dragon": {"native": "AURIS", "permitted": ["AEONIS", "SOLIS", "UMBRA"]}, "Elf": {"native": "AURIS", "permitted": ["UMBRA", "AEONIS", "MARIS", "SOLIS"]}, "Griffin": {"native": "AURIS", "permitted": ["UMBRA", "SOLIS", "AEONIS", "TENEBRIS"]}, "Sylph": {"native": "AURIS", "permitted": ["SOLIS", "AEONIS"]}, "Forest Giant": {"native": "AURIS", "permitted": ["UMBRA", "TENEBRIS", "SOLIS"]}, "Nimbus": {"native": "AURIS", "permitted": ["SOLIS", "AEONIS"]}, "Phoenix": {"native": "SOLIS", "permitted": ["AEONIS", "AURIS"]}, "Jinn": {"native": "SOLIS", "permitted": ["AEONIS", "TENEBRIS", "UMBRA"]}, "Azer": {"native": "SOLIS", "permitted": ["AXIOM", "TERRA"]}, "Garuda": {"native": "SOLIS", "permitted": ["AEONIS", "VELA"]}, "Sun Mage": {"native": "SOLIS", "permitted": ["TERRA", "AEONIS", "AURIS"]}, "Solidi": {"native": "SOLIS", "permitted": ["AXIOM", "AEONIS"]}, "Deity": {"native": "AEONIS", "permitted": ["SOLIS", "AURIS"]}, "Demigod": {"native": "AEONIS", "permitted": ["SOLIS", "TERRA"]}, "Fae": {"native": "AEONIS", "permitted": ["AURIS", "UMBRA", "TENEBRIS", "SOLIS"]}, "Seraph": {"native": "AEONIS", "permitted": ["TERRA", "UMBRA", "AXIOM", "AURIS", "SOLIS", "VELA", "TENEBRIS"]}, "Celestine": {"native": "AEONIS", "permitted": ["SOLIS", "AURIS"]}, "Alien": {"native": "VELA", "permitted": []}, "Vantari": {"native": "VELA", "permitted": ["AXIOM", "TERRA"]}, "Lycanthrope": {"native": "TENEBRIS", "permitted": ["UMBRA", "AURIS"]}, "Revenant": {"native": "TENEBRIS", "permitted": ["UMBRA"]}, "Gargoyle": {"native": "TENEBRIS", "permitted": ["UMBRA", "AURIS"]}, "Nephilim": {"native": "TENEBRIS", "permitted": ["TERRA", "UMBRA", "AXIOM", "AURIS", "SOLIS", "AEONIS", "VELA"]}, "The Unseen": {"native": "TENEBRIS", "permitted": ["UMBRA"]}, "Merfolk": {"native": "MARIS", "permitted": []}, "Sea Serpent": {"native": "MARIS", "permitted": []}, "Sea Nymph": {"native": "MARIS", "permitted": []}, "Bajau": {"native": "MARIS", "permitted": []}, "Oceanids": {"native": "MARIS", "permitted": []}});
export const compatibleWorlds = (species) => { const e = SPECIES_WORLDS[species]; return e ? [e.native, ...e.permitted] : [...WORLD_IDS]; };
/** Worlds open to EVERYONE in the picture: the intersection across the user's avatar species and every Telōsian type shown. */
export const allowedWorlds = (speciesList) => (speciesList ?? []).reduce((acc, sp) => acc.filter((w) => compatibleWorlds(sp).includes(w)), [...WORLD_IDS]);
const WORLD_NAME_RE = new RegExp('\\b(' + WORLD_IDS.join('|') + ')\\b', 'i');

/** Sub-tags: a world that looks different by region or sky carries one more tag. Chris's canon: Maris Outpost is its own tag; Solis has exactly three skies. */
export const SUB_WORLDS = Object.freeze({ MARIS: ['outpost', 'deep'] });   // user-chosen sub-tags. Solis skies are NOT chosen by the user; the generator picks them from the scene text (solisSky).
export const MARIS_DEEP_SPECIES = Object.freeze(['Merfolk', 'Sea Serpent', 'Oceanids', 'Sea Nymph']);
/** The Deep is open only if everyone pictured belongs there; the Outpost tier is open to all of MARIS's visitors. */
export const subWorldsFor = (world, speciesList) => {
  if (!SUB_WORLDS[world]) return [];
  if (world === 'MARIS') return (speciesList ?? []).every((sp) => MARIS_DEEP_SPECIES.includes(sp)) ? ['outpost', 'deep'] : ['outpost'];
  return [...SUB_WORLDS[world]];
};
const POLAR_RE = /\b(polar|arctic|glacier|glacial|iceberg|icebergs|ice sheet|ice field|tundra|permafrost|frozen sea)\b/i;
const NIGHT_RE = /\b(night|nighttime|midnight|overnight|after dark|late at night|dusk|evening|twilight|sunset)\b/i;
const DAY_RE = /\b(day|daytime|noon|midday|morning|afternoon|sunrise|dawn)\b/i;
/** Backend-only Solis sky. day = champagne gold; night = midnight sun; polar = low red sun, ONLY for polar Solis (the scene must be in the polar region). `inherited` carries a refined image's earlier sky. */
/** Regional climate maps are not uploaded yet, so polar Solis does not exist as a place. Until they are, every Solis scene uses the base day or night sky. Flip to true when the regional maps land. */
export const REGIONAL_MAPS_READY = false;
export function solisSky(text, inherited = null, regions = REGIONAL_MAPS_READY) {
  const t = String(text ?? ''), polar = regions && (POLAR_RE.test(t) || inherited === 'polar'), night = NIGHT_RE.test(t), day = DAY_RE.test(t);
  if (polar) return day && !night ? 'day' : 'polar';
  return night ? 'night' : day ? 'day' : (inherited === 'night' ? 'night' : 'day');
}
const MARIS_OUTPOST_VISUAL = 'ABOVE the water, the surface outposts of MARIS. Dense stacked platform rings and vertical spire clusters rather than sprawl; glass geodesic domes with an organic lattice framework, spires piercing the surface, elevated platform rings joined by causeways, warm interior light glowing through the glass at dusk. Relay outposts: exposed docking rigs, cable relay towers, pressure-lock waystations, dimmer utilitarian light. Open sea around the settlement. Small-city scale, never a metropolis.';
const MARIS_DEEP_VISUAL = 'BELOW the surface, the deep of MARIS. Underwater, the same coastlines and river systems but filled. Pressure habitats, coral towers, bioluminescent civic lighting. The city extends down rather than up.';
export const SOLIS_SKY = Object.freeze({
  day: 'SOLIS DAY: a warm champagne-gold sky with a blue horizon. The low red sun and burgundy sky are never used here; they belong only to polar Solis.',
  night: 'SOLIS NIGHT: the midnight sun. The sun is still up and the whole sky is a warm burnt orange. The low red sun and burgundy sky are never used here; they belong only to polar Solis.',
  polar: 'POLAR SOLIS NIGHT: a low red sun and a burgundy sky. This sky belongs to polar Solis alone.'
});
const SOLIS_NO_DARK = 'SOLIS NEVER HAS A DARK NIGHT SKY. No black, navy or starry sky, no moonlit darkness, ever. Every hour is lit by one of its three skies, and a night scene uses the midnight-sun or the polar sky.';
export const worldCanon = (world, sub = null) => {
  if (world === 'MARIS') return sub === 'deep' ? MARIS_DEEP_VISUAL : MARIS_OUTPOST_VISUAL;
  if (world === 'SOLIS') return `${WORLD_VISUAL.SOLIS} ${SOLIS_SKY[sub] ?? SOLIS_SKY.day} ${SOLIS_NO_DARK}`;
  return WORLD_VISUAL[world];
};
const SOLIS_DARK_RE = /\b(dark|black|starry|star-?filled|night-?time)\s+(night\s+)?sky|\bstarry\b|\bmoonlit\b|\bmoonlight\b|\bnight sky\b/i;

/** Hard rule for every image: one world, its vernacular is not negotiable by the scene text. */
export function worldLock(world, sub = null) {
  const others = WORLD_IDS.filter((w) => w !== world).join(', ');
  const tag = sub ? `${world} / ${sub.toUpperCase()}` : world;
  return `WORLD VERNACULAR LOCK (${tag}): This image takes place in ${world} and in no other world. ${world} look: ${worldCanon(world, sub)} Architecture, materials, lighting, technology level, street furniture and signage must all follow this. If the scene text asks for anything that belongs to ${others} or to a different world's look, keep the scene's action but draw it in the ${world} equivalent. Do not mix worlds.`;
}

/** Shared by quote + generate. `refine` (an existing Echō image's metadata) forces its format/style/world so edits keep them. */
export function normalizeFormat(body, refine = null) {
  const b = body ?? {};
  const base = refine
    ? { format: refine.format, panelCount: refine.panelCount ?? null, showPanelNumbers: refine.showPanelNumbers === true, style: refine.style, world: refine.world ?? null, aspect: refine.aspect ?? 'portrait' }
    : { format: b.format === undefined ? 'single' : b.format, panelCount: b.panelCount, showPanelNumbers: b.showPanelNumbers, style: styleId(b.style), world: b.world ?? null, aspect: b.aspect ?? 'portrait' };
  if (!['single', 'collage'].includes(base.format)) throw bad('format');
  if (base.format === 'single') {
    if (!refine && (b.panelCount !== undefined || b.showPanelNumbers === true)) throw bad('panelCount');
    if (!(base.aspect in SINGLE_SIZES)) throw bad('aspect');
    return { format: 'single', panelCount: null, showPanelNumbers: false, style: base.style, world: base.world, aspect: base.aspect };
  }
  if (!COLLAGE_COUNTS.includes(base.panelCount)) throw bad('panelCount');
  if (base.showPanelNumbers !== undefined && typeof base.showPanelNumbers !== 'boolean') throw bad('showPanelNumbers');
  if (base.world !== null && !WORLD_IDS.includes(base.world)) throw bad('world');
  return { format: 'collage', panelCount: base.panelCount, showPanelNumbers: base.showPanelNumbers === true, style: base.style, world: base.world, aspect: 'landscape' };
}

/** Full generate request. Everything the browser sends is untrusted; the quote id is the only price-related field and is verified server-side. */
export function normalizeEcho(body, refine = null) {
  const b = body ?? {};
  const f = normalizeFormat(b, refine);
  if (f.world !== null && !WORLD_IDS.includes(f.world)) throw bad('world');
  let species = [];
  if (!refine) {
    if (f.world === null) throw new ApiError(400, 'WORLD_REQUIRED');
    species = Array.isArray(b.species) ? b.species : null;
    if (!species || !species.length || species.length > 6 || species.some((x) => typeof x !== 'string' || !x || x.length > 40)) throw new ApiError(400, 'WORLD_SPECIES_REQUIRED');
    if (!allowedWorlds(species).includes(f.world)) throw new ApiError(403, 'WORLD_NOT_COMPATIBLE');
  }
  let subWorld = null;
  if (f.world === 'SOLIS') subWorld = null;   // set below from the scene text; any sub-tag the browser sends is ignored
  else if (refine) subWorld = refine.subWorld ?? null;
  else if (f.world && SUB_WORLDS[f.world]) {
    subWorld = typeof b.subWorld === 'string' ? b.subWorld : null;
    if (!subWorld || !SUB_WORLDS[f.world].includes(subWorld)) throw new ApiError(400, 'SUBWORLD_REQUIRED');
    if (!subWorldsFor(f.world, species).includes(subWorld)) throw new ApiError(403, 'SUBWORLD_NOT_COMPATIBLE');
  }
  if (b.adultAttested !== true) throw new ApiError(400, 'ADULT_ATTESTATION_REQUIRED');
  const prompt = text(b.prompt, 1500, 'prompt', true), direction = text(b.direction, 500, 'direction');
  if (containsMinorSignal(prompt, direction)) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
  if (f.world) for (const m of `${prompt} ${direction}`.matchAll(new RegExp(WORLD_NAME_RE.source, 'gi'))) if (m[1].toUpperCase() !== f.world) throw new ApiError(400, 'WORLD_CONFLICT');
  if (f.world === 'SOLIS' && SOLIS_DARK_RE.test(`${prompt} ${direction}`)) throw new ApiError(400, 'SOLIS_DARK_SKY');
  if (f.world === 'SOLIS') subWorld = solisSky(`${prompt} ${direction}`, refine?.subWorld ?? null);
  const refs = b.refs ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_ECHO_REFS || refs.some((r) => typeof r !== 'string' || !REF.test(r)) || new Set(refs).size !== refs.length) throw bad('refs');
  const key = String(b.idempotencyKey ?? ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw bad('idempotencyKey');
  const quoteId = String(b.quoteId ?? ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(quoteId)) throw new ApiError(403, 'IMAGE_QUOTE_REQUIRED');
  return { kind: 'echo', ...f, subWorld, species, prompt, direction, refs, ...(refine ? { refinedFrom: String(b.refineOf) } : {}), idempotencyKey: key, quoteId, photoIds: [], canon: {} };
}
export const sizeFor = (f) => (f.format === 'collage' ? COLLAGE_SIZE : SINGLE_SIZES[f.aspect] ?? SINGLE_SIZES.portrait);

/** Art direction handed to the shared scene builder: style first, then collage layout, then the user's words. */
export function echoDirection(p) {
  const st = STYLES.find((s) => s.id === p.style) ?? STYLES[0];
  return [p.world ? worldLock(p.world, p.subWorld ?? null) : '', `VISUAL STYLE (${st.label}): ${st.prompt}`, p.format === 'collage' ? collagePrompt(p.panelCount, st.label) : '', p.refinedFrom ? 'REFINEMENT: the first reference image is the existing image. Keep its composition, characters, layout and art style; apply ONLY the change requested below.' : '', `SCENE: ${p.prompt}`, p.direction && `ARTISTIC DIRECTION: ${p.direction}`].filter(Boolean).join('\n');
}

export const eligibleForLowModeration = (env, email) => {
  const e = String(email || '').toLowerCase(); if (!e) return false;
  const list = String(env.ADULT_BETA_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return e === String(env.OWNER_EMAIL || '').toLowerCase() || list.includes(e);
};
