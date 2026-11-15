import { createHash } from 'node:crypto';
import { buildSceneImagePrompt } from './prompt-builder.mjs';
import { IMAGE_QUALITIES, IMAGE_SIZES } from './openai-image-api.mjs';

/**
 * Backend worker, wired via explicit dependency adapters.
 * All adapters MUST be real in production; there are no fake auth, billing, age-check or storage
 * fallbacks. Call from a durable job worker, not from a short-lived browser request.
 *
 * Changes from the handoff reference (all covered by test/core.test.mjs):
 *  1. Atomic job claim (jobs.claim: created -> working, compare-and-set). The reference only did a
 *     plain setState after reserving funds, so two workers could both render and both charge.
 *  2. Every failure after the job exists marks the job failed with a SANITIZED code. The reference
 *     left early failures (scene not found, canon missing, safeguards, quote) stuck in "created"
 *     and stored raw error.message text.
 *  3. A hold that was already committed is never released. The reference released in the catch
 *     block even if the failure happened after wallet.commit (e.g. jobs.complete threw).
 *  4. Age/minor checks fail CLOSED: every character must positively carry canonAgeClass 'adult'.
 *     The reference only rejected characters explicitly flagged, so missing fields passed.
 *  5. The accepted quote must be bound to this user and scene, with a sane amount/currency.
 *  7. Canon reference images load BEFORE the prompt is built (so a missing asset fails before any hold),
 *     and the prompt carries a manifest naming which attached image is which subject.
 *  8. Optional quality/size are validated; provider usage is saved for cost tracking.
 *  6. The saved image record carries provider model, moderation mode, request id, ledger ref,
 *     character ids and canon versions, per the handoff's record list.
 */

const REQUIRED_METHODS = {
  scenes: ['getAuthorizedScene'],
  canon: ['getCharacterSnapshots', 'getWorldSnapshot'],
  media: ['loadCanonReferences', 'savePrivateImage'],
  wallet: ['verifyAcceptedQuote', 'reserve', 'commit', 'release'],
  jobs: ['findOrCreate', 'claim', 'complete', 'fail'],
  safeguards: ['beforeGeneration', 'afterGeneration']
};

/** Only machine codes (UPPER_SNAKE) reach the job record / UI. Anything else becomes GENERATION_FAILED. */
export function publicFailureCode(error) {
  const m = String(error?.message ?? '');
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(m) ? m : 'GENERATION_FAILED';
}

const isPlainAdult = (c) => c.canonAgeClass === 'adult' && !c.ageAmbiguous && !c.minorPresenting;

