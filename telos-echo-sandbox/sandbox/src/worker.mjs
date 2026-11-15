/**
 * Worker entry: authenticate EVERY request (Cloudflare Access JWT), apply CSRF + security headers,
 * serve the single-page UI, and forward /api/* to the owner's Durable Object.
 */
import { authenticate, AuthError } from './auth.mjs';
import html from '../ui/index.html';
export { Sandbox } from './sandbox-do.mjs';

const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const withSec = (res, extra = {}) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...SEC, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
};
const err = (status, code) => withSec(new Response(JSON.stringify({ error: code }), { status, headers: { 'content-type': 'application/json' } }));

export default {
  async fetch(request, env) {
    try { await authenticate(request, env); }
    catch (e) { return e instanceof AuthError ? err(e.status, e.code) : err(500, 'AUTH_ERROR'); }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (request.method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED');
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const csp = `default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      return withSec(new Response(html.replaceAll('__NONCE__', nonce), { headers: { 'content-type': 'text/html; charset=utf-8' } }), { 'content-security-policy': csp });
    }
    if (!url.pathname.startsWith('/api/')) return err(404, 'NOT_FOUND');

    if (!['GET', 'HEAD'].includes(request.method)) {
      // CSRF: state-changing calls must carry a custom header (forces a CORS preflight we never grant) and a same-origin Origin.
      if (request.headers.get('x-sandbox') !== '1') return err(403, 'CSRF_HEADER_REQUIRED');
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return err(403, 'CSRF_ORIGIN');
    }
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName('owner'));
    return withSec(await stub.fetch(request));
  }
};
