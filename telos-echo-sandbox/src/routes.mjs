/**
 * Framework-agnostic HTTP handlers for the /api/scene-images/* contract (handoff §4).
 * Wire `handle(req)` into the real backend (Cloudflare Worker, Express, etc.). It does no I/O itself:
 * every dependency is an injected adapter, and nothing here is a stand-in for real auth/billing.
 *
 *   req  = { method, path, host, headers, query, body }
 *   resp = { status, json } | { status, body, headers }
 *
 * Security rules enforced here (each has a test):
 *  - Surface (sfw | adult) comes ONLY from surfaceForHost(req.host). Client fields are rejected.
 *  - Adult surface requires principal.verifiedAdult === true; otherwise 404 (adult features are
 *    absent, not "forbidden").
 *  - Every mutation requires auth.verifyCsrf. Reads/mutations require a session.
 *  - The browser can never send a price, model, moderation level, or reference image/URL.
 *  - Ownership + surface isolation on every id; other users' / adult ids look like 404.
 *  - Provider work is queued (202), never run inside the request.
 *  - Failure text is a fixed sanitized message, never raw provider/internal text.
 */
const ID_RE = /^[a-zA-Z0-9._:-]{8,128}$/;
const PURPOSES = ['manual', 'milestone', 'suggestion_accepted'];
const FORBIDDEN_FIELDS = ['surface', 'moderation', 'model', 'amount', 'currency', 'prompt',
  'referenceImages', 'images', 'imageUrl', 'imageUrls', 'referenceUrls', 'mode'];
const MAX_ART_DIRECTION = 4000;

const SAFE_FAILURE_TEXT = {
  IMAGE_FAILED_SAFEGUARDS_OR_FIDELITY: 'That scene could not be rendered. Try a different moment or art direction.',
  IMAGE_PROVIDER_HTTP_400: 'That scene could not be rendered. Try a different moment or art direction.',
  MINOR_OR_AMBIGUOUS_CHARACTER_BLOCKED: 'This scene cannot be rendered.',
  PRICE_CONFIRMATION_REQUIRED: 'Please review and confirm the price again.',
  QUOTE_INVALID: 'The price has changed or expired. Please request a new quote.',
  QUOTE_MISMATCH: 'The price has changed or expired. Please request a new quote.'
};
const DEFAULT_FAILURE_TEXT = 'This image could not be created.';

const json = (status, body) => ({ status, json: body });
const notFound = () => json(404, { error: 'NOT_FOUND' });
const publicState = (s) => (s === 'created' ? 'queued' : s);

