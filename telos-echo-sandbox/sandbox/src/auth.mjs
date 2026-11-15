/**
 * Cloudflare Access JWT verification (defense in depth: Access already blocks unauthenticated
 * traffic at the edge; the Worker re-verifies the signed token so a misconfigured route cannot expose it).
 * Fails CLOSED: missing configuration means every request is refused.
 */
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

export class AuthError extends Error {
  constructor(code, status = 401) { super(code); this.code = code; this.status = status; }
}

let jwksCache = { at: 0, keys: null, team: null };

async function loadJwks(teamDomain, fetchFn, force = false, now = Date.now()) {
  if (!force && jwksCache.keys && jwksCache.team === teamDomain && now - jwksCache.at < 3600000) return jwksCache.keys;
  const res = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AuthError('JWKS_UNAVAILABLE', 503);
  const keys = (await res.json()).keys;
  if (!Array.isArray(keys)) throw new AuthError('JWKS_UNAVAILABLE', 503);
  jwksCache = { at: now, keys, team: teamDomain };
  return keys;
}
export function _resetJwksCache() { jwksCache = { at: 0, keys: null, team: null }; }

/** Returns { email } or throws AuthError. */
export async function verifyAccessJwt({ token, teamDomain, aud, ownerEmail, fetchFn = fetch, now = Date.now() }) {
  if (!teamDomain || !aud || !ownerEmail) throw new AuthError('AUTH_NOT_CONFIGURED', 503);
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
  if (!email || email !== String(ownerEmail).toLowerCase()) throw new AuthError('NOT_OWNER', 403);
  return { email };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Worker-level gate. Local-dev bypass works ONLY on a loopback hostname AND with DEV_BYPASS_AUTH=true. */
export async function authenticate(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (env.DEV_BYPASS_AUTH === 'true' && LOCAL.has(url.hostname)) return { email: env.OWNER_EMAIL || 'dev@localhost' };
  return verifyAccessJwt({
    token: request.headers.get('Cf-Access-Jwt-Assertion'),
    teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, ownerEmail: env.OWNER_EMAIL, fetchFn
  });
}
