/**
 * Global spend ledger (one instance, 'global'). Every generation reserves an estimated USD amount here BEFORE
 * the provider is called, so the day/month caps hold across all users and a runaway loop cannot overspend.
 * Unsettled reservations keep counting at their reserved amount (conservative). Figures are ESTIMATES; the OpenAI
 * dashboard and the project's hard limit are the source of truth.
 */
import { DurableObject } from 'cloudflare:workers';
import { parseConfig, dayKey, monthKey } from './common.mjs';

const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 22);

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS spend(id TEXT PRIMARY KEY, user TEXT, ts INTEGER, reserve_usd REAL, actual_usd REAL, estimated INTEGER, state TEXT)');
  }
  q(s, ...b) { return this.sql.exec(s, ...b).toArray(); }
  paused() { const r = this.q("SELECT v FROM meta WHERE k='paused'")[0]; return r ? r.v === 'true' : false; }

  totals(now = Date.now()) {
    const cfg = parseConfig(this.env), tz = cfg.timeZone, today = dayKey(now, tz), month = monthKey(now, tz);
    let day = 0, mon = 0, calls = 0; const byUser = {};
    for (const r of this.q("SELECT user,ts,reserve_usd,actual_usd,state FROM spend WHERE state!='cancelled' AND ts>?", now - 40 * 864e5)) {
      const usd = r.actual_usd ?? r.reserve_usd;
      if (monthKey(r.ts, tz) === month) mon += usd;
      if (dayKey(r.ts, tz) === today) { day += usd; calls++; byUser[r.user] = (byUser[r.user] ?? 0) + 1; }
    }
    return { cfg, day: Math.round(day * 10000) / 10000, month: Math.round(mon * 10000) / 10000, callsToday: calls, byUser };
  }

  /** RPC. Returns {ok:true,id} or {ok:false,code}. */
  async reserve(user, reserveUsd) {
    const now = Date.now();
    const t = this.totals(now);
    if (this.paused() || !t.cfg.generationEnabled) return { ok: false, code: 'GENERATION_PAUSED' };
    if (t.day + reserveUsd > t.cfg.maxUsdPerDay) return { ok: false, code: 'DAILY_USD_CAP' };
    if (t.month + reserveUsd > t.cfg.maxUsdPerMonth) return { ok: false, code: 'MONTHLY_USD_CAP' };
    const id = rid();
    this.sql.exec("INSERT INTO spend(id,user,ts,reserve_usd,actual_usd,estimated,state) VALUES(?,?,?,?,NULL,1,'reserved')", id, user, now, reserveUsd);
    return { ok: true, id };
  }
  /** RPC. Record the real (or estimated) cost once the provider answered. Idempotent. */
  async settle(id, usd, estimated) {
    this.sql.exec("UPDATE spend SET actual_usd=?,estimated=?,state='settled' WHERE id=? AND state='reserved'", usd, estimated ? 1 : 0, id);
    return { ok: true };
  }
  /** RPC. The provider was never charged (failed before or at the provider with no usage): drop the reservation. */
  async cancel(id) {
    this.sql.exec("UPDATE spend SET state='cancelled' WHERE id=? AND state='reserved'", id);
    return { ok: true };
  }
  async setPaused(v) {
    this.sql.exec("INSERT INTO meta(k,v) VALUES('paused',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", v ? 'true' : 'false');
    return { paused: !!v };
  }
  async summary() {
    const t = this.totals();
    return { paused: this.paused(), usdToday: t.day, usdMonth: t.month, callsToday: t.callsToday, callsTodayByUser: t.byUser,
      caps: { usdPerDay: t.cfg.maxUsdPerDay, usdPerMonth: t.cfg.maxUsdPerMonth } };
  }
}
