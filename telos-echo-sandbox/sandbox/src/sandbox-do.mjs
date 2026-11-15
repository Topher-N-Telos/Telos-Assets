/**
 * Single owner-scoped Durable Object: all sandbox state (characters, references, images, wallet,
 * usage) lives in its SQLite storage, private to this Cloudflare account. Generation runs from the
 * DO alarm so it survives the phone closing, using the SAME service/adapter/prompt modules as the
 * Pass A backend (../../src). The Worker authenticates; this class trusts only requests the Worker forwards.
 */
import { DurableObject } from 'cloudflare:workers';
import { createSceneImageService } from '../../src/scene-image-service.mjs';
import { createOpenAIImageAdapter } from '../../src/openai-image-api.mjs';
import { parseConfig, costFromUsage, evaluateLimits, hashParams, reservePerCall, containsMinorSignal, dayKey, monthKey } from './limits.mjs';
import { ApiError, normalizeParams, normalizeCharacterInput, normalizeCanon, normalizeScore, composeArtDirection, sniffImage, csvCell, REF_ROLES } from './params.mjs';

const OWNER = 'owner';
const CHUNK = 900_000;                 // SQLite rows are limited to ~2 MB; chunk blobs well below that
const MAX_REF_BYTES = 8 * 1024 * 1024;
const MAX_REFS_PER_CHARACTER = 3;      // 4 characters x 3 + 3 world = 15 <= 16 provider limit
const MAX_WORLD_REFS = 3;
const MAX_JSON_BYTES = 64 * 1024;
const STALE_WORKING_MS = 10 * 60 * 1000;
const QUOTE_TTL_MS = 10 * 60 * 1000;
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 22);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const lastMinorNumber = (s) => { const m = String(s).match(/\b(\d{1,3})\b/); return m ? Number(m[1]) : null; };

