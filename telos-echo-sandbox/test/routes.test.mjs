import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneImageRoutes } from '../src/routes.mjs';
import { memoryJobs, sampleScene } from '../test-support/doubles.mjs';

const users = {
  alice: { userId: 'alice-0001', verifiedAdult: false, age: 29 },
  adultAlice: { userId: 'alice-0001', verifiedAdult: true, age: 29 },
  bob: { userId: 'bob-00001', verifiedAdult: true, age: 40 }
};
const images = new Map([
  ['img-sfw-0001', { id: 'img-sfw-0001', ownerId: 'alice-0001', surface: 'sfw', sceneId: 'scene-001', participantIds: ['telo-a'], createdAt: 't' }],
  ['img-adult-001', { id: 'img-adult-001', ownerId: 'alice-0001', surface: 'adult', sceneId: 'scene-001', participantIds: ['telo-a'], createdAt: 't' }],
  ['img-bob-00001', { id: 'img-bob-00001', ownerId: 'bob-00001', surface: 'sfw', sceneId: 'scene-bob1', participantIds: ['telo-b'], createdAt: 't' }]
]);

function setup({ enabled = true, csrfOk = true } = {}) {
  const enq = []; const bg = []; const quoteArgs = [];
  const jobs = memoryJobs();
  const routes = createSceneImageRoutes({
    auth: { authenticate: async (r) => users[r.headers?.['x-test-user']] ?? null, verifyCsrf: async () => csrfOk },
    surfaceForHost: (h) => ({ 'app.example.test': 'sfw', 'adult.example.test': 'adult' })[h] ?? null,
    scenes: { getAuthorizedScene: async (uid, sid) => (uid === 'alice-0001' && ['scene-001', 'scene-002'].includes(sid) ? sampleScene({ id: sid }) : null) },
    wallet: { createQuote: async (a) => { quoteArgs.push(a); return { quoteId: 'quote-0001', amount: 20, currency: 'skol', expiresAt: 'later' }; } },
    jobs, enqueue: async (id) => { enq.push(id); },
    media: {
      listOwnerImages: async (uid) => [...images.values()].filter((i) => i.ownerId === uid),
      getImage: async (id) => images.get(id) ?? null,
      openImage: async () => ({ body: Buffer.from('PNG'), mime: 'image/png' }),
      setChatBackground: async (uid, id) => { bg.push([uid, id]); }
    },
    config: { imageGenerationEnabled: enabled }
  });
  const call = (over) => routes({ method: 'GET', host: 'app.example.test', headers: { 'x-test-user': 'alice' }, query: {}, body: undefined, ...over });
  return { call, enq, bg, jobs, quoteArgs };
}
const jobBody = (over = {}) => ({ sceneId: 'scene-001', quoteId: 'quote-0001', idempotencyKey: 'quote-quote-0001', purpose: 'manual', ...over });

test('unknown host gets 404; unauthenticated gets 401', async () => {
  const { call } = setup();
  assert.equal((await call({ host: 'evil.example.test', path: '/api/scene-images/gallery' })).status, 404);
  assert.equal((await call({ headers: {}, path: '/api/scene-images/gallery' })).status, 401);
});

test('adult host is invisible (404) to an unverified account, available to a verified one', async () => {
  const { call } = setup();
  assert.equal((await call({ host: 'adult.example.test', path: '/api/scene-images/gallery' })).status, 404);
  assert.equal((await call({ host: 'adult.example.test', path: '/api/scene-images/gallery', headers: { 'x-test-user': 'adultAlice' } })).status, 200);
});

test('mutations need CSRF', async () => {
  const { call } = setup({ csrfOk: false });
  const r = await call({ method: 'POST', path: '/api/scene-images/quote', body: { sceneId: 'scene-001' } });
  assert.equal(r.status, 403);
});

test('quote: scene ownership enforced; price comes from the wallet; surface passed is server-derived', async () => {
  const { call, quoteArgs } = setup();
  const ok = await call({ method: 'POST', path: '/api/scene-images/quote', body: { sceneId: 'scene-001' } });
  assert.deepEqual(ok.json, { quoteId: 'quote-0001', amount: 20, currency: 'skol', free: false, expiresAt: 'later' });
  assert.equal(quoteArgs[0].surface, 'sfw');
  const other = await call({ method: 'POST', path: '/api/scene-images/quote', body: { sceneId: 'scene-001' }, headers: { 'x-test-user': 'bob' } });
  assert.equal(other.status, 404);
});

