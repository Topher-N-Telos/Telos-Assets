/**
 * OpenAI Image API adapter. Runs ONLY on the trusted backend / background worker.
 * Uses documented /v1/images/generations and /v1/images/edits interfaces.
 * Node 20+ fetch/FormData/Blob. No SDK dependency; avoid frontend bundling.
 * Does NOT bypass OpenAI content restrictions.
 *
 * Changes from the handoff reference (Pass A hardening):
 *  - `moderation:'low'` is used ONLY when the caller passes allowLowModeration:true
 *    (wired to TELOS_IMAGE_ADULT_LOW_MODERATION_ENABLED). The reference ignored that flag.
 *  - `safety_identifier` is NOT sent unless includeSafetyIdentifier:true, because it was not
 *    confirmed as a documented Images-endpoint parameter; an unknown field could 400 every call.
 *  - Errors carry `status` and `retryable` so the job worker can back off on 429/5xx.
 *  - The result reports the model and moderation mode actually used, for the image record.
 */
const API_ROOT = 'https://api.openai.com/v1';
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MODEL = 'gpt-image-2.6-sunburst';
const REF_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
export const IMAGE_QUALITIES = ['low', 'medium', 'high'];
export const IMAGE_SIZES = ['1024x1536', '1024x1024', '1536x1024'];

function dataFromResponse(payload, model, moderation) {
  const b64 = payload?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64.length) {
    throw new Error('IMAGE_PROVIDER_EMPTY_RESULT');
  }
  return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png', usage: payload.usage ?? null, model, moderation };
}

export function createOpenAIImageAdapter({
  apiKey,
  fetchFn = fetch,
  model = DEFAULT_MODEL,
  allowLowModeration = false,
  includeSafetyIdentifier = false,
  timeoutMs = 180000,
  apiRoot = API_ROOT // overridable only for local mock-server tests
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY_REQUIRED_SERVER_SIDE');

  async function submit(path, body, multipart, moderation) {
    const response = await fetchFn(`${apiRoot}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(multipart ? {} : { 'Content-Type': 'application/json' })
      },
      body: multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      // Never return raw provider errors/prompts to end users.
      const diagnostic = await response.text().catch(() => '');
      const e = new Error(`IMAGE_PROVIDER_HTTP_${response.status}`);
      e.status = response.status;
      e.retryable = response.status === 429 || response.status >= 500;
      e.providerDiagnostic = diagnostic.slice(0, 700); // Private server logs only.
      throw e;
    }
    return dataFromResponse(await response.json(), model, moderation);
  }

  /**
   * Reference format: {bytes: Buffer|Uint8Array, mime:'image/png'|'image/jpeg'|'image/webp'}.
   * Takes trusted, server-retrieved assets only. Never accept arbitrary URLs from clients.
   */
  return async function render({ prompt, referenceImages = [], surface, safetyIdentifier, quality = 'high', size = '1024x1536', background, mask, moderationMode }) {
    if (!['sfw', 'adult'].includes(surface)) throw new Error('UNTRUSTED_SURFACE');
    if (!prompt || typeof prompt !== 'string') throw new Error('PROMPT_REQUIRED');
    if (referenceImages.length > MAX_REFERENCE_IMAGES) throw new Error('TOO_MANY_REFERENCES');
    if (!IMAGE_QUALITIES.includes(quality)) throw new Error('INVALID_IMAGE_QUALITY');
    if (!IMAGE_SIZES.includes(size)) throw new Error('INVALID_IMAGE_SIZE');

    // Less-restrictive provider moderation: adult surface AND explicitly enabled. Otherwise 'auto'.
    // 'low' needs BOTH the deployment switch (allowLowModeration) AND either the adult surface or a server-snapshotted per-user mode (Echō beta setting).
    const moderation = allowLowModeration === true && (surface === 'adult' || moderationMode === 'low') ? 'low' : 'auto';
    const standard = {
      model,
      prompt,
      moderation,
      quality,
      size,
      output_format: 'png',
      ...(background === 'transparent' || background === 'opaque' ? { background } : {}),
      n: 1,
      ...(includeSafetyIdentifier && safetyIdentifier ? { safety_identifier: safetyIdentifier } : {})
    };
    if (referenceImages.length === 0) {
      return submit('/images/generations', standard, false, moderation);
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(standard)) form.append(key, String(value));
    referenceImages.forEach((ref, i) => {
      if (!REF_MIMES.includes(ref.mime)) throw new Error('UNSUPPORTED_CANON_REFERENCE_FORMAT');
      const bytes = Buffer.from(ref.bytes);
      if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw new Error('CANON_REFERENCE_INVALID_SIZE');
      const ext = ref.mime === 'image/jpeg' ? 'jpg' : ref.mime.split('/')[1];
      form.append('image[]', new Blob([bytes], { type: ref.mime }), `canon-${i}.${ext}`);
    });
    if (mask) {   // trusted, server-built PNG: transparent pixels are the ONLY area the model may repaint
      if (mask.mime !== 'image/png') throw new Error('UNSUPPORTED_CANON_REFERENCE_FORMAT');
      const mb = Buffer.from(mask.bytes);
      if (!mb.length || mb.length > MAX_REFERENCE_BYTES) throw new Error('CANON_REFERENCE_INVALID_SIZE');
      form.append('mask', new Blob([mb], { type: 'image/png' }), 'mask.png');
    }
    // For 2.6, omit input_fidelity: that parameter is model-specific.
    return submit('/images/edits', form, true, moderation);
  };
}