export class Sandbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  get cfg() { return parseConfig(this.env); }
  get devMock() { return this.env.DEV_BYPASS_AUTH === 'true' && !!this.env.OPENAI_API_BASE; }
  q(query, ...b) { return this.sql.exec(query, ...b).toArray(); }
  one(query, ...b) { return this.q(query, ...b)[0] ?? null; }
  run(query, ...b) { return this.sql.exec(query, ...b).rowsWritten; }
  meta(k, d = null) { const r = this.one('SELECT v FROM meta WHERE k=?', k); return r ? JSON.parse(r.v) : d; }
  setMeta(k, v) { this.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v)); }

  migrate() {
    for (const stmt of [
      'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)',
      'CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY, name TEXT NOT NULL, canon TEXT NOT NULL, adult INTEGER NOT NULL, version INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS blob_chunks(blob_id TEXT, idx INTEGER, data BLOB, PRIMARY KEY(blob_id, idx))',
      'CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY, character_id TEXT, world INTEGER NOT NULL DEFAULT 0, role TEXT, label TEXT, blob_id TEXT NOT NULL, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY, params TEXT, hash TEXT, amount INTEGER, est_usd REAL, count INTEGER, expires_at INTEGER, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, params TEXT, hash TEXT, count INTEGER, est_usd REAL, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, batch_id TEXT, idem TEXT UNIQUE, seq INTEGER, state TEXT, failure TEXT, result TEXT, created_at INTEGER, updated_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, job_id TEXT, batch_id TEXT, blob_id TEXT, meta TEXT, score TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, kind TEXT, amount INTEGER, state TEXT, job_idem TEXT UNIQUE, ts INTEGER)',
      'CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, job_id TEXT, ts INTEGER, model TEXT, usd REAL, estimated INTEGER, raw TEXT)',
      'CREATE TABLE IF NOT EXISTS diag(job_id TEXT PRIMARY KEY, ts INTEGER, code TEXT, detail TEXT)'
    ]) this.sql.exec(stmt);
  }

  // ---------- blobs ----------
  putBlob(bytes, mime) {
    const id = rid();
    const src = new Uint8Array(bytes); // copy: a Node Buffer's slice() would share its pooled memory
    this.ctx.storage.transactionSync(() => {
      this.run('INSERT INTO blobs(id,mime,size,created_at) VALUES(?,?,?,?)', id, mime, src.byteLength, Date.now());
      for (let i = 0, idx = 0; i < src.byteLength; i += CHUNK, idx++) {
        this.run('INSERT INTO blob_chunks(blob_id,idx,data) VALUES(?,?,?)', id, idx, src.slice(i, i + CHUNK).buffer);
      }
    });
    return id;
  }
  getBlob(id) {
    const meta = this.one('SELECT mime,size FROM blobs WHERE id=?', id);
    if (!meta) return null;
    const out = new Uint8Array(meta.size);
    let off = 0;
    for (const row of this.q('SELECT data FROM blob_chunks WHERE blob_id=? ORDER BY idx', id)) {
      const u = new Uint8Array(row.data); out.set(u, off); off += u.byteLength;
    }
    return { bytes: out, mime: meta.mime };
  }
  delBlob(id) { this.run('DELETE FROM blob_chunks WHERE blob_id=?', id); this.run('DELETE FROM blobs WHERE id=?', id); }

  // ---------- wallet (stand-in Sköl; never touches real money) ----------
  wallet() {
    const granted = this.one("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='grant'").a;
    const spent = this.one("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='hold' AND state='committed'").a;
    const held = this.one("SELECT COALESCE(SUM(amount),0) a FROM ledger WHERE kind='hold' AND state='held'").a;
    const balance = this.cfg.startingSkol + granted - spent;
    return { balance, held, available: balance - held, spent };
  }

  // ---------- counters ----------
  counters(now) {
    const cfg = this.cfg, tz = cfg.timeZone, today = dayKey(now, tz), month = monthKey(now, tz);
    const since = now - 40 * 864e5;
    const jobs = this.q("SELECT state,created_at FROM jobs WHERE state!='cancelled' AND created_at>?", since);
    const usage = this.q('SELECT ts,usd FROM usage WHERE ts>?', since);
    const recent = this.q('SELECT usd FROM usage WHERE estimated=0 ORDER BY ts DESC LIMIT 10');
    const avg = recent.length ? recent.reduce((a, r) => a + r.usd, 0) / recent.length : undefined;
    const reserve = reservePerCall(cfg, avg);
    const pending = (j) => j.state === 'created' || j.state === 'working';
    const c = { callsToday: 0, usdToday: 0, usdMonth: 0, queuedOrWorking: 0, lastSubmitAt: this.meta('lastSubmitAt', 0) };
    for (const j of jobs) {
      const d = dayKey(j.created_at, tz), m = monthKey(j.created_at, tz);
      if (d === today) c.callsToday++;
      if (pending(j)) { c.queuedOrWorking++; if (d === today) c.usdToday += reserve; if (m === month) c.usdMonth += reserve; }
    }
    for (const u of usage) {
      if (dayKey(u.ts, tz) === today) c.usdToday += u.usd;
      if (monthKey(u.ts, tz) === month) c.usdMonth += u.usd;
    }
    c.usdToday = Math.round(c.usdToday * 10000) / 10000; c.usdMonth = Math.round(c.usdMonth * 10000) / 10000;
    return { counters: c, reserve };
  }

  // ---------- http ----------
  async fetch(request) {
    try {
      return await this.route(request);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, ...e.extra }, e.status);
      console.error('sandbox_internal', e?.message);
      return json({ error: 'INTERNAL' }, 500);
    }
  }

  async body(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_JSON_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE');
    const text = await request.text();
    if (text.length > MAX_JSON_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE');
    try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {}; } catch { throw new ApiError(400, 'BAD_JSON'); }
  }

  async route(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = request.method;
    const [, a, b, c] = parts;
    if (parts[0] !== 'api') throw new ApiError(404, 'NOT_FOUND');

    if (a === 'state' && m === 'GET') return json(this.state());
    if (a === 'characters') {
      if (m === 'POST' && !b) return json(this.saveCharacter(null, await this.body(request)));
      if (m === 'PUT' && b) return json(this.saveCharacter(b, await this.body(request)));
      if (m === 'DELETE' && b) return json(this.deleteCharacter(b));
    }
    if (a === 'refs') {
      if (m === 'POST' && !b) return json(await this.addRef(url, request));
      if (m === 'GET' && b && c === 'image') return this.refImage(b);
      if (m === 'DELETE' && b) return json(this.deleteRef(b));
    }
    if (a === 'quote' && m === 'POST') return json(await this.makeQuote(await this.body(request)));
    if (a === 'generate' && m === 'POST') return json(await this.generate(await this.body(request)));
    if (a === 'batches' && m === 'GET') return json(b ? this.batch(b) : this.batches());
    if (a === 'jobs' && m === 'POST' && c === 'cancel') return json(this.cancelJob(b));
    if (a === 'jobs' && m === 'GET' && c === 'diag') return json(this.diag(b));
    if (a === 'gallery' && m === 'GET') return json(this.gallery());
    if (a === 'images' && b) {
      if (m === 'GET' && !c) return this.imageBytes(b);
      if (m === 'POST' && c === 'score') return json(this.score(b, await this.body(request)));
      if (m === 'DELETE' && !c) return json(this.deleteImage(b));
    }
    if (a === 'report' && m === 'GET') return json(this.report());
    if (a === 'export.csv' && m === 'GET') return this.exportCsv();
    if (a === 'pause' && m === 'POST') { const v = (await this.body(request)).paused === true; this.setMeta('paused', v); return json({ paused: v }); }
    if (a === 'wallet' && b === 'grant' && m === 'POST') {
      const n = (await this.body(request)).amount;
      if (!Number.isInteger(n) || n < 1 || n > 100000) throw new ApiError(400, 'FIELD_INVALID', { field: 'amount' });
      this.run("INSERT INTO ledger(id,kind,amount,state,job_idem,ts) VALUES(?,?,?,?,?,?)", rid(), 'grant', n, 'done', `grant-${rid()}`, Date.now());
      return json(this.wallet());
    }
    if (a === 'purge' && m === 'POST') {
      if ((await this.body(request)).confirm !== 'DELETE EVERYTHING') throw new ApiError(400, 'CONFIRM_REQUIRED');
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.migrate();
      return json({ ok: true });
    }
    throw new ApiError(404, 'NOT_FOUND');
  }

  // ---------- state ----------
  state() {
    const cfg = this.cfg, now = Date.now();
    const { counters, reserve } = this.counters(now);
    const characters = this.q('SELECT id,name,canon,adult,version FROM characters ORDER BY created_at').map((r) => ({
      id: r.id, name: r.name, canon: JSON.parse(r.canon), adultAttested: !!r.adult, version: r.version,
      refs: this.q('SELECT id,role,label FROM refs WHERE character_id=? ORDER BY created_at', r.id)
    }));
    return {
      config: {
        models: cfg.models, maxBatch: cfg.maxBatch, skolPerImage: cfg.skolPerImage, timeZone: cfg.timeZone,
        lowModerationEnabled: cfg.allowLowModeration, adultSurfaceEnabled: cfg.ownerAdultAttested,
        keyConfigured: !!this.env.OPENAI_API_KEY, mock: this.devMock, refRoles: REF_ROLES,
        limits: { callsPerDay: cfg.maxCallsPerDay, usdPerDay: cfg.maxUsdPerDay, usdPerMonth: cfg.maxUsdPerMonth, maxQueued: cfg.maxQueued, minIntervalMs: cfg.minSubmitIntervalMs },
        maxRefsPerCharacter: MAX_REFS_PER_CHARACTER, maxWorldRefs: MAX_WORLD_REFS
      },
      paused: this.meta('paused', false) || !cfg.generationEnabled,
      counters, reservePerCallUsd: reserve, wallet: this.wallet(),
      characters,
      worldRefs: this.q('SELECT id,role,label FROM refs WHERE world=1 ORDER BY created_at'),
      serverTime: now
    };
  }

  // ---------- characters / references ----------
  saveCharacter(id, body) {
    const input = normalizeCharacterInput(body);
    const now = Date.now();
    if (!id) {
      if (this.one('SELECT COUNT(*) n FROM characters').n >= 12) throw new ApiError(400, 'TOO_MANY_CHARACTERS');
      id = rid();
      this.run('INSERT INTO characters(id,name,canon,adult,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, input.name, JSON.stringify(input.canon), input.adultAttested ? 1 : 0, 1, now, now);
    } else {
      const cur = this.one('SELECT version FROM characters WHERE id=?', id);
      if (!cur) throw new ApiError(404, 'NOT_FOUND');
      this.run('UPDATE characters SET name=?,canon=?,adult=?,version=?,updated_at=? WHERE id=?', input.name, JSON.stringify(input.canon), input.adultAttested ? 1 : 0, cur.version + 1, now, id);
    }
    return { id };
  }
  deleteCharacter(id) {
    this.ctx.storage.transactionSync(() => {
      for (const r of this.q('SELECT id,blob_id FROM refs WHERE character_id=?', id)) { this.delBlob(r.blob_id); this.run('DELETE FROM refs WHERE id=?', r.id); }
      this.run('DELETE FROM characters WHERE id=?', id);
    });
    return { ok: true };
  }
  async addRef(url, request) {
    const characterId = url.searchParams.get('characterId');
    const world = url.searchParams.get('world') === '1';
    const role = url.searchParams.get('role') || 'other';
    const label = (url.searchParams.get('label') || '').slice(0, 60);
    if (!REF_ROLES.includes(role)) throw new ApiError(400, 'FIELD_INVALID', { field: 'role' });
    if (containsMinorSignal(label)) throw new ApiError(400, 'BLOCKED_MINOR_TERMS');
    if (world === !!characterId) throw new ApiError(400, 'FIELD_INVALID', { field: 'target' });
    if (characterId) {
      if (!this.one('SELECT 1 x FROM characters WHERE id=?', characterId)) throw new ApiError(404, 'NOT_FOUND');
      if (this.one('SELECT COUNT(*) n FROM refs WHERE character_id=?', characterId).n >= MAX_REFS_PER_CHARACTER) throw new ApiError(400, 'TOO_MANY_REFERENCES', { max: MAX_REFS_PER_CHARACTER });
    } else if (this.one('SELECT COUNT(*) n FROM refs WHERE world=1').n >= MAX_WORLD_REFS) {
      throw new ApiError(400, 'TOO_MANY_REFERENCES', { max: MAX_WORLD_REFS });
    }
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_REF_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: MAX_REF_BYTES });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_REF_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', { maxBytes: MAX_REF_BYTES });
    const mime = sniffImage(bytes);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE');
    const blobId = this.putBlob(bytes, mime);
    const id = rid();
    this.run('INSERT INTO refs(id,character_id,world,role,label,blob_id,created_at) VALUES(?,?,?,?,?,?,?)', id, characterId || null, world ? 1 : 0, role, label, blobId, Date.now());
    return { id };
  }
  refImage(id) {
    const r = this.one('SELECT blob_id FROM refs WHERE id=?', id);
    const b = r && this.getBlob(r.blob_id);
    if (!b) throw new ApiError(404, 'NOT_FOUND');
    return new Response(b.bytes, { headers: { 'content-type': b.mime, 'cache-control': 'private, no-store' } });
  }
  deleteRef(id) {
    const r = this.one('SELECT blob_id FROM refs WHERE id=?', id);
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    this.delBlob(r.blob_id); this.run('DELETE FROM refs WHERE id=?', id);
    return { ok: true };
  }

  // ---------- quote + generate ----------
  loadCharacters(ids) {
    return ids.map((id) => {
      const r = this.one('SELECT id,name,canon,adult,version FROM characters WHERE id=?', id);
      if (!r) throw new ApiError(404, 'CHARACTER_NOT_FOUND', { id });
      return { ...r, canon: JSON.parse(r.canon) };
    });
  }
  /** Fail-closed adult check applied BEFORE any spend; the service re-checks per job. */
  ageClass(ch) {
    const age = ch.canon.apparentAge;
    if (!ch.adult || !age) return 'unknown';
    const n = lastMinorNumber(age);
    if (n !== null && n < 18) return 'minor';
    return 'adult';
  }

  async makeQuote(body) {
    const cfg = this.cfg, now = Date.now();
    const p = normalizeParams(body.params, cfg);
    const chars = this.loadCharacters(p.characterIds);
    for (const ch of chars) {
      if (this.ageClass(ch) !== 'adult') throw new ApiError(400, 'CHARACTER_AGE_NOT_ATTESTED', { name: ch.name });
    }
    for (const id of p.worldRefIds) if (!this.one('SELECT 1 x FROM refs WHERE id=? AND world=1', id)) throw new ApiError(404, 'REFERENCE_NOT_FOUND');
    const hash = await hashParams({ ...p, count: undefined, allowDuplicate: undefined, characterVersions: chars.map((c) => [c.id, c.version]) });
    const { counters, reserve } = this.counters(now);
    const pre = evaluateLimits({ cfg, now, count: p.count, paused: this.meta('paused', false), counters, paramsHash: hash, recentBatches: this.recentBatches(), allowDuplicate: p.allowDuplicate, reserveUsd: reserve });
    const amount = cfg.skolPerImage * p.count;
    const id = `q${rid()}`;
    this.run('DELETE FROM quotes WHERE expires_at<?', now - 3600000);
    this.run('INSERT INTO quotes(id,params,hash,amount,est_usd,count,expires_at,used,created_at) VALUES(?,?,?,?,?,?,?,0,?)', id, JSON.stringify(p), hash, amount, Math.round(reserve * p.count * 1000) / 1000, p.count, now + QUOTE_TTL_MS, now);
    const refCount = chars.reduce((n, ch) => n + this.one('SELECT COUNT(*) n FROM refs WHERE character_id=?', ch.id).n, 0) + p.worldRefIds.length;
    const warnings = [];
    if (!refCount) warnings.push('NO_REFERENCES_ATTACHED');
    for (const ch of chars) if (!this.one('SELECT 1 x FROM refs WHERE character_id=?', ch.id)) warnings.push(`NO_REFERENCE_FOR:${ch.name}`);
    return {
      quoteId: id, count: p.count, amountSkol: amount, currency: 'skol', estUsd: Math.round(reserve * p.count * 1000) / 1000,
      expiresAt: now + QUOTE_TTL_MS, available: this.wallet().available, endpoint: refCount ? 'edits' : 'generations',
      referenceCount: refCount, warnings, preflight: pre, moderation: p.moderation, surface: p.surface, model: p.model
    };
  }

  recentBatches() { return this.q('SELECT hash,created_at ts FROM batches ORDER BY created_at DESC LIMIT 20'); }

  async generate(body) {
    const cfg = this.cfg, now = Date.now();
    if (body.confirm !== true) throw new ApiError(400, 'PRICE_CONFIRMATION_REQUIRED');
    const quoteId = String(body.quoteId || '');
    const quote = this.one('SELECT * FROM quotes WHERE id=?', quoteId);
    if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND');
    if (quote.used) {                                   // idempotent replay: same quote -> same batch, no new spend
      return { batchId: quoteId, replay: true, jobs: this.q('SELECT id,seq,state FROM jobs WHERE batch_id=? ORDER BY seq', quoteId) };
    }
    if (quote.expires_at < now) throw new ApiError(410, 'QUOTE_EXPIRED');
    if (!this.env.OPENAI_API_KEY && !this.devMock) throw new ApiError(503, 'OPENAI_KEY_MISSING');
    const p = normalizeParams(JSON.parse(quote.params), cfg);
    const chars = this.loadCharacters(p.characterIds);
    for (const ch of chars) if (this.ageClass(ch) !== 'adult') throw new ApiError(400, 'CHARACTER_AGE_NOT_ATTESTED', { name: ch.name });
    const { counters, reserve } = this.counters(now);
    const verdict = evaluateLimits({ cfg, now, count: p.count, paused: this.meta('paused', false), counters, paramsHash: quote.hash, recentBatches: this.recentBatches(), allowDuplicate: p.allowDuplicate, reserveUsd: reserve });
    if (!verdict.ok) throw new ApiError(429, verdict.code, verdict);
    if (this.wallet().available < quote.amount) throw new ApiError(402, 'INSUFFICIENT_SKOL');
    this.ctx.storage.transactionSync(() => {
      this.run('UPDATE quotes SET used=1 WHERE id=?', quoteId);
      this.run('INSERT INTO batches(id,params,hash,count,est_usd,created_at) VALUES(?,?,?,?,?,?)', quoteId, quote.params, quote.hash, p.count, quote.est_usd, now);
      for (let i = 0; i < p.count; i++) {
        this.run("INSERT INTO jobs(id,batch_id,idem,seq,state,created_at,updated_at) VALUES(?,?,?,?,'created',?,?)", rid(), quoteId, `quote-${quoteId}-${i}`, i, now, now);
      }
      this.setMeta('lastSubmitAt', now);
    });
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { batchId: quoteId, replay: false, jobs: this.q('SELECT id,seq,state FROM jobs WHERE batch_id=? ORDER BY seq', quoteId) };
  }

  cancelJob(id) {
    const j = this.one('SELECT id,idem FROM jobs WHERE id=?', id);
    if (!j) throw new ApiError(404, 'NOT_FOUND');
    if (this.one('SELECT state FROM jobs WHERE id=?', id).state !== 'created') throw new ApiError(409, 'JOB_NOT_CANCELLABLE');
    this.run("UPDATE jobs SET state='cancelled',updated_at=? WHERE id=?", Date.now(), id);
    return { ok: true };
  }

  // ---------- job runner (alarm) ----------
  async alarm() {
    try {
      this.recoverStale();
      const job = this.one("SELECT id FROM jobs WHERE state='created' ORDER BY created_at, seq LIMIT 1");
      if (!job) return;
      if (this.meta('paused', false) || !this.cfg.generationEnabled) return;   // paused: leave queued
      await this.runJob(job.id);
    } catch (e) {
      console.error('alarm_error', e?.message);          // never throw: a thrown alarm is auto-retried (extra spend risk)
    }
    try {
      if (this.one("SELECT 1 x FROM jobs WHERE state='created' LIMIT 1") && !this.meta('paused', false)) {
        await this.ctx.storage.setAlarm(Date.now() + 250);
      }
    } catch { /* ignore */ }
  }

  recoverStale() {
    const cutoff = Date.now() - STALE_WORKING_MS;
    for (const j of this.q("SELECT id,idem FROM jobs WHERE state='working' AND updated_at<?", cutoff)) {
      this.run("UPDATE jobs SET state='failed',failure='INTERRUPTED',updated_at=? WHERE id=?", Date.now(), j.id);
      this.run("UPDATE ledger SET state='released' WHERE job_idem=? AND state='held'", j.idem);
    }
  }

  async runJob(jobId) {
    const cfg = this.cfg;
    const jobRow = this.one('SELECT * FROM jobs WHERE id=?', jobId);
    const batch = this.one('SELECT * FROM batches WHERE id=?', jobRow.batch_id);
    const p = JSON.parse(batch.params);
    const sceneId = `scene_${batch.id}`;
    const self = this;
    const principal = { userId: OWNER, verifiedAdult: cfg.ownerAdultAttested, age: cfg.ownerAdultAttested ? 18 : 0 };
    const surface = p.surface;

    const service = createSceneImageService({
      scenes: {
        async getAuthorizedScene(uid, sid) {
          if (sid !== sceneId) return null;
          return { id: sceneId, description: [p.sceneText, p.locationText && `Location: ${p.locationText}`].filter(Boolean).join('\n'),
            worldId: 'sandbox', locationId: p.locationText || null, participantIds: p.characterIds,
            occurredAt: new Date(batch.created_at).toISOString(), privateAdult: surface === 'adult' };
        }
      },
      canon: {
        async getCharacterSnapshots(uid, ids) {
          const out = [];
          for (const id of ids) {
            const r = self.one('SELECT id,name,canon,adult,version FROM characters WHERE id=?', id);
            if (!r) return [];
            const ch = { ...r, canon: JSON.parse(r.canon) };
            const cls = self.ageClass(ch);
            out.push({
              id: ch.id, displayName: ch.name, canonVersion: `v${ch.version}`, canonAgeClass: cls, ageAmbiguous: cls !== 'adult',
              minorPresenting: cls === 'minor', adultEligible: !!ch.adult,
              appearance: { locked: ch.canon, atSceneTime: p.outfits[id] ? { currentOutfit: p.outfits[id] } : {} }, relationshipFacts: []
            });
          }
          return out;
        },
        async getWorldSnapshot() { return { id: 'sandbox', visualCanon: p.worldText || '' }; }
      },
      media: {
        async loadCanonReferences(uid, snapshots) {
          const refs = [];
          for (const s of snapshots) {
            for (const r of self.q('SELECT blob_id,role,label FROM refs WHERE character_id=? ORDER BY created_at', s.id)) {
              const b = self.getBlob(r.blob_id); if (!b) continue;
              refs.push({ bytes: b.bytes, mime: b.mime, label: `${s.displayName} (SUBJECT ${snapshots.indexOf(s) + 1}) — ${r.role}${r.label ? `: ${r.label}` : ''}`, refId: r.id });
            }
          }
          for (const id of p.worldRefIds) {
            const r = self.one('SELECT blob_id,role,label FROM refs WHERE id=? AND world=1', id); const b = r && self.getBlob(r.blob_id);
            if (b) refs.push({ bytes: b.bytes, mime: b.mime, label: `environment/world reference${r.label ? `: ${r.label}` : ''}`, refId: id });
          }
          self.currentRefIds = refs.map((r) => r.refId);
          return refs;
        },
        async savePrivateImage(rec) {
          const blobId = self.putBlob(rec.bytes, rec.mime);
          const id = rid();
          const { bytes, ...metaRec } = rec;
          const meta = { ...metaRec, label: p.label, garmentType: p.garmentType, condition: p.condition, quality: p.quality, size: p.size,
            requestedModeration: p.moderation, characterIds: p.characterIds, characterNames: snapshotNames(self, p.characterIds),
            refIds: self.currentRefIds || [], sceneText: p.sceneText, usd: self.lastUsd ?? null, usdEstimated: self.lastUsdEstimated ?? null, seq: jobRow.seq };
          self.run('INSERT INTO images(id,job_id,batch_id,blob_id,meta,score,created_at) VALUES(?,?,?,?,?,NULL,?)', id, jobId, batch.id, blobId, JSON.stringify(meta), Date.now());
          return { id };
        }
      },
      wallet: {
        async verifyAcceptedQuote({ principal: pr, scene, purpose, quoteId }) {
          const q = self.one('SELECT id,amount,count,used FROM quotes WHERE id=?', batch.id);
          if (!q || !q.used || purpose !== 'manual' || scene.id !== `scene_${q.id}` || (quoteId && quoteId !== q.id)) throw new Error('QUOTE_INVALID');
          return { amount: q.amount / q.count, currency: 'skol', userConfirmed: true, userId: pr.userId, sceneId: scene.id };
        },
        async reserve({ quote, idempotencyKey }) {
          const prior = self.one('SELECT id,state FROM ledger WHERE job_idem=?', idempotencyKey);
          if (prior) return { id: prior.id };
          if (self.wallet().available < quote.amount) throw new Error('INSUFFICIENT_SKOL');
          const id = rid();
          self.run("INSERT INTO ledger(id,kind,amount,state,job_idem,ts) VALUES(?,?,?,?,?,?)", id, 'hold', quote.amount, 'held', idempotencyKey, Date.now());
          return { id };
        },
        async commit(hold) { self.run("UPDATE ledger SET state='committed' WHERE id=? AND state='held'", hold.id); },
        async release(hold) { self.run("UPDATE ledger SET state='released' WHERE id=? AND state='held'", hold.id); }
      },
      jobs: {
        async findOrCreate(uid, key) {
          let j = self.one('SELECT id,state,result FROM jobs WHERE idem=?', key);
          if (!j) throw new Error('JOB_NOT_FOUND');
          return { id: j.id, state: j.state, result: j.result ? JSON.parse(j.result) : undefined };
        },
        // Synchronous check-then-set with no await in between: atomic inside a Durable Object.
        async claim(id) {
          if (self.one('SELECT state FROM jobs WHERE id=?', id)?.state !== 'created') return false;
          self.run("UPDATE jobs SET state='working',updated_at=? WHERE id=?", Date.now(), id);
          return true;
        },
        async complete(id, result) { self.run("UPDATE jobs SET state='complete',result=?,updated_at=? WHERE id=?", JSON.stringify(result), Date.now(), id); },
        async fail(id, code) { self.run("UPDATE jobs SET state='failed',failure=?,updated_at=? WHERE id=?", code, Date.now(), id); }
      },
      safeguards: {
        async beforeGeneration({ scene, snapshots }) {
          const userText = [scene.description, p.artDirection, p.garmentPhysics, ...snapshots.flatMap((s) => Object.values(s.appearance.locked)), ...Object.values(p.outfits)];
          if (containsMinorSignal(...userText)) throw new Error('BLOCKED_MINOR_TERMS');
        },
        async afterGeneration({ bytes }) {
          // Structural check only. There is NO automated age/likeness review of the output: the owner reviews every image.
          return { approved: sniffImage(new Uint8Array(bytes)) === 'image/png' };
        }
      },
      logger: { error: (d) => self.logFailure(jobId, d) },
      openaiImage: async (args) => {
        self.lastUsd = null; self.lastUsdEstimated = null;
        const render = createOpenAIImageAdapter({
          apiKey: self.env.OPENAI_API_KEY || (self.devMock ? 'mock-key' : undefined),
          model: p.model,
          allowLowModeration: p.moderation === 'low' && cfg.allowLowModeration && surface === 'adult',
          ...(self.devMock ? { apiRoot: self.env.OPENAI_API_BASE } : {})
        });
        const result = await render({ ...args, quality: p.quality, size: p.size });
        let usd = costFromUsage(result.usage, cfg.rates);
        const estimated = usd === null;
        if (estimated) usd = cfg.estUsdPerCall;
        self.lastUsd = usd; self.lastUsdEstimated = estimated;
        self.run('INSERT INTO usage(id,job_id,ts,model,usd,estimated,raw) VALUES(?,?,?,?,?,?,?)', rid(), jobId, Date.now(), result.model, usd, estimated ? 1 : 0, JSON.stringify(result.usage ?? null));
        return result;
      }
    });

    try {
      await service({
        principal, trustedSurface: surface,
        request: { sceneId, idempotencyKey: jobRow.idem, purpose: 'manual', quoteId: batch.id, artDirection: composeArtDirection(p), mode: p.mode, quality: p.quality, size: p.size }
      });
    } catch { /* recorded on the job row and in diag by the service/logger */ }
  }

  logFailure(jobId, d) {
    try {
      this.run('INSERT INTO diag(job_id,ts,code,detail) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET ts=excluded.ts,code=excluded.code,detail=excluded.detail', jobId, Date.now(), d.code, String(d.diagnostic ?? '').slice(0, 700));
      this.run('DELETE FROM diag WHERE ts<?', Date.now() - 14 * 864e5);
    } catch { /* ignore */ }
  }
  diag(jobId) { return this.one('SELECT code,detail,ts FROM diag WHERE job_id=?', jobId) ?? {}; }

  // ---------- gallery / compare / report ----------
  batches() {
    return this.q('SELECT id,params,count,est_usd,created_at FROM batches ORDER BY created_at DESC LIMIT 15').map((b) => this.batchView(b));
  }
  batch(id) { const b = this.one('SELECT id,params,count,est_usd,created_at FROM batches WHERE id=?', id); if (!b) throw new ApiError(404, 'NOT_FOUND'); return this.batchView(b, true); }
  batchView(b, full = false) {
    const p = JSON.parse(b.params);
    const jobs = this.q('SELECT j.id,j.seq,j.state,j.failure,(SELECT id FROM images WHERE job_id=j.id) image_id FROM jobs j WHERE j.batch_id=? ORDER BY j.seq', b.id);
    return { id: b.id, createdAt: b.created_at, count: b.count, label: p.label, model: p.model, moderation: p.moderation, surface: p.surface, jobs, ...(full ? { params: p } : {}) };
  }
  gallery() {
    return this.q('SELECT id,batch_id,meta,score,created_at FROM images ORDER BY created_at DESC LIMIT 120').map((r) => {
      const m = JSON.parse(r.meta);
      return { id: r.id, batchId: r.batch_id, createdAt: r.created_at, score: r.score ? JSON.parse(r.score) : null,
        label: m.label, garmentType: m.garmentType, condition: m.condition, model: m.providerModel, moderation: m.moderation,
        quality: m.quality, size: m.size, characterNames: m.characterNames, refIds: m.refIds, usd: m.usd, usdEstimated: m.usdEstimated,
        referenceCount: m.referenceCount, sceneText: m.sceneText, seq: m.seq };
    });
  }
  imageBytes(id) {
    const r = this.one('SELECT blob_id FROM images WHERE id=?', id); const b = r && this.getBlob(r.blob_id);
    if (!b) throw new ApiError(404, 'NOT_FOUND');
    return new Response(b.bytes, { headers: { 'content-type': b.mime, 'cache-control': 'private, no-store', 'content-disposition': 'inline' } });
  }
  score(id, body) {
    const s = normalizeScore(body);
    if (!this.one('SELECT 1 x FROM images WHERE id=?', id)) throw new ApiError(404, 'NOT_FOUND');
    this.run('UPDATE images SET score=? WHERE id=?', JSON.stringify(s), id);
    return { ok: true };
  }
  deleteImage(id) {
    const r = this.one('SELECT blob_id FROM images WHERE id=?', id);
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    this.delBlob(r.blob_id); this.run('DELETE FROM images WHERE id=?', id);
    return { ok: true };
  }

  report() {
    const rows = this.q('SELECT i.id,i.meta,i.score,b.hash FROM images i JOIN batches b ON b.id=i.batch_id');
    const agg = (items) => {
      const out = { n: items.length, scored: 0, usd: 0 };
      for (const k of ['identity', 'anatomy', 'fabric', 'costume', 'scene']) {
        const v = items.map((x) => x.score?.[k]).filter((x) => typeof x === 'number');
        out[k] = v.length ? { avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100, min: Math.min(...v), max: Math.max(...v) } : null;
      }
      for (const x of items) { if (x.score) out.scored++; out.usd += x.usd || 0; }
      out.usd = Math.round(out.usd * 1000) / 1000;
      return out;
    };
    const parsed = rows.map((r) => { const m = JSON.parse(r.meta); return { id: r.id, hash: r.hash, score: r.score ? JSON.parse(r.score) : null, usd: m.usd, m }; });
    const group = (keyFn) => { const g = new Map(); for (const x of parsed) { const k = keyFn(x); g.set(k, [...(g.get(k) || []), x]); } return [...g].map(([key, items]) => ({ key, ...agg(items) })); };
    return {
      byGarment: group((x) => `${x.m.garmentType || '—'} / ${x.m.condition || '—'} / ${x.m.providerModel || '?'}`),
      // Same parameters repeated => spread of identity/fabric scores is the consistency measure.
      byRepeatGroup: group((x) => `${x.hash.slice(0, 8)} · ${x.m.label || x.m.characterNames?.join('+') || 'untitled'}`).filter((g) => g.n > 1),
      total: agg(parsed)
    };
  }

  exportCsv() {
    const head = ['image_id', 'created', 'label', 'garment', 'condition', 'model', 'moderation', 'quality', 'size', 'characters', 'refs', 'usd', 'usd_estimated', 'identity', 'anatomy', 'fabric', 'costume', 'scene', 'notes'];
    const lines = [head.join(',')];
    for (const r of this.q('SELECT id,meta,score,created_at FROM images ORDER BY created_at')) {
      const m = JSON.parse(r.meta), s = r.score ? JSON.parse(r.score) : {};
      lines.push([r.id, new Date(r.created_at).toISOString(), m.label, m.garmentType, m.condition, m.providerModel, m.moderation, m.quality, m.size,
        (m.characterNames || []).join('+'), m.referenceCount, m.usd, m.usdEstimated, s.identity, s.anatomy, s.fabric, s.costume, s.scene, s.notes].map(csvCell).join(','));
    }
    return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="telos-sandbox-scores.csv"', 'cache-control': 'no-store' } });
  }
}

function snapshotNames(self, ids) {
  return ids.map((id) => self.one('SELECT name FROM characters WHERE id=?', id)?.name ?? '?');
}
