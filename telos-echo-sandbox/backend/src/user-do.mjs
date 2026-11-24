/**
 * One Durable Object per tester. Holds that user's private uploads, jobs, images and free-generation
 * entitlements in SQLite (isolated per user: another user's DO cannot be addressed from a user request).
 * Generation runs from the DO alarm using the SAME service/adapter/prompt modules as the sandbox (../../src).
 * The Worker authenticates; this class trusts only requests the Worker forwards (it sets x-telos-user).
 */
import { DurableObject } from 'cloudflare:workers';
import { createSceneImageService } from '../../src/scene-image-service.mjs';
import { createOpenAIImageAdapter } from '../../src/openai-image-api.mjs';
import { ApiError, parseConfig, costFromUsage, dayKey, containsMinorSignal, sniffImage, firstNumber, normalizeOnboarding, KINDS, isKind, baseKind } from './common.mjs';
import { screenUpload, screenOutput } from './safety.mjs';
import { PREBUILT, PREBUILT_VERSION, refPlan, prebuiltScene, normalizePrebuilt } from './prebuilt-canon.mjs';
import { STYLES, WORLD_IDS, WORLD_VISUAL, worldCanon, SUB_WORLDS, MARIS_DEEP_SPECIES, COLLAGE_COUNTS, COLLAGE_ROWS, MAX_ECHO_REFS, QUOTE_TTL_MS, skolPrices, priceFor, normalizeFormat, normalizeEcho, sizeFor, echoDirection, styleId, eligibleForLowModeration } from './echo.mjs';

const CHUNK = 900_000;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_STATE_VALUE = 1_900_000, MAX_STATE_KEYS = 400;
const MAX_ECHO_POSTS = 500, MAX_ECHO_UPLOADS_PER_DAY = 30;
function cleanCaption(c) { const t = String(c ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim(); if (t.length > 2200) throw new ApiError(400, 'CAPTION_TOO_LONG'); return t; }
const PREBUILT_KIND = 'prebuilt';
const STALE_WORKING_MS = 10 * 60 * 1000;
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 22);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : Array.isArray(v) ? v.map(stable) : v);

