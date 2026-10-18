// Netlify background function: runs one TaxDome report import (Zapier's
// POST /api/integrations/taxdome?async=1). Background functions answer 202 at
// once and may run up to 15 minutes, so a slow extraction model finishes
// instead of being killed with the page request (which is what happened when
// the import ran under waitUntil in the SSR function: no row was ever logged).
//
// Called only by the webhook route with a signature derived from
// SESSION_SECRET over { job_id, team, file_name } (same scheme as
// analyze-meeting-background). The report itself is in Netlify Blobs (store
// "taxdome-jobs", up to 20 MB) under the job id and is deleted here once
// processed. The result (or the error) is written to taxdome_imports and
// shows in the Scorecard page's import log.
//
// Unlike analyze-meeting-background this uses the v2 (Request) signature: v2
// functions are bundled as ESM, which pdfjs (PDF reports) needs, and get the
// Blobs context without connectLambda.

import { env } from '../../src/lib/env';
import { isTeam } from '../../src/lib/teams';
import { deleteTaxdomeJob, loadTaxdomeJob, logTaxdomeFailure, runTaxdomeImport } from '../../src/lib/taxdome-import';
import { JOB_HEADER, parseJobRequest, verifyTaxdomeJob } from '../../src/lib/taxdome-job';

export default async (req: Request): Promise<void> => {
  const job = parseJobRequest(await req.text().catch(() => ''));
  if (!job || !isTeam(job.team)) {
    console.log('[taxdome-job] rejected: bad job request');
    return;
  }
  if (!verifyTaxdomeJob(env('SESSION_SECRET'), job, req.headers.get(JOB_HEADER))) {
    console.log('[taxdome-job] rejected: bad signature');
    return;
  }

  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  const logged = { team: job.team, fileName: job.file_name, text: null };
  try {
    let report;
    try {
      report = await loadTaxdomeJob(job.job_id);
    } catch (err) {
      throw new Error(`Could not load the stored report: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    if (!report) throw new Error('the stored report was not found');

    try {
      const result = await runTaxdomeImport({ ...report, team: job.team, fileName: job.file_name });
      console.log(`[taxdome-job] ${job.job_id} done in ${secs()}s`, JSON.stringify(result));
    } catch (err) {
      // runTaxdomeImport has already logged the failed import
      console.log(`[taxdome-job] ${job.job_id} failed after ${secs()}s: ${err instanceof Error ? err.message : err}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    await logTaxdomeFailure(logged, `Background import failed: ${message}`);
    console.log(`[taxdome-job] ${job.job_id} failed after ${secs()}s: ${message}`);
  } finally {
    await deleteTaxdomeJob(job.job_id);
  }
};
