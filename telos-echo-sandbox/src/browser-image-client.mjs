/**
 * Small browser-side adapter to port into the existing Telōs React UI.
 * No OpenAI key, model setting, moderation parameter, or adult surface flag here.
 * Server must infer the surface from trusted session + validated host/route.
 *
 * Change from the handoff reference: the idempotency key is derived from the accepted quote
 * (one quote -> one job). The reference minted a fresh crypto.randomUUID() on every call, so a
 * double-tap or a retry after a dropped response created a second job and a second charge.
 */
async function requestJson(path, { method = 'GET', body = undefined, csrfToken = '' } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!r.ok) throw new Error(`IMAGE_APP_REQUEST_${r.status}`);
  return await r.json();
}

/** 1: user explicitly requests a quote; display amount and currency before spending. */
export async function getImageQuote({ sceneId, purpose = 'manual', priority = false, csrfToken }) {
  return requestJson('/api/scene-images/quote', {
    method: 'POST', body: { sceneId, purpose, priority }, csrfToken
  });
}

export function idempotencyKeyForQuote(quoteId) {
  const safe = String(quoteId ?? '').replace(/[^a-zA-Z0-9._:-]/g, '');
  if (!safe) throw new Error('QUOTE_ID_REQUIRED');
  return `quote-${safe}`.slice(0, 128);
}

/** 2: call ONLY after a separate deliberate confirmation click. Safe to retry: same quote, same key. */
export async function confirmSceneImage({ sceneId, quoteId, artDirection = '', purpose = 'manual',
  priority = false, csrfToken }) {
  return requestJson('/api/scene-images/jobs', {
    method: 'POST', csrfToken,
    body: { sceneId, quoteId, artDirection, purpose, priority,
      idempotencyKey: idempotencyKeyForQuote(quoteId) }
  });
}

/** 3: poll while the backend queue completes; never expose private storage URLs. */
export function getImageJob(jobId) {
  return requestJson(`/api/scene-images/jobs/${encodeURIComponent(jobId)}`);
}

/** 4: load only approved owner-visible images. */
export function getPrivateSceneGallery(characterId) {
  return requestJson(`/api/scene-images/gallery?characterId=${encodeURIComponent(characterId)}`);
}

/** 5: explicit user action only; changes the chat background, never the locked character baseline. */
export function setSceneImageAsBackground(imageId, csrfToken) {
  return requestJson(`/api/scene-images/${encodeURIComponent(imageId)}/set-background`, {
    method: 'POST', body: {}, csrfToken
  });
}