export class UserState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }
  get cfg() { return parseConfig(this.env); }
  get devMock() { return this.env.DEV_BYPASS_AUTH === 'true' && !!this.env.OPENAI_API_BASE; }
  get unlimited() { const o = String(this.env.OWNER_EMAIL || '').toLowerCase(); return !!o && this.meta('email') === o && this.env.OWNER_UNLIMITED !== 'false'; }
  get ledger() { return this.env.LEDGER.get(this.env.LEDGER.idFromName('global')); }
  q(s, ...b) { return this.sql.exec(s, ...b).toArray(); }
  one(s, ...b) { return this.q(s, ...b)[0] ?? null; }
  run(s, ...b) { return this.sql.exec(s, ...b).rowsWritten; }
  meta(k, d = null) { const r = this.one('SELECT v FROM meta WHERE k=?', k); return r ? JSON.parse(r.v) : d; }
  setMeta(k, v) { this.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v)); }

  migrate() {
    for (const s of [
      'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS blob_chunks(blob_id TEXT, idx INTEGER, data BLOB, PRIMARY KEY(blob_id, idx))',
      'CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, blob_id TEXT NOT NULL, certified TEXT NOT NULL, screening TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE, kind TEXT, hash TEXT, params TEXT, state TEXT, failure TEXT, result TEXT, refunded INTEGER NOT NULL DEFAULT 0, ledger_id TEXT, created_at INTEGER, updated_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, job_id TEXT, kind TEXT, blob_id TEXT, meta TEXT, accepted INTEGER NOT NULL DEFAULT 0, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, kind TEXT, job_idem TEXT UNIQUE, state TEXT, ts INTEGER)',
      'CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, job_id TEXT, ts INTEGER, model TEXT, usd REAL, estimated INTEGER, raw TEXT)',
      'CREATE TABLE IF NOT EXISTS diag(job_id TEXT PRIMARY KEY, ts INTEGER, code TEXT, detail TEXT)',
      'CREATE TABLE IF NOT EXISTS echo_refs(id TEXT PRIMARY KEY, blob_id TEXT NOT NULL, certified TEXT NOT NULL, screening TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS echo_posts(id TEXT PRIMARY KEY, source TEXT NOT NULL, image_id TEXT, blob_id TEXT, certified TEXT, caption TEXT NOT NULL DEFAULT \'\', world TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS app_state(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, bind TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER)'
    ]) this.sql.exec(s);
  }

  // ---------- blobs ----------
  putBlob(bytes, mime) {
    const id = rid(); const src = new Uint8Array(bytes);
    this.ctx.storage.transactionSync(() => {
      this.run('INSERT INTO blobs(id,mime,size,created_at) VALUES(?,?,?,?)', id, mime, src.byteLength, Date.now());
      for (let i = 0, idx = 0; i < src.byteLength; i += CHUNK, idx++) this.run('INSERT INTO blob_chunks(blob_id,idx,data) VALUES(?,?,?)', id, idx, src.slice(i, i + CHUNK).buffer);
    });
    return id;
  }
  getBlob(id) {
    const m = this.one('SELECT mime,size FROM blobs WHERE id=?', id); if (!m) return null;
    const out = new Uint8Array(m.size); let off = 0;
    for (const r of this.q('SELECT data FROM blob_chunks WHERE blob_id=? ORDER BY idx', id)) { const u = new Uint8Array(r.data); out.set(u, off); off += u.byteLength; }
    return { bytes: out, mime: m.mime };
  }
  delBlob(id) { this.run('DELETE FROM blob_chunks WHERE blob_id=?', id); this.run('DELETE FROM blobs WHERE id=?', id); }

  // ---------- entitlements ----------
  allowed(kind) { return (kind === 'avatar' ? this.cfg.freeAvatar : kind === PREBUILT_KIND ? this.cfg.freePrebuilt : this.cfg.freeTelo) + (this.meta(`extra_${kind}`, 0)); }
  used(kind) { return this.one("SELECT COUNT(*) n FROM grants WHERE kind=? AND state IN ('held','committed')", kind).n; }
  accepted(kind) { return this.one('SELECT id FROM images WHERE kind=? AND accepted=1', kind)?.id ?? null; }

  callsToday(now) {
    const tz = this.cfg.timeZone, today = dayKey(now, tz);
    return this.q('SELECT created_at FROM jobs WHERE created_at>?', now - 2 * 864e5).filter((j) => dayKey(j.created_at, tz) === today).length;
  }

  // ---------- http ----------
  async fetch(request) {
    try {
      const email = request.headers.get('x-telos-user');
      if (!email) throw new ApiError(401, 'NO_USER');
      if (this.meta('email') !== email) this.setMeta('email', email);
      return await this.route(request);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, ...e.extra }, e.status);
      console.error('user_internal', e?.message);
      return json({ error: 'INTERNAL' }, 500);
    }
  }
  async body(request) {
    const text = await request.text();
    if (text.length > MAX_JSON_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE');
    try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { throw new ApiError(400, 'BAD_JSON'); }
  }

  async route(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const m = request.method, [root, a, b, c] = parts;
    if (root !== 'api') throw new ApiError(404, 'NOT_FOUND');
    if (a === 'me' && !b && m === 'GET') return json(this.me(url.searchParams.get('telo')));
    if (a === 'me' && b === 'purge' && m === 'POST') return json(await this.purge(await this.body(request)));
    if (a === 'uploads') {
      if (m === 'POST' && !b) return json(await this.addUpload(request));
      if (m === 'GET' && b && c === 'image') return this.uploadImage(b);
      if (m === 'DELETE' && b) return json(this.deleteUpload(b));
    }
    if (a === 'onboarding' && isKind(b)) {
      if (c === 'generate' && m === 'POST') return json(await this.generate(b, await this.body(request)));
      if (c === 'accept' && m === 'POST') return json(this.accept(b, await this.body(request)));
    }
    if (a === 'echo') return this.echoRoute(request, m, parts);
    if (a === 'state') return this.stateRoute(request, m, parts);
    if (a === 'prebuilt' && b && c === 'generate' && m === 'POST') return json(await this.generatePrebuilt(b, await this.body(request)));
    if (a === 'jobs' && b && m === 'GET') return json(this.jobView(b));
    if (a === 'images' && b && m === 'DELETE') return json(this.deletePrebuiltImage(b));
    if (a === 'images' && b && m === 'GET') return this.imageBytes(b);
    // internal admin routes: the Worker only forwards these for the owner
    if (a === '_admin') {
      if (b === 'allowance' && m === 'POST') {
        const j = await this.body(request);
        if (![...KINDS, PREBUILT_KIND].includes(j.kind) || !Number.isInteger(j.extra) || j.extra < 1 || j.extra > 20) throw new ApiError(400, 'FIELD_INVALID');
        this.setMeta(`extra_${j.kind}`, this.meta(`extra_${j.kind}`, 0) + j.extra);
        return json(this.me());
      }
      if (b === 'overview' && m === 'GET') return json({ email: this.meta('email'), ...this.me() });
    }
    throw new ApiError(404, 'NOT_FOUND');
  }

  // ---------- views ----------
  kindView(kind) {
    const allowed = this.allowed(kind), used = this.used(kind), unl = this.unlimited;
    return {
      unlimited: unl, freeTotal: unl ? null : allowed, used, remaining: unl ? null : Math.max(0, allowed - used), acceptedImageId: this.accepted(kind),
      images: this.q('SELECT id,job_id,accepted,created_at FROM images WHERE kind=? ORDER BY created_at', kind).map((r) => ({ id: r.id, jobId: r.job_id, accepted: !!r.accepted, createdAt: r.created_at })),
      pendingJob: this.one("SELECT id,state FROM jobs WHERE kind=? AND state IN ('created','working') ORDER BY created_at DESC LIMIT 1", kind),
      ...(baseKind(kind) === 'telo' || kind === 'avatar' ? {
        hasPackage: !!this.one('SELECT 1 x FROM images WHERE kind=?', kind),
        acceptedFaceImageId: this.one("SELECT id FROM images WHERE kind=? AND accepted=1", kind + '_face')?.id ?? null,
        faceImages: this.q('SELECT id,job_id,accepted,created_at FROM images WHERE kind=? ORDER BY created_at', kind + '_face').map((r) => ({ id: r.id, jobId: r.job_id, accepted: !!r.accepted, createdAt: r.created_at }))
      } : {})
    };
  }
  me(scopedTeloId) {
    const cfg = this.cfg, now = Date.now();
    const scoped = scopedTeloId && /^[A-Za-z0-9_-]{1,40}$/.test(scopedTeloId) ? 'telo~' + scopedTeloId : null;   // a Telō created after onboarding: its own package + redos
    return {
      ...(scoped ? { [scoped]: this.kindView(scoped) } : {}),
      avatar: this.kindView('avatar'), telo: this.kindView('telo'), prebuilt: this.kindView(PREBUILT_KIND),
      uploads: this.q('SELECT id,certified,created_at FROM uploads ORDER BY created_at').map((r) => ({ id: r.id, certifiedAs: r.certified, createdAt: r.created_at })),
      limits: { callsToday: this.callsToday(now), callsPerDay: cfg.maxCallsPerDayUser, minIntervalMs: cfg.minSubmitIntervalMs },
      config: { quality: cfg.quality, size: cfg.size, allowPhotoUploads: cfg.allowPhotoUploads, maxPhotos: cfg.maxPhotos, keyConfigured: !!this.env.OPENAI_API_KEY || this.devMock },
      serverTime: now
    };
  }
  jobView(id) {
    const j = this.one('SELECT id,kind,state,failure,refunded,result,created_at FROM jobs WHERE id=?', id);
    if (!j) throw new ApiError(404, 'NOT_FOUND');
    const r = j.result ? JSON.parse(j.result) : null;
    return { id: j.id, kind: j.kind, state: j.state, failure: j.failure ?? null, refunded: !!j.refunded, imageId: r?.imageId ?? null, faceImageId: r?.faceImageId ?? null, createdAt: j.created_at, remaining: this.unlimited ? null : Math.max(0, this.allowed(j.kind) - this.used(j.kind)) };
  }
  imageBytes(id) {
    const r = this.one('SELECT blob_id FROM images WHERE id=?', id); const b = r && this.getBlob(r.blob_id);
    if (!b) throw new ApiError(404, 'NOT_FOUND');
    return new Response(b.bytes, { headers: { 'content-type': b.mime, 'cache-control': 'private, no-store' } });
  }

  // ---------- uploads (avatar likeness photos only; Master 18.7A) ----------
  async addUpload(request) {
    const cfg = this.cfg;
    if (!cfg.allowPhotoUploads) throw new ApiError(403, 'PHOTO_UPLOADS_DISABLED');
    // Avatar likeness photos (Master 18.7A): certification 'self' | 'permission'. Imported-character references for the Telō (Master 14B.1A): certification 'rights'.
    const cert = request.headers.get('x-certify');
    if (!['self', 'permission', 'rights'].includes(cert)) throw new ApiError(400, 'CERTIFICATION_REQUIRED');
    const kind = cert === 'rights' ? 'telo' : 'avatar';
    if (this.accepted(kind) && !this.unlimited) throw new ApiError(409, 'ALREADY_ACCEPTED');
    if (this.one(`SELECT COUNT(*) n FROM uploads WHERE ${kind === 'telo' ? "certified='rights'" : "certified!='rights'"}`).n >= cfg.maxPhotos) throw new ApiError(400, 'TOO_MANY_PHOTOS', { max: cfg.maxPhotos });
    const len = Number(request.headers.get('content-length') || 0);
    if (len > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const mime = sniffImage(bytes);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE');
    const screen = await screenUpload({ bytes, mime }, this.env);
    if (!screen.ok) throw new ApiError(422, screen.code);
    const id = rid();
    this.run('INSERT INTO uploads(id,blob_id,certified,screening,created_at) VALUES(?,?,?,?,?)', id, this.putBlob(bytes, mime), cert, screen.status, Date.now());
    return { id };
  }
  uploadImage(id) {
    const r = this.one('SELECT blob_id FROM uploads WHERE id=?', id); const b = r && this.getBlob(r.blob_id);
    if (!b) throw new ApiError(404, 'NOT_FOUND');
    return new Response(b.bytes, { headers: { 'content-type': b.mime, 'cache-control': 'private, no-store' } });
  }
  deleteUpload(id) {
    const r = this.one('SELECT blob_id FROM uploads WHERE id=?', id);
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    this.delBlob(r.blob_id); this.run('DELETE FROM uploads WHERE id=?', id);
    return { ok: true };
  }

  // ---------- prebuilt Telō canon references (seeded by the Worker over RPC; never reachable from a client request) ----------
  /** Claude relay daily cap (Worker-only RPC): counts this account's relayed calls per UTC day. The owner/unlimited account is never capped. */
  claudeTick(cap, now = Date.now()) {
    const day = Math.floor(now / 864e5), cur = this.meta('claudeDay', null);
    const used = cur && cur.day === day ? cur.n : 0;
    if (!this.unlimited && used >= cap) return { ok: false, used };
    this.setMeta('claudeDay', { day, n: used + 1 });
    return { ok: true, used: used + 1 };
  }
  hasCanon(charId) { return this.meta(`canon_${charId}`)?.version === PREBUILT_VERSION; }
  seedCanon(charId, files) {
    const c = PREBUILT[charId]; if (!c) throw new ApiError(404, 'NOT_FOUND');
    const old = this.meta(`canon_${charId}`);
    const next = {};
    for (const [path, bytes] of Object.entries(files)) next[path] = this.putBlob(bytes, sniffImage(new Uint8Array(bytes)) ?? 'image/jpeg');
    this.setMeta(`canon_${charId}`, { version: PREBUILT_VERSION, files: next });
    if (old?.files) for (const id of Object.values(old.files)) this.delBlob(id);
    return true;
  }
  canonRefs(charId, form, hasOutfit, mode, slot) {
    const rec = this.meta(`canon_${charId}`);
    if (rec?.version !== PREBUILT_VERSION) throw new Error('CANON_REFERENCES_UNAVAILABLE');
    return refPlan(charId, form, hasOutfit, mode, slot).map((r) => {
      const b = rec.files[r.file] && this.getBlob(rec.files[r.file]);
      if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
      return { bytes: b.bytes, mime: b.mime, label: r.label, ...(r.role === 'mask' ? { role: 'mask' } : {}) };
    });
  }

  // ---------- generate ----------
  async generatePrebuilt(charId, body) {
    const p = normalizePrebuilt(charId, body);
    if (!this.hasCanon(charId)) throw new ApiError(503, 'CANON_NOT_SEEDED');
    return this.admit(PREBUILT_KIND, p);
  }
  async generate(kind, body) {
    return this.admit(kind, normalizeOnboarding(kind, body));
  }
  deletePrebuiltImage(id) {
    const r = this.one('SELECT blob_id,kind FROM images WHERE id=?', id);
    if (!r || (r.kind !== PREBUILT_KIND && r.kind !== 'echo')) throw new ApiError(404, 'NOT_FOUND');
    this.delBlob(r.blob_id); this.run('DELETE FROM images WHERE id=?', id);
    return { ok: true };
  }
  async admit(kind, p) {
    const cfg = this.cfg, now = Date.now();
    const hash = await sha(JSON.stringify(stable(p)));
    const prior = this.one('SELECT id,hash FROM jobs WHERE idem=?', p.idempotencyKey);
    if (prior) {                                       // idempotent replay: same key -> same job, no new spend
      if (prior.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return { ...this.jobView(prior.id), replay: true };
    }
    if (!cfg.generationEnabled) throw new ApiError(503, 'GENERATION_PAUSED');
    if (!this.env.OPENAI_API_KEY && !this.devMock) throw new ApiError(503, 'OPENAI_KEY_MISSING');
    if (kind !== PREBUILT_KIND && this.accepted(kind) && !this.unlimited) throw new ApiError(409, 'ALREADY_ACCEPTED');
    const last = this.meta('lastSubmitAt', 0);
    if (last && now - last < cfg.minSubmitIntervalMs) throw new ApiError(429, 'TOO_SOON', { retryAfterMs: cfg.minSubmitIntervalMs - (now - last) });
    if (this.one("SELECT COUNT(*) n FROM jobs WHERE state IN ('created','working')").n >= cfg.maxQueuedUser) throw new ApiError(429, 'TOO_MANY_QUEUED');
    const calls = (baseKind(kind) === 'telo' || kind === 'avatar') && p.part === 'package' ? 2 : 1;      // a Telō package is two provider calls under one allotment unit
    if (!this.unlimited && this.callsToday(now) + calls > cfg.maxCallsPerDayUser) throw new ApiError(429, 'DAILY_CALL_CAP', { cap: cfg.maxCallsPerDayUser });
    if (baseKind(kind) === 'telo' || kind === 'avatar') {
      const has = !!this.one('SELECT 1 x FROM images WHERE kind=?', kind);
      if (p.part === 'package' && has && !this.unlimited) throw new ApiError(409, 'PACKAGE_ALREADY_GENERATED');
      if (p.part !== 'package' && !has) throw new ApiError(400, 'PACKAGE_REQUIRED');
      if (p.part === 'face' && this.one('SELECT kind FROM images WHERE id=?', p.refImageId)?.kind !== kind) throw new ApiError(404, 'REF_IMAGE_NOT_FOUND');
    }
    for (const id of p.photoIds) { const u = this.one('SELECT certified FROM uploads WHERE id=?', id); if (!u) throw new ApiError(404, 'PHOTO_NOT_FOUND', { id }); if ((u.certified === 'rights') !== (baseKind(kind) === 'telo')) throw new ApiError(400, 'PHOTO_WRONG_PURPOSE', { id }); }
    if (!this.unlimited && this.used(kind) >= this.allowed(kind)) throw new ApiError(402, 'FREE_ALLOTMENT_USED');
    if (!cfg.allowPhotoUploads && p.photoIds.length) throw new ApiError(403, 'PHOTO_UPLOADS_DISABLED');

    const email = this.meta('email');
    const res = await this.ledger.reserve(email, cfg.estUsdPerCall * calls);
    if (!res.ok) throw new ApiError(429, res.code);

    const jobId = rid();
    try {
      this.ctx.storage.transactionSync(() => {
        this.run("INSERT INTO jobs(id,idem,kind,hash,params,state,ledger_id,created_at,updated_at) VALUES(?,?,?,?,?,'created',?,?,?)", jobId, p.idempotencyKey, kind, hash, JSON.stringify({ ...p, moderationMode: this.echoModeration().mode }), res.id, now, now);
        this.run("INSERT INTO grants(id,kind,job_idem,state,ts) VALUES(?,?,?,'held',?)", rid(), kind, p.idempotencyKey, now);
        this.setMeta('lastSubmitAt', now);
      });
    } catch (e) { await this.ledger.cancel(res.id); throw e; }
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { ...this.jobView(jobId), replay: false };
  }


  // ---------- Echō images: Single Image / Collage (one provider request per canvas) ----------
  echoModeration() {
    // Low filtering is only for a server-allowlisted adult-beta tester (ADULT_BETA_EMAILS / owner) while the deployment switch allows it. Nothing the browser sends can grant it.
    const enabled = this.env.ECHO_LOW_MODERATION !== 'false' && eligibleForLowModeration(this.env, this.meta('email'));
    const saved = this.meta('echoModeration', null);
    const mode = !enabled ? 'auto' : saved === null ? 'low' : (saved === 'low' || saved === 'auto' ? saved : 'auto');
    return { enabled, mode, defaultMode: enabled ? 'low' : 'auto', modes: enabled ? ['auto', 'low'] : ['auto'] };
  }
  echoSubjects(p) {
    const people = (p.refs ?? []).filter((r) => r[0] !== 's');
    if (!people.length) return [{ id: 'echo-scene', name: 'Any people in the scene' }];
    return people.map((r, i) => ({ id: `ref${i + 1}`, name: `Subject from reference image ${i + 1}` }));
  }
  async echoRefImages(p) {
    const out = [];
    let person = 0;
    for (let i = 0; i < p.refs.length; i++) {
      const t = p.refs[i][0], id = p.refs[i].slice(2);
      if (t === 's') {
        // A venue interior shipped with the app: fetched from the app's own assets, used only as the setting.
        let ab = null;
        for (const ext of ['jpg', 'png']) {
          const a = await this.env.ASSETS.fetch(new Request(`https://assets.local/_blob/${id}.${ext}`)).catch(() => null);
          if (a && a.ok) { ab = new Uint8Array(await a.arrayBuffer()); if (sniffImage(ab)) break; ab = null; }
        }
        const mime = ab && sniffImage(ab);
        if (!mime) throw new Error('CANON_REFERENCES_UNAVAILABLE');
        out.push({ bytes: ab, mime, label: 'the VENUE INTERIOR — the setting of this scene, not a person. Reproduce this exact room: its architecture, artwork, furnishings, materials, lighting and colour palette. Place the subjects inside it.' });
        continue;
      }
      person++;
      const row = t === 'i' ? this.one('SELECT blob_id FROM images WHERE id=?', id) : this.one('SELECT blob_id FROM echo_refs WHERE id=?', id);
      const b = row && this.getBlob(row.blob_id);
      if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
      out.push({ bytes: b.bytes, mime: b.mime, label: i === 0 && p.refinedFrom
        ? 'the EXISTING image to refine (SUBJECT 1) — keep its composition, characters, layout and art style'
        : `reference image for SUBJECT ${person} — keep this exact person: face, skin tone, hair, build, clothing` });
    }
    return out;
  }
  echoRefList() {
    const own = this.q("SELECT id,kind,created_at FROM images WHERE accepted=1 AND (kind='avatar' OR kind='telo' OR kind LIKE 'telo~%') ORDER BY created_at").filter((r) => !r.kind.endsWith('_face'))
      .map((r) => ({ ref: 'i:' + r.id, source: r.kind === 'avatar' ? 'avatar' : 'telo', kind: r.kind, createdAt: r.created_at }));
    const up = this.q('SELECT id,certified,created_at FROM echo_refs ORDER BY created_at').map((r) => ({ ref: 'u:' + r.id, source: 'upload', certifiedAs: r.certified, createdAt: r.created_at }));
    return [...own, ...up];
  }
  echoImages() {
    return this.q("SELECT id,meta,created_at FROM images WHERE kind='echo' ORDER BY created_at DESC LIMIT 60").map((r) => {
      let m = {}; try { m = JSON.parse(r.meta) ?? {}; } catch { /* ignore */ }
      return { id: r.id, createdAt: r.created_at, format: m.format ?? 'single', panelCount: m.panelCount ?? null, showPanelNumbers: m.showPanelNumbers === true, style: m.style ?? 'realism', world: m.world ?? null, subWorld: m.subWorld ?? null,
        aspect: m.aspect ?? 'portrait', refinedFrom: m.refinedFrom ?? null, scene: m.scene ?? '', captions: Array.isArray(m.captions) ? m.captions : [], moderation: m.moderation ?? null };
    });
  }
  // Test-account Sköl allowance. No wallet or earning exists yet, so every account gets enough Sköl for
  // SKOL_TEST_COLLAGES (default 3) nine-panel collages per image window. The window is the same calendar day
  // that resets the daily image-call cap. Balance is DERIVED (cap minus today's unrefunded charges), so it resets
  // and tops off on its own when the day rolls over, and a failed job refunds itself.
  skolWallet(now = Date.now()) {
    const prices = skolPrices(this.env);
    if (!prices.collage || this.unlimited || String(this.env.SKOL_TEST_ALLOWANCE ?? '') === 'off') return null;   // the owner account is never limited by the test allowance
    const n = Number(this.env.SKOL_TEST_COLLAGES), collages = Number.isSafeInteger(n) && n > 0 ? n : 3;
    const cap = collages * prices.collage[9], tz = this.cfg.timeZone, today = dayKey(now, tz);
    let spent = 0;
    for (const j of this.q("SELECT params,created_at FROM jobs WHERE kind='echo' AND refunded=0 AND created_at>?", now - 2 * 864e5)) {
      if (dayKey(j.created_at, tz) !== today) continue;
      try { spent += Number(JSON.parse(j.params).skolQuoted) || 0; } catch { /* purged params carry no charge */ }
    }
    let resetsAt = now + 60e3; while (dayKey(resetsAt, tz) === today && resetsAt < now + 26 * 3600e3) resetsAt += 60e3;
    return { cap, balance: Math.max(0, cap - spent), resetsAt: new Date(resetsAt).toISOString() };
  }
  echoImageMeta(id) {
    const r = this.one("SELECT meta FROM images WHERE id=? AND kind='echo'", id);
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    try { return JSON.parse(r.meta) ?? {}; } catch { return {}; }
  }
  echoOptions() {
    const cfg = this.cfg, prices = skolPrices(this.env);
    return {
      styles: STYLES.map(({ id, label, tier }) => ({ id, label, tier })), worlds: WORLD_IDS, subWorlds: SUB_WORLDS, marisDeepSpecies: MARIS_DEEP_SPECIES, collageCounts: COLLAGE_COUNTS, rows: COLLAGE_ROWS, maxRefs: MAX_ECHO_REFS,
      pricing: { currency: 'Sköl', collageConfigured: !!prices.collage, charged: !!this.skolWallet() },
      wallet: this.skolWallet(),
      moderation: this.echoModeration(), refs: this.echoRefList(), images: this.echoImages(),
      limits: { callsToday: this.callsToday(Date.now()), callsPerDay: cfg.maxCallsPerDayUser },
      config: { generationEnabled: cfg.generationEnabled, keyConfigured: !!this.env.OPENAI_API_KEY || this.devMock, allowPhotoUploads: cfg.allowPhotoUploads }
    };
  }
  async echoRoute(request, m, parts) {
    const [, , b, c, d] = parts;
    if (b === 'options' && m === 'GET') return json(this.echoOptions());
    if (b === 'settings' && m === 'POST') {
      const j = await this.body(request);
      if (Object.keys(j).some((k) => k !== 'mode') || !['auto', 'low'].includes(j.mode)) throw new ApiError(400, 'FIELD_INVALID');
      if (!this.echoModeration().enabled) throw new ApiError(403, 'IMAGE_SETTING_NOT_ALLOWED');
      this.setMeta('echoModeration', j.mode);
      return json(this.echoModeration());
    }
    if (b === 'profile') {
      if (m === 'GET') return json(this.echoProfile());
      if (m === 'POST') return json(this.setEchoProfile(await this.body(request)));
    }
    if (b === 'posts') {
      if (m === 'GET' && !c) return json({ posts: this.echoPostList() });
      if (m === 'POST' && !c) return json(this.addEchoPost(await this.body(request)));
      if (m === 'POST' && c === 'upload') return json(await this.addEchoUploadPost(request));
      if (m === 'GET' && c && d === 'image') {
        const r = this.one('SELECT source,image_id,blob_id FROM echo_posts WHERE id=?', c);
        const row = r && (r.source === 'upload' ? { blob_id: r.blob_id } : this.one("SELECT blob_id FROM images WHERE id=? AND kind='echo'", r.image_id));
        const bl = row && this.getBlob(row.blob_id); if (!bl) throw new ApiError(404, 'NOT_FOUND');
        return new Response(bl.bytes, { headers: { 'content-type': bl.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
      }
      if (m === 'POST' && c && !d) { const j = await this.body(request); if (!this.one('SELECT 1 x FROM echo_posts WHERE id=?', c)) throw new ApiError(404, 'NOT_FOUND'); this.run('UPDATE echo_posts SET caption=? WHERE id=?', cleanCaption(j.caption), c); return json({ ok: true }); }
      if (m === 'DELETE' && c) { const r = this.one('SELECT source,blob_id FROM echo_posts WHERE id=?', c); if (!r) throw new ApiError(404, 'NOT_FOUND'); if (r.source === 'upload' && r.blob_id) this.delBlob(r.blob_id); this.run('DELETE FROM echo_posts WHERE id=?', c); return json({ ok: true }); }
    }
    if (b === 'quote' && m === 'POST') return json(await this.echoQuote(await this.body(request)));
    if (b === 'generate' && m === 'POST') return json(await this.admitEcho(await this.body(request)));
    if (b === 'captions' && m === 'POST') return json(this.echoCaptions(await this.body(request)));
    if (b === 'refs') {
      if (m === 'POST' && !c) return json(await this.addEchoRef(request));
      if (m === 'GET' && c && d === 'image') { const r = this.one('SELECT blob_id FROM echo_refs WHERE id=?', c); const bl = r && this.getBlob(r.blob_id); if (!bl) throw new ApiError(404, 'NOT_FOUND'); return new Response(bl.bytes, { headers: { 'content-type': bl.mime, 'cache-control': 'private, no-store' } }); }
      if (m === 'DELETE' && c) { const r = this.one('SELECT blob_id FROM echo_refs WHERE id=?', c); if (!r) throw new ApiError(404, 'NOT_FOUND'); this.delBlob(r.blob_id); this.run('DELETE FROM echo_refs WHERE id=?', c); return json({ ok: true }); }
    }
    throw new ApiError(404, 'NOT_FOUND');
  }
  // ---- Account copy of the app's own saved data (profile, Telōs, progress) so every device of this account sees the same thing ----
  async stateRoute(request, m, parts) {
    if (m === 'GET' && !parts[2]) return json({ items: this.q('SELECT k,v,updated_at FROM app_state').map((r) => ({ key: r.k, value: r.v, updatedAt: r.updated_at })), now: Date.now() });
    let key = ''; try { key = decodeURIComponent(parts[2] ?? ''); } catch { key = ''; }
    if (!/^[A-Za-z0-9_\-.~:@+]{1,190}$/.test(key)) throw new ApiError(400, 'KEY_INVALID');
    if (m === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_STATE_VALUE) throw new ApiError(413, 'STATE_TOO_LARGE');
      try { JSON.parse(text); } catch { throw new ApiError(400, 'BAD_JSON'); }
      if (!this.one('SELECT 1 x FROM app_state WHERE k=?', key) && this.one('SELECT COUNT(*) n FROM app_state').n >= MAX_STATE_KEYS) throw new ApiError(400, 'TOO_MANY_KEYS');
      const ts = Math.min(Date.now(), Number(request.headers.get('x-saved-at')) || Date.now());
      this.run('INSERT INTO app_state(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at', key, text, ts);
      return json({ ok: true, updatedAt: ts });
    }
    if (m === 'DELETE') { this.run('DELETE FROM app_state WHERE k=?', key); return json({ ok: true }); }
    throw new ApiError(404, 'NOT_FOUND');
  }
  // ---- Echō profile and moments (private to the owner for now: no followers or other accounts exist yet) ----
  echoProfile() {
    let prof = {}; try { prof = JSON.parse(this.meta('echoProfile') || '{}') || {}; } catch { prof = {}; }
    const posts = this.echoPostList();
    const av = this.one("SELECT id FROM images WHERE kind='avatar_face' AND accepted=1 ORDER BY created_at DESC LIMIT 1") || this.one("SELECT id FROM images WHERE kind='avatar' AND accepted=1 ORDER BY created_at DESC LIMIT 1");
    return { handle: prof.handle ?? null, bio: prof.bio ?? '', avatarImageId: av ? av.id : null, counts: { posts: posts.length, followers: 0, following: 0 }, posts, maxPosts: MAX_ECHO_POSTS };
  }
  setEchoProfile(j) {
    const out = {};
    if (j.handle !== undefined) { const h = String(j.handle).trim().toLowerCase(); if (!/^[a-z0-9._]{3,30}$/.test(h)) throw new ApiError(400, 'HANDLE_INVALID'); out.handle = h; }
    if (j.bio !== undefined) { const b = String(j.bio).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); if (b.length > 150) throw new ApiError(400, 'BIO_TOO_LONG'); out.bio = b; }
    let cur = {}; try { cur = JSON.parse(this.meta('echoProfile') || '{}') || {}; } catch { cur = {}; }
    this.setMeta('echoProfile', JSON.stringify({ ...cur, ...out }));
    return this.echoProfile();
  }
  echoPostList() {
    return this.q('SELECT id,source,image_id,caption,world,created_at FROM echo_posts ORDER BY created_at DESC').filter((r) => r.source === 'upload' || this.one("SELECT 1 x FROM images WHERE id=? AND kind='echo'", r.image_id))
      .map((r) => ({ id: r.id, source: r.source, caption: r.caption, world: r.world, createdAt: new Date(r.created_at).toISOString() }));
  }
  addEchoPost(j) {
    const imageId = String(j.imageId ?? '');
    const img = this.one("SELECT id,meta FROM images WHERE id=? AND kind='echo'", imageId);
    if (!img) throw new ApiError(404, 'NOT_FOUND');
    const dup = this.one("SELECT id FROM echo_posts WHERE source='image' AND image_id=?", imageId);
    if (dup) throw new ApiError(409, 'ALREADY_ECHOED', { id: dup.id });
    if (this.one('SELECT COUNT(*) n FROM echo_posts').n >= MAX_ECHO_POSTS) throw new ApiError(400, 'TOO_MANY_ECHOES', { max: MAX_ECHO_POSTS });
    let world = null; try { world = JSON.parse(img.meta)?.world ?? null; } catch { world = null; }
    const id = rid();
    this.run("INSERT INTO echo_posts(id,source,image_id,blob_id,certified,caption,world,created_at) VALUES(?,?,?,?,?,?,?,?)", id, 'image', imageId, null, null, cleanCaption(j.caption), world, Date.now());
    return { id };
  }
  async addEchoUploadPost(request) {
    const cfg = this.cfg;
    if (!cfg.allowPhotoUploads) throw new ApiError(403, 'PHOTO_UPLOADS_DISABLED');
    if (request.headers.get('x-certify') !== 'sfw-rights') throw new ApiError(400, 'CERTIFICATION_REQUIRED');
    if (this.one('SELECT COUNT(*) n FROM echo_posts').n >= MAX_ECHO_POSTS) throw new ApiError(400, 'TOO_MANY_ECHOES', { max: MAX_ECHO_POSTS });
    const dayAgo = Date.now() - 864e5;
    if (this.one("SELECT COUNT(*) n FROM echo_posts WHERE source='upload' AND created_at>?", dayAgo).n >= MAX_ECHO_UPLOADS_PER_DAY) throw new ApiError(429, 'ECHO_UPLOAD_LIMIT', { max: MAX_ECHO_UPLOADS_PER_DAY });
    const len = Number(request.headers.get('content-length') || 0);
    if (len > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const mime = sniffImage(bytes);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE');
    const screen = await screenUpload({ bytes, mime }, this.env);
    if (!screen.ok) throw new ApiError(422, screen.code);
    let caption = ''; try { caption = decodeURIComponent(request.headers.get('x-caption') || ''); } catch { caption = ''; }
    const w = request.headers.get('x-world'); const world = WORLD_IDS.includes(w) ? w : null;
    const id = rid();
    this.run('INSERT INTO echo_posts(id,source,image_id,blob_id,certified,caption,world,created_at) VALUES(?,?,?,?,?,?,?,?)', id, 'upload', null, this.putBlob(bytes, mime), 'sfw-rights', cleanCaption(caption), world, Date.now());
    return { id };
  }
  async addEchoRef(request) {
    const cfg = this.cfg;
    if (!cfg.allowPhotoUploads) throw new ApiError(403, 'PHOTO_UPLOADS_DISABLED');
    const cert = request.headers.get('x-certify');
    if (!['self', 'permission', 'rights'].includes(cert)) throw new ApiError(400, 'CERTIFICATION_REQUIRED');
    if (this.one('SELECT COUNT(*) n FROM echo_refs').n >= 9) throw new ApiError(400, 'TOO_MANY_PHOTOS', { max: 9 });
    const len = Number(request.headers.get('content-length') || 0);
    if (len > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > cfg.maxPhotoBytes) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: cfg.maxPhotoBytes });
    const mime = sniffImage(bytes);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE');
    const screen = await screenUpload({ bytes, mime }, this.env);
    if (!screen.ok) throw new ApiError(422, screen.code);
    const id = rid();
    this.run('INSERT INTO echo_refs(id,blob_id,certified,screening,created_at) VALUES(?,?,?,?,?)', id, this.putBlob(bytes, mime), cert, screen.status, Date.now());
    return { id, ref: 'u:' + id };
  }
  echoCaptions(body) {
    // Captions / dialogue / number preference are overlays stored beside the image — never printed into the generated art.
    const r = this.one("SELECT id,meta FROM images WHERE id=? AND kind='echo'", String(body.imageId ?? ''));
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    const meta = JSON.parse(r.meta);
    if (body.captions !== undefined) {
      const max = meta.panelCount ?? 1;
      if (!Array.isArray(body.captions) || body.captions.length > max || body.captions.some((x) => typeof x !== 'string' || x.length > 160)) throw new ApiError(400, 'FIELD_INVALID', { field: 'captions' });
      if (containsMinorSignal(...body.captions)) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
      meta.captions = body.captions;
    }
    if (body.showPanelNumbers !== undefined) { if (typeof body.showPanelNumbers !== 'boolean') throw new ApiError(400, 'FIELD_INVALID', { field: 'showPanelNumbers' }); meta.showPanelNumbers = body.showPanelNumbers; }
    this.run('UPDATE images SET meta=? WHERE id=?', JSON.stringify(meta), r.id);
    return { ok: true, images: this.echoImages() };
  }
  async echoQuote(body) {
    if (Object.keys(body).some((k) => !['format', 'panelCount', 'showPanelNumbers', 'refineOf', 'style', 'world', 'aspect'].includes(k))) throw new ApiError(400, 'FIELD_INVALID');   // a browser-supplied price is rejected outright
    const refine = body.refineOf !== undefined ? this.echoImageMeta(String(body.refineOf)) : null;
    const f = normalizeFormat(body, refine);
    const amount = priceFor(skolPrices(this.env), f.format, f.panelCount);
    if (!amount) throw new ApiError(503, 'IMAGE_PRICING_UNAVAILABLE');
    const now = Date.now();
    const wallet = this.skolWallet(now);
    if (wallet && amount > wallet.balance) throw new ApiError(402, 'INSUFFICIENT_SKOL', { balance: wallet.balance, price: amount, resetsAt: wallet.resetsAt });
    this.run('DELETE FROM quotes WHERE expires_at<?', now - 3600e3);
    this.run("UPDATE quotes SET state='superseded' WHERE state='open'");   // only the newest quote is ever valid; earlier ones cannot be redeemed
    const id = rid() + rid().slice(0, 6), bind = await sha(JSON.stringify(stable({ format: f.format, panelCount: f.panelCount, showPanelNumbers: f.showPanelNumbers })));
    this.run("INSERT INTO quotes(id,bind,amount,state,expires_at,created_at) VALUES(?,?,?,'open',?,?)", id, bind, amount, now + QUOTE_TTL_MS, now);
    return { quoteId: id, expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(), amountSkol: amount, currency: 'Sköl', usageUnits: 1, format: f.format, panelCount: f.panelCount, showPanelNumbers: f.showPanelNumbers, charged: !!wallet, balance: wallet ? wallet.balance : null, balanceAfter: wallet ? wallet.balance - amount : null, resetsAt: wallet ? wallet.resetsAt : null };
  }
  async admitEcho(body) {
    const cfg = this.cfg, now = Date.now();
    const refine = body.refineOf !== undefined ? this.echoImageMeta(String(body.refineOf)) : null;
    const p = normalizeEcho(body, refine);
    if (refine) { if (p.refs.length > MAX_ECHO_REFS - 1) throw new ApiError(400, 'FIELD_INVALID', { field: 'refs' }); p.refs = [`i:${p.refinedFrom}`, ...p.refs]; }
    const hash = await sha(JSON.stringify(stable(p)));
    const prior = this.one('SELECT id,hash FROM jobs WHERE idem=?', p.idempotencyKey);
    if (prior) { if (prior.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT'); return { ...this.jobView(prior.id), replay: true }; }   // same key -> same job: no second request, no second use
    if (!cfg.generationEnabled) throw new ApiError(503, 'GENERATION_PAUSED');
    if (!this.env.OPENAI_API_KEY && !this.devMock) throw new ApiError(503, 'OPENAI_KEY_MISSING');
    const last = this.meta('lastSubmitAt', 0);
    if (last && now - last < cfg.minSubmitIntervalMs) throw new ApiError(429, 'TOO_SOON', { retryAfterMs: cfg.minSubmitIntervalMs - (now - last) });
    if (this.one("SELECT COUNT(*) n FROM jobs WHERE state IN ('created','working')").n >= cfg.maxQueuedUser) throw new ApiError(429, 'TOO_MANY_QUEUED');
    if (!this.unlimited && this.callsToday(now) + 1 > cfg.maxCallsPerDayUser) throw new ApiError(429, 'DAILY_CALL_CAP', { cap: cfg.maxCallsPerDayUser });
    for (const r of p.refs) {
      if (r[0] === 's') continue;
      const id = r.slice(2), ok = r[0] === 'i' ? this.one('SELECT 1 x FROM images WHERE id=?', id) : this.one('SELECT 1 x FROM echo_refs WHERE id=?', id);
      if (!ok) throw new ApiError(404, 'REF_IMAGE_NOT_FOUND');
    }
    const amount = priceFor(skolPrices(this.env), p.format, p.panelCount);
    const bind = await sha(JSON.stringify(stable({ format: p.format, panelCount: p.panelCount, showPanelNumbers: p.showPanelNumbers })));
    const q = this.one('SELECT bind,amount,state,expires_at FROM quotes WHERE id=?', p.quoteId);
    if (!amount || !q || q.state !== 'open' || q.expires_at < now || q.bind !== bind || q.amount !== amount) throw new ApiError(403, 'IMAGE_QUOTE_INVALID');
    const wallet = this.skolWallet(now);
    if (wallet && amount > wallet.balance) throw new ApiError(402, 'INSUFFICIENT_SKOL', { balance: wallet.balance, price: amount, resetsAt: wallet.resetsAt });
    const res = await this.ledger.reserve(this.meta('email'), cfg.estUsdPerCall);   // ONE provider request, whatever the panel count
    if (!res.ok) throw new ApiError(429, res.code);
    const jobId = rid(), params = { ...p, size: sizeFor(p), skolQuoted: amount, moderationMode: this.echoModeration().mode };
    try {
      this.ctx.storage.transactionSync(() => {
        if (this.one('SELECT state FROM quotes WHERE id=?', p.quoteId)?.state !== 'open') throw new ApiError(403, 'IMAGE_QUOTE_INVALID');
        this.run("UPDATE quotes SET state='used' WHERE id=?", p.quoteId);
        this.run("INSERT INTO jobs(id,idem,kind,hash,params,state,ledger_id,created_at,updated_at) VALUES(?,?,?,?,?,'created',?,?,?)", jobId, p.idempotencyKey, 'echo', hash, JSON.stringify(params), res.id, now, now);
        this.run("INSERT INTO grants(id,kind,job_idem,state,ts) VALUES(?,?,?,'held',?)", rid(), 'echo', p.idempotencyKey, now);
        this.setMeta('lastSubmitAt', now);
      });
    } catch (e) { await this.ledger.cancel(res.id); throw e; }
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { ...this.jobView(jobId), replay: false };
  }

  accept(kind, body) {
    const img = this.one('SELECT id,kind FROM images WHERE id=?', String(body.imageId ?? ''));
    if (!img || img.kind !== kind) throw new ApiError(404, 'NOT_FOUND');
    let face = null;
    if (baseKind(kind) === 'telo' || kind === 'avatar') {
      face = body.faceImageId ? this.one('SELECT id,kind FROM images WHERE id=?', String(body.faceImageId)) : null;
      if (body.faceImageId && face?.kind !== kind + '_face') throw new ApiError(404, 'NOT_FOUND');
      if (!face && this.one('SELECT 1 x FROM images WHERE kind=?', kind + '_face')) throw new ApiError(400, 'FACE_IMAGE_REQUIRED');
    }
    if (this.accepted(kind)) { if (!this.unlimited) throw new ApiError(409, 'ALREADY_ACCEPTED'); this.run('UPDATE images SET accepted=0 WHERE kind IN (?,?)', kind, kind + '_face'); }
    this.run('UPDATE images SET accepted=1 WHERE id=?', img.id);
    if (face) this.run('UPDATE images SET accepted=1 WHERE id=?', face.id);
    // retention: reference photos for the chosen kind are deleted as soon as the image is chosen
    for (const u of this.q('SELECT id,blob_id,certified FROM uploads')) if ((u.certified === 'rights') === (baseKind(kind) === 'telo')) { this.delBlob(u.blob_id); this.run('DELETE FROM uploads WHERE id=?', u.id); }
    return this.me();
  }

  async purge(body) {
    if (body.confirm !== 'DELETE MY DATA') throw new ApiError(400, 'CONFIRM_REQUIRED');
    // Deletes photos and images; keeps the entitlement counters so a purge cannot be used to claim free generations again.
    this.run('DELETE FROM app_state');
    for (const u of this.q('SELECT blob_id FROM uploads')) this.delBlob(u.blob_id);
    for (const i of this.q('SELECT blob_id FROM images')) this.delBlob(i.blob_id);
    for (const u of this.q('SELECT blob_id FROM echo_refs')) this.delBlob(u.blob_id);
    for (const u of this.q("SELECT blob_id FROM echo_posts WHERE source='upload'")) this.delBlob(u.blob_id);
    this.run('DELETE FROM echo_posts');
    this.run('DELETE FROM uploads'); this.run('DELETE FROM images'); this.run('DELETE FROM echo_refs'); this.run('DELETE FROM quotes');
    this.run("UPDATE jobs SET params='{}', result=NULL");
    return this.me();
  }

  // ---------- job runner (alarm) ----------
  async alarm() {
    try {
      await this.recoverStale();
      const job = this.one("SELECT id FROM jobs WHERE state='created' ORDER BY created_at LIMIT 1");
      if (job) await this.runJob(job.id);
    } catch (e) { console.error('alarm_error', e?.message); }     // never throw: a thrown alarm is auto-retried (extra spend risk)
    try { if (this.one("SELECT 1 x FROM jobs WHERE state='created' LIMIT 1")) await this.ctx.storage.setAlarm(Date.now() + 250); } catch { /* ignore */ }
  }
  async recoverStale() {
    for (const j of this.q("SELECT id,idem,ledger_id FROM jobs WHERE state='working' AND updated_at<?", Date.now() - STALE_WORKING_MS)) {
      this.run("UPDATE jobs SET state='failed',failure='INTERRUPTED',refunded=1,updated_at=? WHERE id=?", Date.now(), j.id);
      this.run("UPDATE grants SET state='released' WHERE job_idem=? AND state IN ('held','committed')", j.idem);
      try { await this.ledger.cancel(j.ledger_id); } catch { /* ignore */ }
    }
  }

  async renderPart(jobId) {
    const cfg = this.cfg, self = this;
    const job = this.one('SELECT * FROM jobs WHERE id=?', jobId);
    const p = JSON.parse(job.params);
    const email = this.meta('email');
    const principal = { userId: (await sha(String(email))).slice(0, 32), verifiedAdult: false, age: 18 };
    const sceneId = `scene_${job.id}`;
    const pb = p.kind === PREBUILT_KIND ? prebuiltScene(p) : null;
    const echo = p.kind === 'echo';
    const echoSubjects = echo ? self.echoSubjects(p) : [];
    const face = (baseKind(p.kind) === 'telo' || p.kind === 'avatar') && p.part === 'face';       // face close-up half of the Telō package (built from the full-length image)
    const adult = (pb || echo) ? 'adult' : (p.canon.apparentAge && (firstNumber(p.canon.apparentAge) ?? 18) >= 18) ? 'adult' : 'unknown';
    const sceneIntro = echo ? (p.format === 'collage' ? 'A multi-panel story collage on one canvas.' : 'A single scene image.') + ' Every person depicted is an adult (18 or over).' : pb ? pb.sceneIntro : face
      ? 'Face-detail close-up of ' + (p.kind === 'avatar' ? 'the user\'s own avatar' : 'the user\'s Telōsian companion') + ', the SAME person as the attached full-length reference: head and shoulders with the face filling most of the frame, calm neutral expression, soft even lighting, sharp skin, hair and eye detail, plain uncluttered background.'
      : 'Onboarding full-length reference image of ' + (p.kind === 'avatar' ? 'the user\'s own avatar' : 'the user\'s first Telōsian companion') + ': one person, the ENTIRE body visible from head to feet including footwear, standing upright and facing the camera in a relaxed neutral pose with arms slightly away from the body, centered with clear space around the figure, shown in their world against an uncluttered background that does not hide the silhouette.';
    let usedProvider = false;

    const service = createSceneImageService({
      scenes: { async getAuthorizedScene(uid, sid) {
        return sid === sceneId ? { id: sceneId, description: sceneIntro, worldId: 'onboarding', locationId: null, participantIds: echo ? echoSubjects.map((x) => x.id) : [pb ? p.charId : p.kind], occurredAt: new Date(job.created_at).toISOString(), privateAdult: false } : null;
      } },
      canon: {
        async getCharacterSnapshots() {
          if (echo) return echoSubjects.map((x) => ({ id: x.id, displayName: x.name, canonVersion: 'echo1', canonAgeClass: 'adult', ageAmbiguous: false, minorPresenting: false, adultEligible: false,
            appearance: { locked: { apparentAge: 'adult (18 or over)' }, atSceneTime: {} }, relationshipFacts: [] }));
          if (pb) return [{ id: p.charId, displayName: pb.displayName, canonVersion: PREBUILT_VERSION, canonAgeClass: 'adult', ageAmbiguous: false, minorPresenting: false, adultEligible: false,
            appearance: { locked: pb.locked, atSceneTime: pb.outfit ? { currentOutfit: pb.outfit } : {} }, relationshipFacts: [] }];
          return [{ id: p.kind, displayName: p.name || (p.kind === 'avatar' ? 'The user' : 'The companion'), canonVersion: 'v1', canonAgeClass: adult, ageAmbiguous: adult !== 'adult', minorPresenting: false, adultEligible: false,
            appearance: { locked: p.canon, atSceneTime: p.outfit ? { currentOutfit: p.outfit } : {} }, relationshipFacts: [] }];
        },
        async getWorldSnapshot() { if (echo) return { id: 'echo', visualCanon: p.world ? `${p.world}: ${worldCanon(p.world, p.subWorld ?? null)}` : '' }; return { id: 'onboarding', visualCanon: pb ? pb.worldVisual : (p.world || '') }; }
      },
      media: {
        async loadCanonReferences() {
          if (pb) return self.canonRefs(p.charId, p.form, !!p.outfit, p.mode, p.slot);
          if (echo) return self.echoRefImages(p);
          if (face) {
            const r = self.one('SELECT blob_id FROM images WHERE id=?', p.refImageId); const b = r && self.getBlob(r.blob_id);
            if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
            return [{ bytes: b.bytes, mime: b.mime, label: 'the approved full-length image of this character (SUBJECT 1) — keep this exact person: face, skin tone, hair, build, clothing' }];
          }
          const refs = [];
          for (const id of p.photoIds) {
            const u = self.one('SELECT blob_id FROM uploads WHERE id=?', id); const b = u && self.getBlob(u.blob_id);
            if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
            refs.push({ bytes: b.bytes, mime: b.mime, label: baseKind(p.kind) === 'telo' ? 'the character to render, reference image of an existing character (SUBJECT 1) — appearance' : 'the user\'s own likeness reference photo (SUBJECT 1) — face and body' });
          }
          return refs;
        },
        async savePrivateImage(rec) {
          const id = rid(); const { bytes, ...m } = rec;
          self.run('INSERT INTO images(id,job_id,kind,blob_id,meta,accepted,created_at) VALUES(?,?,?,?,?,0,?)', id, jobId, face ? p.kind + '_face' : p.kind, self.putBlob(bytes, rec.mime),
            JSON.stringify({ ...(echo ? { format: p.format, panelCount: p.panelCount, showPanelNumbers: p.showPanelNumbers, style: p.style, world: p.world, subWorld: p.subWorld ?? null, aspect: p.aspect, refinedFrom: p.refinedFrom ?? null, scene: p.prompt.slice(0, 300), skolQuoted: p.skolQuoted ?? null, captions: [] } : {}), part: face ? 'face' : 'full', model: m.providerModel, quality: cfg.quality, size: cfg.size, referenceCount: m.referenceCount, endpoint: m.endpoint, moderation: m.moderation, ...(pb ? { charId: p.charId, form: p.form, mode: p.mode } : {}) }), Date.now());
          return { id };
        }
      },
      wallet: {
        async verifyAcceptedQuote({ principal: pr, scene, purpose }) {
          if (purpose !== 'manual') throw new Error('QUOTE_INVALID');
          if (echo) return { amount: p.skolQuoted ?? 0, currency: 'Sköl', userConfirmed: true, userId: pr.userId, sceneId: scene.id };   // the quote was verified + consumed at admission; no wallet exists yet, so nothing is deducted
          return { amount: 0, currency: 'free', userConfirmed: true, userId: pr.userId, sceneId: scene.id };   // free onboarding allotment (Master 30.2, 18.7)
        },
        async reserve({ idempotencyKey }) {
          const g = self.one('SELECT id FROM grants WHERE job_idem=?', idempotencyKey.replace(/:face$/, ''));
          if (!g) throw new Error('NO_ENTITLEMENT');
          return { id: g.id };
        },
        async commit(h) { self.run("UPDATE grants SET state='committed' WHERE id=? AND state='held'", h.id); },
        async release(h) { self.run("UPDATE grants SET state='released' WHERE id=? AND state='held'", h.id); }
      },
      jobs: {
        async findOrCreate(uid, key) { const j = self.one('SELECT id,state,result FROM jobs WHERE idem=?', key); if (!j) throw new Error('JOB_NOT_FOUND'); return { id: j.id, state: j.state, result: j.result ? JSON.parse(j.result) : undefined }; },
        async claim(id) { if (self.one('SELECT state FROM jobs WHERE id=?', id)?.state !== 'created') return false; self.run("UPDATE jobs SET state='working',updated_at=? WHERE id=?", Date.now(), id); return true; },
        // A Telō package parent stays 'working' until its face half also succeeds (runJob flips it to complete).
        async complete(id, result) { self.run(`UPDATE jobs SET ${p.part === 'package' ? '' : "state='complete',"}result=?,updated_at=? WHERE id=?`, JSON.stringify(result), Date.now(), id); },
        async fail(id, code) { self.run("UPDATE jobs SET state='failed',failure=?,updated_at=? WHERE id=?", code, Date.now(), id); }
      },
      safeguards: {
        async beforeGeneration({ snapshots }) {
          if (containsMinorSignal(p.name, p.description, p.style, p.world, p.outfit, p.personality, p.prompt, p.scene, p.direction, ...Object.values(p.canon ?? {}))) throw new Error('BLOCKED_MINOR_TERMS');
          if (!snapshots.every((s) => s.canonAgeClass === 'adult')) throw new Error('MINOR_OR_AMBIGUOUS_CHARACTER_BLOCKED');
        },
        async afterGeneration({ bytes }) {
          if (sniffImage(new Uint8Array(bytes)) !== 'image/png') return { approved: false };
          return screenOutput({ bytes }, self.env);   // plug-in point for likeness / public-figure screening (see safety.mjs)
        }
      },
      logger: { error: (d) => self.logFailure(jobId, d) },
      openaiImage: async (args) => {
        const render = createOpenAIImageAdapter({
          apiKey: self.env.OPENAI_API_KEY || (self.devMock ? 'mock-key' : undefined), model: cfg.model, allowLowModeration: self.env.ECHO_LOW_MODERATION !== 'false',
          ...(self.devMock ? { apiRoot: self.env.OPENAI_API_BASE } : {})
        });
        usedProvider = true;
        const result = await render({ ...args, quality: cfg.quality, size: args.size || cfg.size, moderationMode: p.moderationMode });
        let usd = costFromUsage(result.usage, cfg.rates); const estimated = usd === null;
        if (estimated) usd = cfg.estUsdPerCall;
        self.run('INSERT INTO usage(id,job_id,ts,model,usd,estimated,raw) VALUES(?,?,?,?,?,?,?)', rid(), jobId, Date.now(), result.model, usd, estimated ? 1 : 0, JSON.stringify(result.usage ?? null));
        return result;
      }
    });

    try {
      await service({ principal, trustedSurface: 'sfw',
        request: { sceneId, idempotencyKey: job.idem, purpose: 'manual', quoteId: null, artDirection: echo ? echoDirection(p) : pb ? pb.artDirection : [face ? 'Face close-up only; keep the same outfit neckline, hair and skin as the reference.' : '', p.description, p.personality && `Temperament and bearing (let it shape posture and expression only, never the clothing or setting): ${p.personality}`, p.style && `Style: ${p.style}`].filter(Boolean).join('\n'), mode: echo ? 'echo' : pb ? pb.mode : 'portrait', quality: cfg.quality, size: echo ? sizeFor(p) : cfg.size, } });
    } catch { /* recorded on the job row and in diag */ }
  }

  /**
   * Runs one queued job. A Telō "package" (first onboarding image) is two provider calls under ONE allotment unit:
   * the full-length image, then a face close-up built from it. If either half fails the whole unit is refunded and
   * both images are discarded. A single-image redo ('full' or 'face') or an avatar/prebuilt job is one call, one unit.
   */
  async runJob(jobId) {
    const job = this.one('SELECT * FROM jobs WHERE id=?', jobId);
    const p = JSON.parse(job.params);
    const isPackage = (baseKind(p.kind) === 'telo' || p.kind === 'avatar') && p.part === 'package';
    const ids = [jobId];
    let faceFailure = null, fullOk = false;
    await this.renderPart(jobId);
    const first = this.one('SELECT state,result FROM jobs WHERE id=?', jobId);
    if (isPackage) {
      fullOk = !!first?.result && first.state === 'working';
      if (fullOk) {
        const fullId = JSON.parse(first.result).imageId, faceJobId = rid(), now = Date.now();
        this.run("INSERT INTO jobs(id,idem,kind,hash,params,state,ledger_id,created_at,updated_at) VALUES(?,?,?,'face',?,'created',?,?,?)",
          faceJobId, job.idem + ':face', p.kind, JSON.stringify({ ...p, part: 'face', refImageId: fullId }), job.ledger_id, now, now);
        ids.push(faceJobId);
        await this.renderPart(faceJobId);
        const f = this.one('SELECT state,result,failure FROM jobs WHERE id=?', faceJobId);
        if (f?.state === 'complete') {
          this.run("UPDATE jobs SET state='complete',result=?,updated_at=? WHERE id=?", JSON.stringify({ ...JSON.parse(first.result), faceImageId: JSON.parse(f.result).imageId }), Date.now(), jobId);
        } else {
          faceFailure = f?.failure ?? 'FACE_GENERATION_FAILED';
          this.run("UPDATE jobs SET state='failed',failure=?,result=NULL,updated_at=? WHERE id=?", faceFailure, Date.now(), jobId);
        }
      }
    }
    // Reconcile: ANY job that did not complete refunds the free allotment (Chris, Nov 15: rejected images are refunded).
    const done = this.one('SELECT state FROM jobs WHERE id=?', jobId)?.state === 'complete';
    if (!done) {
      this.run("UPDATE grants SET state='released' WHERE job_idem=? AND state IN ('held','committed')", job.idem);
      this.run('UPDATE jobs SET refunded=1 WHERE id=?', jobId);
      if (this.one('SELECT state FROM jobs WHERE id=?', jobId)?.state === 'created') this.run("UPDATE jobs SET state='failed',failure='GENERATION_FAILED',updated_at=? WHERE id=?", Date.now(), jobId);
      if (isPackage) for (const r of this.q(`SELECT id,blob_id FROM images WHERE job_id IN (${ids.map(() => '?').join(',')})`, ...ids)) { this.delBlob(r.blob_id); this.run('DELETE FROM images WHERE id=?', r.id); }
    }
    try {
      const u = this.one(`SELECT SUM(usd) usd, MAX(estimated) est, COUNT(*) n FROM usage WHERE job_id IN (${ids.map(() => '?').join(',')})`, ...ids);
      if (u?.n) await this.ledger.settle(job.ledger_id, u.usd, !!u.est); else await this.ledger.cancel(job.ledger_id);
    } catch (e) { console.error('ledger_settle_failed', e?.message); }
  }
  logFailure(jobId, d) {
    try { this.run('INSERT INTO diag(job_id,ts,code,detail) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET ts=excluded.ts,code=excluded.code,detail=excluded.detail', jobId, Date.now(), d.code, String(d.diagnostic ?? '').slice(0, 700)); } catch { /* ignore */ }
  }
}
