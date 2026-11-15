/**
 * Screening hooks. DELIBERATELY NOT IMPLEMENTED YET (Chris, Nov 15 2026: four known testers, screening deferred).
 * Master 18.7A / 14B.2 / 14B.3 require, before strangers use this: public-figure + minor screening of uploaded
 * photos, and a post-generation likeness check on every output. Plug a real provider in here; the generation
 * pipeline already refunds the free allotment whenever afterGeneration returns approved:false.
 * SCREEN_MODE=reject-all is a drill/test switch that rejects everything; the default 'off' approves.
 */
export async function screenUpload({ bytes, mime }, env) {
  if (env.SCREEN_MODE === 'reject-all') return { ok: false, code: 'UPLOAD_FAILED_SCREENING', status: 'rejected' };
  return { ok: true, status: 'not_run' };
}

export async function screenOutput({ bytes }, env) {
  if (env.SCREEN_MODE === 'reject-all') return { approved: false, status: 'rejected' };
  return { approved: true, status: 'not_run' };
}
