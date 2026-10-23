// Netlify background function: runs one fulfillment poll (enqueued by the
// scheduled function netlify/functions/fulfillment-poll.mts through
// /api/integrations/fulfillment-poll-run). Background functions answer 202 at
// once and may run up to 15 minutes, which the paced TaxDome walk (one
// request per 500 ms) needs.
//
// Called only by the trigger route with a signature derived from
// SESSION_SECRET over { run_id } (same scheme as taxdome-import-background,
// different derivation label). runFulfillmentPoll records its own outcome in
// import_runs; this function only logs.

import { env } from '../../src/lib/env';
import { one, sql } from '../../src/lib/db';
import { runFulfillmentPoll } from '../../src/lib/fulfillment-poll';
import { POLL_JOB_HEADER, parsePollRequest, verifyPollJob } from '../../src/lib/fulfillment-poll-job';

export default async (req: Request): Promise<void> => {
  const job = parsePollRequest(await req.text().catch(() => ''));
  if (!job) {
    console.log('[fulfillment-poll] rejected: bad job request');
    return;
  }
  if (!verifyPollJob(env('SESSION_SECRET'), job, req.headers.get(POLL_JOB_HEADER))) {
    console.log('[fulfillment-poll] rejected: bad signature');
    return;
  }

  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  try {
    const run = await one<{ id: number; status: string }>(sql()`select id, status from import_runs where id = ${job.run_id}`);
    if (!run || run.status !== 'running') {
      console.log(`[fulfillment-poll] run ${job.run_id} skipped: ${run ? `status ${run.status}` : 'not found'}`);
      return;
    }
    const result = await runFulfillmentPoll(job.run_id);
    console.log(`[fulfillment-poll] run ${job.run_id} done in ${secs()}s`, JSON.stringify(result));
  } catch (err) {
    // runFulfillmentPoll has already recorded the failed run
    console.log(`[fulfillment-poll] run ${job.run_id} failed after ${secs()}s: ${err instanceof Error ? err.message : err}`);
  }
};
