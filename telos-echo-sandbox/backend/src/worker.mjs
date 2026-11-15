/**
 * Worker entry: authenticate EVERY request (Cloudflare Access JWT + tester allowlist), apply CSRF + security
 * headers, serve the test UI, and forward /api/* to the caller's OWN Durable Object (named by their verified email,
 * never by anything the client sends). Owner-only admin routes live under /api/_admin/.
 * `/` serves the Telōs app (public/telos.html via the ASSETS binding); `/test` serves the small image test harness.
 */
import { authenticate, AuthError } from './auth.mjs';
import html from '../ui/index.html';
export { UserState } from './user-do.mjs';
export { Ledger } from './ledger-do.mjs';

const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const APP_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' https://cdn.jsdelivr.net", "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:", "img-src 'self' data: blob:", "media-src 'self' data: blob:", "connect-src 'self'",
  "frame-src blob: data: 'self'", "worker-src blob:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ');
const withSec = (res, extra = {}) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SEC, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
};
const err = (status, code) => withSec(new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } }));
const ok = (data) => withSec(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));

export default {
  async fetch(request, env) {
    let who;
    try { who = await authenticate(request, env); }
    catch (e) { return e instanceof AuthError ? err(e.status, e.code) : err(500, 'AUTH_ERROR'); }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // The Telōs app itself (public/telos.html), served from the SAME origin as /api/* so the Access cookie and CSRF header apply.
      // The bundle is one big inline script, so script/style 'unsafe-inline' is required; everything else stays locked to 'self'.
      if (request.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED');
      const asset = await env.ASSETS.fetch(new Request(new URL('/telos.html', request.url)));
      if (!asset.ok) return err(404, 'APP_NOT_DEPLOYED');
      return withSec(new Response(asset.body, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { 'content-security-policy': APP_CSP, 'cache-control': 'private, no-cache' });
    }
    if (url.pathname === '/test') {
      if (request.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED');
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const csp = `default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      return withSec(new Response(html.replaceAll('__NONCE__', nonce), { headers: { 'content-type': 'text/html; charset=utf-8' } }), { 'content-security-policy': csp });
    }
    if (!url.pathname.startsWith('/api/')) return err(404, 'NOT_FOUND');

    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.headers.get('x-telos') !== '1') return err(403, 'CSRF_HEADER_REQUIRED');
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return err(403, 'CSRF_ORIGIN');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const ledger = env.LEDGER.get(env.LEDGER.idFromName('global'));

    if (parts[1] === '_admin') {
      if (!who.isOwner) return err(403, 'OWNER_ONLY');
      const m = request.method, sub = parts[2];
      if (sub === 'summary' && m === 'GET') return ok(await ledger.summary());
      if (sub === 'pause' && m === 'POST') { const j = await request.json().catch(() => ({})); return ok(await ledger.setPaused(j.paused === true)); }
      // per-user admin actions: /api/_admin/user/<email>/<action>
      if (sub === 'user' && parts[3]) {
        const target = decodeURIComponent(parts[3]).toLowerCase();
        const stub = env.USER_STATE.get(env.USER_STATE.idFromName(target));
        const inner = new URL(request.url); inner.pathname = `/api/_admin/${parts[4] ?? 'overview'}`;
        const req = new Request(inner, { method: m, headers: { 'x-telos-user': target, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : request.body });
        return withSec(await stub.fetch(req));
      }
      return err(404, 'NOT_FOUND');
    }

    const stub = env.USER_STATE.get(env.USER_STATE.idFromName(who.email));
    const headers = new Headers(request.headers);
    headers.set('x-telos-user', who.email);          // set by the Worker only; overwrites anything the client sent
    return withSec(await stub.fetch(new Request(request, { headers })));
  }
};
