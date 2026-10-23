// Netlify background function: runs one fulfillment CSV import (Zapier's
// POST /api/integrations/taxdome-jobs?async=1, implementation plan section J
// step 8). Background functions answer 202 at once and may run up to 15
// minutes, so Zapier's 30-second limit never cuts the import off.
//
// Called only by the webhook route with a signature derived from
// SESSION_SECRET over { job_id, file_name } (same scheme as
// taxdome-import-background, different derivation label
// 'flammard:fulfillment-import'). The collected export text is in Netlify
// Blobs (store "fulfillment-jobs") under the job id and is deleted here once
// processed. runFulfillmentCsvImport records its own outcome in import_runs;
// this function only logs.

import { env } from '../../src/lib/env';
import {
  CSV_JOB_HEADER,
  deleteFulfillmentCsvJob,
  loadFulfillmentCsvJob,
  logFulfillmentCsvFailure,
  parseCsvJobRequest,
  runFulfillmentCsvImport,
  verifyFulfillmentCsvJob,
} from '../../src/lib/fulfillment-csv-import';

export default async (req: Request): Promise<void> => {
  const job = parseCsvJobRequest(await req.text().catch(() => ''));
  if (!job) {
    console.log('[fulfillment-import] rejected: bad job request');
    return;
  }
  if (!verifyFulfillmentCsvJob(env('SESSION_SECRET'), job, req.headers.get(CSV_JOB_HEADER))) {
    console.log('[fulfillment-import] rejected: bad signature');
    return;
  }

  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  try {
    let stored;
    try {
      stored = await loadFulfillmentCsvJob(job.job_id);
    } catch (err) {
      throw new Error(`Could not load the stored export: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    if (!stored) throw new Error('the stored export was not found');

    try {
      const result = await runFulfillmentCsvImport({ fileName: job.file_name ?? stored.fileName, text: stored.text });
      console.log(`[fulfillment-import] ${job.job_id} done in ${secs()}s`, JSON.stringify(result));
    } catch (err) {
      // runFulfillmentCsvImport has already recorded the failed run
      console.log(`[fulfillment-import] ${job.job_id} failed after ${secs()}s: ${err instanceof Error ? err.message : err}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    await logFulfillmentCsvFailure(job.file_name, `Background import failed: ${message}`);
    console.log(`[fulfillment-import] ${job.job_id} failed after ${secs()}s: ${message}`);
  } finally {
    await deleteFulfillmentCsvJob(job.job_id);
  }
};