export function createSceneImageRoutes({ auth, surfaceForHost, scenes, wallet, jobs, media, enqueue, config = {} }) {
  const need = { auth: ['authenticate', 'verifyCsrf'], scenes: ['getAuthorizedScene'], wallet: ['createQuote'],
    jobs: ['findOrCreate', 'get'], media: ['listOwnerImages', 'getImage', 'openImage', 'setChatBackground'] };
  const adapters = { auth, scenes, wallet, jobs, media };
  for (const [k, ms] of Object.entries(need)) {
    for (const m of ms) if (typeof adapters[k]?.[m] !== 'function') throw new Error(`MISSING_SERVER_ADAPTER_${k}.${m}`);
  }
  if (typeof surfaceForHost !== 'function' || typeof enqueue !== 'function') throw new Error('MISSING_SERVER_ADAPTER_routing');

  const visibleOnSurface = (img, surface) => surface === 'adult' || img.surface === 'sfw';

  async function ownedImage(principal, surface, imageId) {
    if (!ID_RE.test(imageId)) return null;
    const img = await media.getImage(imageId);
    if (!img || img.ownerId !== principal.userId || !visibleOnSurface(img, surface)) return null;
    return img;
  }

  async function authorizedScene(principal, surface, sceneId) {
    if (!ID_RE.test(String(sceneId ?? ''))) return null;
    const scene = await scenes.getAuthorizedScene(principal.userId, sceneId);
    if (!scene || (scene.privateAdult && surface !== 'adult')) return null;
    return scene;
  }

  return async function handle(req) {
    const surface = surfaceForHost(req.host);
    if (surface !== 'sfw' && surface !== 'adult') return notFound();
    const principal = await auth.authenticate(req);
    if (!principal?.userId) return json(401, { error: 'UNAUTHENTICATED' });
    if (surface === 'adult' && !(principal.verifiedAdult === true && principal.age >= 18)) return notFound();

    const method = req.method;
    const path = String(req.path || '').replace(/\/+$/, '');
    const mutating = method !== 'GET';
    if (mutating && !(await auth.verifyCsrf(req, principal))) return json(403, { error: 'CSRF' });
    const body = mutating ? (req.body && typeof req.body === 'object' ? req.body : {}) : {};
    if (mutating && FORBIDDEN_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f))) {
      return json(400, { error: 'FORBIDDEN_FIELD' });
    }
    const killSwitchOn = config.imageGenerationEnabled !== true;

    // POST /api/scene-images/quote
    if (method === 'POST' && path === '/api/scene-images/quote') {
      if (killSwitchOn) return json(503, { error: 'IMAGE_GENERATION_DISABLED' });
      if (!PURPOSES.includes(body.purpose ?? 'manual')) return json(400, { error: 'INVALID_REQUEST' });
      const scene = await authorizedScene(principal, surface, body.sceneId);
      if (!scene) return notFound();
      const q = await wallet.createQuote({ principal, scene, surface,
        purpose: body.purpose ?? 'manual', priority: body.priority === true });
      return json(200, { quoteId: q.quoteId, amount: q.amount, currency: q.currency ?? null,
        free: q.amount === 0, expiresAt: q.expiresAt });
    }

    // POST /api/scene-images/jobs
    if (method === 'POST' && path === '/api/scene-images/jobs') {
      if (killSwitchOn) return json(503, { error: 'IMAGE_GENERATION_DISABLED' });
      const purpose = body.purpose ?? 'manual';
      const artDirection = body.artDirection ?? '';
      if (!PURPOSES.includes(purpose) || !ID_RE.test(String(body.idempotencyKey ?? '')) ||
          !ID_RE.test(String(body.quoteId ?? '')) || typeof artDirection !== 'string' ||
          artDirection.length > MAX_ART_DIRECTION) {
        return json(400, { error: 'INVALID_REQUEST' });
      }
      const scene = await authorizedScene(principal, surface, body.sceneId);
      if (!scene) return notFound();
      const request = { sceneId: scene.id, quoteId: body.quoteId, idempotencyKey: body.idempotencyKey,
        purpose, priority: body.priority === true, artDirection };
      const job = await jobs.findOrCreate(principal.userId, body.idempotencyKey, { surface, request });
      if (job.request && job.request.sceneId !== scene.id) return json(409, { error: 'IDEMPOTENCY_CONFLICT' });
      if (job.state === 'created') await enqueue(job.id); // worker claim is atomic, so a duplicate enqueue is harmless
      return json(202, { jobId: job.id, state: publicState(job.state),
        ...(job.state === 'complete' && job.result?.imageId ? { imageId: job.result.imageId } : {}) });
    }

    // GET /api/scene-images/jobs/:jobId
    let m = /^\/api\/scene-images\/jobs\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const jobId = decodeURIComponent(m[1]);
      const job = ID_RE.test(jobId) ? await jobs.get(jobId) : null;
      if (!job || job.userId !== principal.userId || (job.surface === 'adult' && surface !== 'adult')) return notFound();
      const out = { jobId: job.id, state: publicState(job.state) };
      if (job.state === 'complete' && job.result?.imageId) out.imageId = job.result.imageId;
      if (job.state === 'failed') out.message = SAFE_FAILURE_TEXT[job.failureCode] ?? DEFAULT_FAILURE_TEXT;
      return json(200, out);
    }

    // GET /api/scene-images/gallery?characterId=...
    if (method === 'GET' && path === '/api/scene-images/gallery') {
      const characterId = req.query?.characterId;
      if (characterId !== undefined && !ID_RE.test(String(characterId))) return json(400, { error: 'INVALID_REQUEST' });
      const all = await media.listOwnerImages(principal.userId, { characterId: characterId ?? null });
      const images = all.filter((i) => i.ownerId === principal.userId && visibleOnSurface(i, surface)).map((i) => ({
        imageId: i.id, sceneId: i.sceneId, participantIds: i.participantIds, occurredAt: i.occurredAt,
        createdAt: i.createdAt, canonApproved: i.canonApproved === true,
        imageUrl: `/api/scene-images/${encodeURIComponent(i.id)}`,
        thumbnailUrl: `/api/scene-images/${encodeURIComponent(i.id)}?size=thumb`
      }));
      return json(200, { images });
    }

    // POST /api/scene-images/:imageId/set-background   (explicit user action only)
    m = /^\/api\/scene-images\/([^/]+)\/set-background$/.exec(path);
    if (method === 'POST' && m) {
      const img = await ownedImage(principal, surface, decodeURIComponent(m[1]));
      if (!img) return notFound();
      await media.setChatBackground(principal.userId, img.id); // chat background only; never the character baseline
      return json(200, { ok: true, imageId: img.id });
    }

    // GET /api/scene-images/:imageId
    m = /^\/api\/scene-images\/([^/]+)$/.exec(path);
    if (method === 'GET' && m && m[1] !== 'gallery') {
      const img = await ownedImage(principal, surface, decodeURIComponent(m[1]));
      if (!img) return notFound();
      const file = await media.openImage(img.id, { thumbnail: req.query?.size === 'thumb' });
      if (!file) return notFound();
      return { status: 200, body: file.body, headers: { 'Content-Type': file.mime,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } };
    }

    return notFound();
  };
}
