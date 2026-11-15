/**
 * Cloudflare Access JWT verification for a small allowlist of testers (defense in depth: Access blocks
 * unauthenticated traffic at the edge; the Worker re-verifies the signed token and checks the allowlist).
 * Fails CLOSED: missing configuration means every request is refused.
 */
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

export class AuthError extends Error {
  constructor(code, status = 401) { super(code); this.code = code; this.status = status; }
}

export const parseEmails = (s) => new Set(String(s ?? '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')));

let jwksCache = { at: 0, keys: null, team: null };
async function loadJwks(teamDomain, fetchFn, force, now) {
  if (!force && jwksCache.keys && jwksCache.team === teamDomain && now - jwksCache.at < 3600000) return jwksCache.keys;
  const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AuthError('JWKS_UNAVAILABLE', 503);
  const keys = (await res.json()).keys;
  if (!Array.isArray(keys)) throw new AuthError('JWKS_UNAVAILABLE', 503);
  jwksCache = { at: now, keys, team: teamDomain };
  return keys;
}
export function _resetJwksCache() { jwksCache = { at: 0, keys: null, team: null }; }

/** Returns { email, isOwner } or throws AuthError. */
export async function verifyAccessJwt({ token, teamDomain, aud, ownerEmail, allowedEmails, fetchFn = fetch, now = Date.now() }) {
  const allowed = parseEmails(allowedEmails);
  const owner = String(ownerEmail ?? '').toLowerCase();
  if (owner) allowed.add(owner);
  if (!teamDomain || !aud || !allowed.size) throw new AuthError('AUTH_NOT_CONFIGURED', 503);
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new AuthError('NO_TOKEN');
  const [h, p, s] = token.split('.');
  let header, payload;
  try { header = json(h); payload = json(p); } catch { throw new AuthError('BAD_TOKEN'); }
  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('BAD_TOKEN');
  let keys = await loadJwks(teamDomain, fetchFn, false, now);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await loadJwks(teamDomain, fetchFn, true, now); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new AuthError('UNKNOWN_KEY');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AuthError('BAD_SIGNATURE');
  const sec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= sec) throw new AuthError('TOKEN_EXPIRED');
  if (typeof payload.nbf === 'number' && payload.nbf > sec + 60) throw new AuthError('TOKEN_NOT_YET_VALID');
  if (payload.iss !== `https://${teamDomain}`) throw new AuthError('BAD_ISSUER');
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) throw new AuthError('BAD_AUDIENCE');
  const email = String(payload.email || '').toLowerCase();
  if (!email || !allowed.has(email)) throw new AuthError('NOT_ALLOWED', 403);
  return { email, isOwner: email === owner };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Local-dev bypass works ONLY on a loopback hostname AND with DEV_BYPASS_AUTH=true. It still enforces the allowlist. */
export async function authenticate(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (env.DEV_BYPASS_AUTH === 'true' && LOCAL.has(url.hostname)) {
    const email = String(request.headers.get('x-dev-email') || env.OWNER_EMAIL || '').toLowerCase();
    const allowed = parseEmails(env.ALLOWED_EMAILS);
    if (env.OWNER_EMAIL) allowed.add(String(env.OWNER_EMAIL).toLowerCase());
    if (!email || !allowed.has(email)) throw new AuthError('NOT_ALLOWED', 403);
    return { email, isOwner: email === String(env.OWNER_EMAIL || '').toLowerCase() };
  }
  return verifyAccessJwt({
    token: request.headers.get('Cf-Access-Jwt-Assertion'),
    teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, ownerEmail: env.OWNER_EMAIL, allowedEmails: env.ALLOWED_EMAILS, fetchFn
  });
}