export function createSceneImageService({ scenes, canon, media, wallet, jobs, safeguards, openaiImage, logger = null }) {
  const adapters = { scenes, canon, media, wallet, jobs, safeguards };
  for (const [key, methods] of Object.entries(REQUIRED_METHODS)) {
    if (!adapters[key]) throw new Error(`MISSING_SERVER_ADAPTER_${key}`);
    for (const m of methods) {
      if (typeof adapters[key][m] !== 'function') throw new Error(`MISSING_SERVER_ADAPTER_${key}.${m}`);
    }
  }
  if (typeof openaiImage !== 'function') throw new Error('MISSING_SERVER_ADAPTER_openaiImage');

  return async function generateSceneImage({ principal, request, trustedSurface }) {
    // principal and trustedSurface originate from trusted server middleware; request is user input.
    if (!principal?.userId || !['sfw', 'adult'].includes(trustedSurface)) throw new Error('UNAUTHORIZED');
    if (trustedSurface === 'adult' && !(principal.verifiedAdult === true && principal.age >= 18)) {
      throw new Error('ADULT_VERIFICATION_REQUIRED');
    }
    if (!request?.sceneId || !/^[a-zA-Z0-9._:-]{8,128}$/.test(request.idempotencyKey || '')) {
      throw new Error('INVALID_IMAGE_REQUEST');
    }
    if (!['manual', 'milestone', 'suggestion_accepted'].includes(request.purpose)) {
      throw new Error('UNKNOWN_IMAGE_PURPOSE');
    }
    if ((request.quality !== undefined && !IMAGE_QUALITIES.includes(request.quality)) ||
        (request.size !== undefined && !IMAGE_SIZES.includes(request.size))) {
      throw new Error('INVALID_IMAGE_REQUEST');
    }

    // jobs.findOrCreate MUST be backed by a unique DB index on (user_id, idempotency_key).
    const job = await jobs.findOrCreate(principal.userId, request.idempotencyKey);
    if (job.state === 'complete') return job.result;
    if (job.state !== 'created') return { jobId: job.id, state: job.state };
    // Atomic created -> working. Only the worker that wins this proceeds; no double render/charge.
    if (!(await jobs.claim(job.id))) return { jobId: job.id, state: 'working' };

    let hold = null;
    let committed = false;
    try {
      const scene = await scenes.getAuthorizedScene(principal.userId, request.sceneId);
      if (!scene) throw new Error('SCENE_NOT_FOUND');
      if (scene.privateAdult && trustedSurface !== 'adult') throw new Error('SURFACE_ISOLATION');

      // Historical scenes MUST use the appearance snapshot at the event timestamp, not current state.
      const snapshots = await canon.getCharacterSnapshots(principal.userId, scene.participantIds, scene.occurredAt);
      const world = await canon.getWorldSnapshot(scene.worldId, scene.occurredAt);
      if (!snapshots?.length || !world) throw new Error('CANON_SNAPSHOT_MISSING');
      if (!snapshots.every(isPlainAdult)) throw new Error('MINOR_OR_AMBIGUOUS_CHARACTER_BLOCKED');
      if (trustedSurface === 'adult' && snapshots.some((c) => c.adultEligible !== true)) {
        throw new Error('CHARACTER_NOT_ELIGIBLE_FOR_ADULT_SURFACE');
      }

      const refs = await media.loadCanonReferences(principal.userId, snapshots, world, scene);
      if (!Array.isArray(refs) || refs.some((r) => !r.bytes || !r.mime)) throw new Error('CANON_REFERENCES_UNAVAILABLE');
      const referenceManifest = refs.map((r) => r.label).filter(Boolean).length === refs.length ? refs.map((r) => r.label) : [];
      const prompt = buildSceneImagePrompt({
        scene, characters: snapshots, world, requestText: request.artDirection ?? '', mode: request.mode ?? 'cinematic', referenceManifest
      });
      // Content / consent / likeness rules are checked before the provider call and again on the output.
      await safeguards.beforeGeneration({ principal, trustedSurface, scene, snapshots, prompt });

      // verifyAcceptedQuote MUST validate signature, expiry, user, scene, purpose, currency and the
      // user's explicit confirmation server-side. Never trust an amount sent by the browser.
      const quote = await wallet.verifyAcceptedQuote({ principal, scene, purpose: request.purpose,
        priority: request.priority === true, quoteId: request.quoteId ?? null });
      if (!quote || !Number.isFinite(quote.amount) || quote.amount < 0) throw new Error('QUOTE_INVALID');
      if (quote.userId !== principal.userId || quote.sceneId !== scene.id) throw new Error('QUOTE_MISMATCH');
      if (quote.amount > 0 && (typeof quote.currency !== 'string' || !quote.currency)) throw new Error('QUOTE_INVALID');
      // Milestone media unlocks are always free; extra generations are priced by the economy config.
      if (request.purpose === 'milestone' && quote.amount !== 0) throw new Error('MILESTONE_MUST_BE_FREE');
      if (quote.amount > 0 && quote.userConfirmed !== true) throw new Error('PRICE_CONFIRMATION_REQUIRED');

      hold = await wallet.reserve({ principal, quote, idempotencyKey: request.idempotencyKey });

      const safetyIdentifier = createHash('sha256').update(principal.userId).digest('hex');
      const result = await openaiImage({ prompt, referenceImages: refs, surface: trustedSurface, safetyIdentifier,
        ...(request.quality ? { quality: request.quality } : {}), ...(request.size ? { size: request.size } : {}) });

      const evaluation = await safeguards.afterGeneration({ principal, scene, snapshots, trustedSurface, bytes: result.bytes });
      if (!evaluation?.approved) throw new Error('IMAGE_FAILED_SAFEGUARDS_OR_FIDELITY');

      const canonHash = createHash('sha256').update(JSON.stringify(snapshots.map((c) => [c.id, c.canonVersion]))).digest('hex');
      const saved = await media.savePrivateImage({
        ownerId: principal.userId, bytes: result.bytes, mime: result.mime,
        sceneId: scene.id, participantIds: scene.participantIds, worldId: scene.worldId,
        locationId: scene.locationId ?? null, occurredAt: scene.occurredAt, surface: trustedSurface,
        visibility: 'private', canonHash, canonVersions: snapshots.map((c) => ({ id: c.id, version: c.canonVersion })),
        canonApproved: false, externallyShareable: false, // sharing needs a separate SFW-only policy route
        providerModel: result.model ?? null, moderation: result.moderation ?? null, providerUsage: result.usage ?? null,
        referenceCount: refs.length, endpoint: refs.length ? 'edits' : 'generations',
        requestId: job.id, ledgerRef: hold?.id ?? null, status: 'approved',
        watermark: { jobId: job.id, ownerId: principal.userId, sceneId: scene.id }
      });

      await wallet.commit(hold);
      committed = true;
      const response = { jobId: job.id, state: 'complete', imageId: saved.id,
        visibility: 'private', canonApproved: false, surface: trustedSurface };
      await jobs.complete(job.id, response);
      return response;
    } catch (error) {
      const code = publicFailureCode(error);
      // Never release a hold that was already committed (the image exists and was paid for).
      if (hold && !committed) {
        try { await wallet.release(hold); } catch (e) { logger?.error?.({ jobId: job.id, code: 'RELEASE_FAILED' }); }
      }
      try { await jobs.fail(job.id, code); } catch (e) { logger?.error?.({ jobId: job.id, code: 'JOB_FAIL_WRITE_FAILED' }); }
      // Private diagnostics only: provider request details never reach the user or the job record.
      logger?.error?.({ jobId: job.id, code, committed, diagnostic: error?.providerDiagnostic ?? null });
      throw error;
    }
  };
}