test('client-supplied surface / moderation / amount / model / reference images are rejected', async () => {
  const { call, enq } = setup();
  for (const f of ['surface', 'moderation', 'amount', 'currency', 'model', 'prompt', 'referenceImages', 'imageUrl']) {
    const r = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody({ [f]: 'adult' }) });
    assert.equal(r.status, 400, f);
    assert.equal(r.json.error, 'FORBIDDEN_FIELD');
  }
  assert.equal(enq.length, 0);
});

test('jobs: queued (202) and enqueued, never rendered inline; retry with same key reuses the job', async () => {
  const { call, enq, jobs } = setup();
  const a = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody() });
  const b = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody() });
  assert.equal(a.status, 202);
  assert.equal(a.json.state, 'queued');
  assert.equal(a.json.jobId, b.json.jobId);
  assert.equal(jobs.byId.size, 1);
  assert.ok(enq.length >= 1);
});

test('jobs: reusing an idempotency key for a different scene is a conflict (409)', async () => {
  const { call, enq } = setup();
  const first = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody() });
  assert.equal(first.status, 202);
  const clash = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody({ sceneId: 'scene-002' }) });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(enq.length, 1);
});

test('jobs: validation, oversize art direction, and kill switch', async () => {
  const { call } = setup();
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody({ idempotencyKey: 'x' }) })).status, 400);
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody({ artDirection: 'a'.repeat(4001) }) })).status, 400);
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody({ sceneId: 'scene-bob1x' }) })).status, 404);
  const off = setup({ enabled: false });
  assert.equal((await off.call({ method: 'POST', path: '/api/scene-images/quote', body: { sceneId: 'scene-001' } })).status, 503);
  assert.equal((await off.call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody() })).status, 503);
});

test('job status: owner only; failures show fixed sanitized text, not internal codes or provider text', async () => {
  const { call, jobs } = setup();
  const created = await call({ method: 'POST', path: '/api/scene-images/jobs', body: jobBody() });
  const id = created.json.jobId;
  assert.equal((await call({ path: `/api/scene-images/jobs/${id}`, headers: { 'x-test-user': 'bob' } })).status, 404);
  await jobs.fail(id, 'IMAGE_PROVIDER_HTTP_500');
  const failed = await call({ path: `/api/scene-images/jobs/${id}` });
  assert.equal(failed.json.state, 'failed');
  assert.equal(failed.json.message, 'This image could not be created.');
  assert.equal(JSON.stringify(failed.json).includes('HTTP_500'), false);
  await jobs.complete(id, { imageId: 'img-sfw-0001' });
  assert.equal((await call({ path: `/api/scene-images/jobs/${id}` })).json.imageId, 'img-sfw-0001');
});

test('gallery: SFW surface never lists adult images; adult surface lists both; other users never appear', async () => {
  const { call } = setup();
  const sfw = await call({ path: '/api/scene-images/gallery' });
  assert.deepEqual(sfw.json.images.map((i) => i.imageId), ['img-sfw-0001']);
  const adult = await call({ host: 'adult.example.test', path: '/api/scene-images/gallery', headers: { 'x-test-user': 'adultAlice' } });
  assert.deepEqual(adult.json.images.map((i) => i.imageId).sort(), ['img-adult-001', 'img-sfw-0001']);
  assert.equal((await call({ path: '/api/scene-images/gallery', query: { characterId: '../etc' } })).status, 400);
});

test('image fetch: owner only, adult blocked on SFW even for the owner, private no-store headers', async () => {
  const { call } = setup();
  const ok = await call({ path: '/api/scene-images/img-sfw-0001' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Cache-Control'], 'private, no-store');
  assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await call({ path: '/api/scene-images/img-adult-001' })).status, 404);
  assert.equal((await call({ path: '/api/scene-images/img-bob-00001' })).status, 404);
  assert.equal((await call({ host: 'adult.example.test', path: '/api/scene-images/img-adult-001', headers: { 'x-test-user': 'adultAlice' } })).status, 200);
});

test('set-background: explicit POST, owner only, adult image refused on SFW', async () => {
  const { call, bg } = setup();
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/img-sfw-0001/set-background', body: {} })).status, 200);
  assert.deepEqual(bg, [['alice-0001', 'img-sfw-0001']]);
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/img-adult-001/set-background', body: {} })).status, 404);
  assert.equal((await call({ method: 'POST', path: '/api/scene-images/img-bob-00001/set-background', body: {} })).status, 404);
  assert.equal(bg.length, 1);
});

test('router construction fails fast on missing adapters', () => {
  assert.throws(() => createSceneImageRoutes({}), /MISSING_SERVER_ADAPTER/);
});
