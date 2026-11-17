/**
 * One Durable Object per tester. Holds that user's private uploads, jobs, images and free-generation
 * entitlements in SQLite (isolated per user: another user's DO cannot be addressed from a user request).
 * Generation runs from the DO alarm using the SAME service/adapter/prompt modules as the sandbox (../../src).
 * The Worker authenticates; this class trusts only requests the Worker forwards (it sets x-telos-user).
 */
import { DurableObject } from 'cloudflare:workers';
import { createSceneImageService } from '../../src/scene-image-service.mjs';
import { createOpenAIImageAdapter } from '../../src/openai-image-api.mjs';
import { ApiError, parseConfig, costFromUsage, dayKey, containsMinorSignal, sniffImage, firstNumber, normalizeOnboarding, KINDS } from './common.mjs';
import { screenUpload, screenOutput } from './safety.mjs';
import { PREBUILT, PREBUILT_VERSION, refPlan, prebuiltScene, normalizePrebuilt } from './prebuilt-canon.mjs';

const CHUNK = 900_000;
const MAX_JSON_BYTES = 32 * 1024;
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
      'CREATE TABLE IF NOT EXISTS diag(job_id TEXT PRIMARY KEY, ts INTEGER, code TEXT, detail TEXT)'
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
    if (a === 'me' && !b && m === 'GET') return json(this.me());
    if (a === 'me' && b === 'purge' && m === 'POST') return json(await this.purge(await this.body(request)));
    if (a === 'uploads') {
      if (m === 'POST' && !b) return json(await this.addUpload(request));
      if (m === 'GET' && b && c === 'image') return this.uploadImage(b);
      if (m === 'DELETE' && b) return json(this.deleteUpload(b));
    }
    if (a === 'onboarding' && KINDS.includes(b)) {
      if (c === 'generate' && m === 'POST') return json(await this.generate(b, await this.body(request)));
      if (c === 'accept' && m === 'POST') return json(this.accept(b, await this.body(request)));
    }
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
      pendingJob: this.one("SELECT id,state FROM jobs WHERE kind=? AND state IN ('created','working') ORDER BY created_at DESC LIMIT 1", kind)
    };
  }
  me() {
    const cfg = this.cfg, now = Date.now();
    return {
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
    return { id: j.id, kind: j.kind, state: j.state, failure: j.failure ?? null, refunded: !!j.refunded, imageId: r?.imageId ?? null, createdAt: j.created_at, remaining: this.unlimited ? null : Math.max(0, this.allowed(j.kind) - this.used(j.kind)) };
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
  canonRefs(charId, form, hasOutfit) {
    const rec = this.meta(`canon_${charId}`);
    if (rec?.version !== PREBUILT_VERSION) throw new Error('CANON_REFERENCES_UNAVAILABLE');
    return refPlan(charId, form, hasOutfit).map((r) => {
      const b = rec.files[r.file] && this.getBlob(rec.files[r.file]);
      if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
      return { bytes: b.bytes, mime: b.mime, label: r.label };
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
    if (!r || r.kind !== PREBUILT_KIND) throw new ApiError(404, 'NOT_FOUND');
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
    if (!this.unlimited && this.callsToday(now) >= cfg.maxCallsPerDayUser) throw new ApiError(429, 'DAILY_CALL_CAP', { cap: cfg.maxCallsPerDayUser });
    for (const id of p.photoIds) { const u = this.one('SELECT certified FROM uploads WHERE id=?', id); if (!u) throw new ApiError(404, 'PHOTO_NOT_FOUND', { id }); if ((u.certified === 'rights') !== (kind === 'telo')) throw new ApiError(400, 'PHOTO_WRONG_PURPOSE', { id }); }
    if (!this.unlimited && this.used(kind) >= this.allowed(kind)) throw new ApiError(402, 'FREE_ALLOTMENT_USED');
    if (!cfg.allowPhotoUploads && p.photoIds.length) throw new ApiError(403, 'PHOTO_UPLOADS_DISABLED');

    const email = this.meta('email');
    const res = await this.ledger.reserve(email, cfg.estUsdPerCall);
    if (!res.ok) throw new ApiError(429, res.code);

    const jobId = rid();
    try {
      this.ctx.storage.transactionSync(() => {
        this.run("INSERT INTO jobs(id,idem,kind,hash,params,state,ledger_id,created_at,updated_at) VALUES(?,?,?,?,?,'created',?,?,?)", jobId, p.idempotencyKey, kind, hash, JSON.stringify(p), res.id, now, now);
        this.run("INSERT INTO grants(id,kind,job_idem,state,ts) VALUES(?,?,?,'held',?)", rid(), kind, p.idempotencyKey, now);
        this.setMeta('lastSubmitAt', now);
      });
    } catch (e) { await this.ledger.cancel(res.id); throw e; }
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { ...this.jobView(jobId), replay: false };
  }

  accept(kind, body) {
    const img = this.one('SELECT id,kind FROM images WHERE id=?', String(body.imageId ?? ''));
    if (!img || img.kind !== kind) throw new ApiError(404, 'NOT_FOUND');
    if (this.accepted(kind)) { if (!this.unlimited) throw new ApiError(409, 'ALREADY_ACCEPTED'); this.run('UPDATE images SET accepted=0 WHERE kind=?', kind); }
    this.run('UPDATE images SET accepted=1 WHERE id=?', img.id);
    // retention: reference photos for the chosen kind are deleted as soon as the image is chosen
    for (const u of this.q('SELECT id,blob_id,certified FROM uploads')) if ((u.certified === 'rights') === (kind === 'telo')) { this.delBlob(u.blob_id); this.run('DELETE FROM uploads WHERE id=?', u.id); }
    return this.me();
  }

  async purge(body) {
    if (body.confirm !== 'DELETE MY DATA') throw new ApiError(400, 'CONFIRM_REQUIRED');
    // Deletes photos and images; keeps the entitlement counters so a purge cannot be used to claim free generations again.
    for (const u of this.q('SELECT blob_id FROM uploads')) this.delBlob(u.blob_id);
    for (const i of this.q('SELECT blob_id FROM images')) this.delBlob(i.blob_id);
    this.run('DELETE FROM uploads'); this.run('DELETE FROM images');
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
      this.run("UPDATE grants SET state='released' WHERE job_idem=? AND state='held'", j.idem);
      try { await this.ledger.cancel(j.ledger_id); } catch { /* ignore */ }
    }
  }

  async runJob(jobId) {
    const cfg = this.cfg, self = this;
    const job = this.one('SELECT * FROM jobs WHERE id=?', jobId);
    const p = JSON.parse(job.params);
    const email = this.meta('email');
    const principal = { userId: (await sha(String(email))).slice(0, 32), verifiedAdult: false, age: 18 };
    const sceneId = `scene_${job.id}`;
    const pb = p.kind === PREBUILT_KIND ? prebuiltScene(p) : null;
    const adult = pb ? 'adult' : (p.canon.apparentAge && (firstNumber(p.canon.apparentAge) ?? 18) >= 18) ? 'adult' : 'unknown';
    const sceneIntro = pb ? pb.sceneIntro : p.kind === 'avatar'
      ? 'Onboarding portrait of the user\'s own avatar: one person, head-and-shoulders to three-quarter framing, shown in their world.'
      : 'Onboarding full-length reference image of the user\'s first Telōsian companion: one person, the ENTIRE body visible from head to feet including footwear, standing upright and facing the camera in a relaxed neutral pose with arms slightly away from the body, centered with clear space around the figure, shown in their world against an uncluttered background that does not hide the silhouette.';
    let usedProvider = false;

    const service = createSceneImageService({
      scenes: { async getAuthorizedScene(uid, sid) {
        return sid === sceneId ? { id: sceneId, description: sceneIntro, worldId: 'onboarding', locationId: null, participantIds: [pb ? p.charId : p.kind], occurredAt: new Date(job.created_at).toISOString(), privateAdult: false } : null;
      } },
      canon: {
        async getCharacterSnapshots() {
          if (pb) return [{ id: p.charId, displayName: pb.displayName, canonVersion: PREBUILT_VERSION, canonAgeClass: 'adult', ageAmbiguous: false, minorPresenting: false, adultEligible: false,
            appearance: { locked: pb.locked, atSceneTime: pb.outfit ? { currentOutfit: pb.outfit } : {} }, relationshipFacts: [] }];
          return [{ id: p.kind, displayName: p.name || (p.kind === 'avatar' ? 'The user' : 'The companion'), canonVersion: 'v1', canonAgeClass: adult, ageAmbiguous: adult !== 'adult', minorPresenting: false, adultEligible: false,
            appearance: { locked: p.canon, atSceneTime: p.outfit ? { currentOutfit: p.outfit } : {} }, relationshipFacts: [] }];
        },
        async getWorldSnapshot() { return { id: 'onboarding', visualCanon: pb ? pb.worldVisual : (p.world || '') }; }
      },
      media: {
        async loadCanonReferences() {
          if (pb) return self.canonRefs(p.charId, p.form, !!p.outfit);
          const refs = [];
          for (const id of p.photoIds) {
            const u = self.one('SELECT blob_id FROM uploads WHERE id=?', id); const b = u && self.getBlob(u.blob_id);
            if (!b) throw new Error('CANON_REFERENCES_UNAVAILABLE');
            refs.push({ bytes: b.bytes, mime: b.mime, label: p.kind === 'telo' ? 'the character to render, reference image of an existing character (SUBJECT 1) — appearance' : 'the user\'s own likeness reference photo (SUBJECT 1) — face and body' });
          }
          return refs;
        },
        async savePrivateImage(rec) {
          const id = rid(); const { bytes, ...m } = rec;
          self.run('INSERT INTO images(id,job_id,kind,blob_id,meta,accepted,created_at) VALUES(?,?,?,?,?,0,?)', id, jobId, p.kind, self.putBlob(bytes, rec.mime),
            JSON.stringify({ model: m.providerModel, quality: cfg.quality, size: cfg.size, referenceCount: m.referenceCount, endpoint: m.endpoint, moderation: m.moderation, ...(pb ? { charId: p.charId, form: p.form, mode: p.mode } : {}) }), Date.now());
          return { id };
        }
      },
      wallet: {
        async verifyAcceptedQuote({ principal: pr, scene, purpose }) {
          if (purpose !== 'manual') throw new Error('QUOTE_INVALID');
          return { amount: 0, currency: 'free', userConfirmed: true, userId: pr.userId, sceneId: scene.id };   // free onboarding allotment (Master 30.2, 18.7)
        },
        async reserve({ idempotencyKey }) {
          const g = self.one('SELECT id FROM grants WHERE job_idem=?', idempotencyKey);
          if (!g) throw new Error('NO_ENTITLEMENT');
          return { id: g.id };
        },
        async commit(h) { self.run("UPDATE grants SET state='committed' WHERE id=? AND state='held'", h.id); },
        async release(h) { self.run("UPDATE grants SET state='released' WHERE id=? AND state='held'", h.id); }
      },
      jobs: {
        async findOrCreate(uid, key) { const j = self.one('SELECT id,state,result FROM jobs WHERE idem=?', key); if (!j) throw new Error('JOB_NOT_FOUND'); return { id: j.id, state: j.state, result: j.result ? JSON.parse(j.result) : undefined }; },
        async claim(id) { if (self.one('SELECT state FROM jobs WHERE id=?', id)?.state !== 'created') return false; self.run("UPDATE jobs SET state='working',updated_at=? WHERE id=?", Date.now(), id); return true; },
        async complete(id, result) { self.run("UPDATE jobs SET state='complete',result=?,updated_at=? WHERE id=?", JSON.stringify(result), Date.now(), id); },
        async fail(id, code) { self.run("UPDATE jobs SET state='failed',failure=?,updated_at=? WHERE id=?", code, Date.now(), id); }
      },
      safeguards: {
        async beforeGeneration({ snapshots }) {
          if (containsMinorSignal(p.name, p.description, p.style, p.world, p.outfit, p.scene, p.direction, ...Object.values(p.canon ?? {}))) throw new Error('BLOCKED_MINOR_TERMS');
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
          apiKey: self.env.OPENAI_API_KEY || (self.devMock ? 'mock-key' : undefined), model: cfg.model, allowLowModeration: false,
          ...(self.devMock ? { apiRoot: self.env.OPENAI_API_BASE } : {})
        });
        usedProvider = true;
        const result = await render({ ...args, quality: cfg.quality, size: cfg.size });
        let usd = costFromUsage(result.usage, cfg.rates); const estimated = usd === null;
        if (estimated) usd = cfg.estUsdPerCall;
        self.run('INSERT INTO usage(id,job_id,ts,model,usd,estimated,raw) VALUES(?,?,?,?,?,?,?)', rid(), jobId, Date.now(), result.model, usd, estimated ? 1 : 0, JSON.stringify(result.usage ?? null));
        return result;
      }
    });

    try {
      await service({ principal, trustedSurface: 'sfw',
        request: { sceneId, idempotencyKey: job.idem, purpose: 'manual', quoteId: null, artDirection: pb ? pb.artDirection : [p.description, p.style && `Style: ${p.style}`].filter(Boolean).join('\n'), mode: pb ? pb.mode : 'portrait', quality: cfg.quality, size: cfg.size } });
    } catch { /* recorded on the job row and in diag */ }

    // Reconcile: ANY job that did not complete refunds the free allotment (Chris, Nov 15: rejected images are refunded).
    const done = this.one('SELECT state FROM jobs WHERE id=?', jobId)?.state === 'complete';
    if (!done) {
      this.run("UPDATE grants SET state='released' WHERE job_idem=? AND state='held'", job.idem);
      this.run('UPDATE jobs SET refunded=1 WHERE id=?', jobId);
      if (this.one('SELECT state FROM jobs WHERE id=?', jobId)?.state === 'created') this.run("UPDATE jobs SET state='failed',failure='GENERATION_FAILED',updated_at=? WHERE id=?", Date.now(), jobId);
    }
    try {
      const u = this.one('SELECT usd,estimated FROM usage WHERE job_id=? ORDER BY ts DESC LIMIT 1', jobId);
      if (u) await this.ledger.settle(job.ledger_id, u.usd, !!u.estimated); else await this.ledger.cancel(job.ledger_id);
    } catch (e) { console.error('ledger_settle_failed', e?.message); }
  }
  logFailure(jobId, d) {
    try { this.run('INSERT INTO diag(job_id,ts,code,detail) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET ts=excluded.ts,code=excluded.code,detail=excluded.detail', jobId, Date.now(), d.code, String(d.diagnostic ?? '').slice(0, 700)); } catch { /* ignore */ }
  }
}
