import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { json } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { env } from '../../../lib/env';
import { CsvValidationError } from '../../../lib/fulfillment-csv';
import {
  logFulfillmentCsvFailure,
  runFulfillmentCsvImport,
  startFulfillmentCsvJob,
} from '../../../lib/fulfillment-csv-import';
import { collectReportFiles, MAX_REPORT_BYTES, ReportTooLargeError, stripNul, type ReportFile } from '../../../lib/taxdome-files';

// Inbound webhook for the fulfillment CSV fallback (implementation plan,
// section J step 8), called by Zapier's second Zap when TaxDome emails the
// "Fulfillment Snapshot" R1 export. See docs/AUTOMATION.md section 5.
//
// Accepts, in order of preference (same shapes as /api/integrations/taxdome):
//   1. multipart/form-data with the CSV(s) or a .zip of them as file parts
//      (Zapier's Gmail "All Attachments" sends one .zip)
//   2. JSON { "file_url": "https://...", "file_name": "report.csv" }
//   3. JSON { "file_base64": "...", "file_name": "report.csv" }
//   4. JSON { "text": "..." } (already-extracted text)
//
// Auth: `Authorization: Bearer <TAXDOME_WEBHOOK_SECRET>`.
// With ?async=1 the import runs in the background function
// netlify/functions/fulfillment-import-background.mts; see
// src/lib/fulfillment-csv-import.ts.

const MAX_FILE_BYTES = MAX_REPORT_BYTES;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request, url }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);

  const auth = request.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  // One line per call so a Zap can be debugged from the function log (no secrets logged)
  console.log(
    `[fulfillment-csv] request type=${(request.headers.get('content-type') ?? '').split(';')[0]} ` +
      `length=${request.headers.get('content-length') ?? '?'} auth=${secretMatches(token, secret) ? 'ok' : auth ? 'wrong' : 'missing'}`
  );
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);

  let fileName: string | null = null;
  let text: string | null = null;
  let skipped: string[] = [];

  try {
    const contentType = request.headers.get('content-type') ?? '';
    // Zapier forwards the email's attachments as one .zip (or several files);
    // collectReportFiles unzips in memory and joins the text files under
    // their names. A PDF attachment, if any, is ignored — the R1 export is CSV.
    const files: ReportFile[] = [];
    let jsonName: string | null = null;
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      let total = 0;
      for (const value of form.values()) {
        if (!(value instanceof File)) continue;
        total += value.size;
        if (value.size > MAX_FILE_BYTES || total > MAX_FILE_BYTES) return json({ error: 'Files are too large (20 MB max)' }, 413);
        files.push({ name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
    } else {
      const body = (await request.json()) as {
        file_url?: string;
        file_base64?: string;
        file_name?: string;
        text?: string;
      };
      jsonName = body.file_name ?? null;
      if (body.text) text = body.text;
      else if (body.file_base64) {
        const bytes = Buffer.from(body.file_base64, 'base64');
        if (bytes.length > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
        files.push({ name: jsonName ?? 'report', bytes });
      } else if (body.file_url) {
        // Only fetch over https, and never more than we'd accept as an upload
        if (!/^https:\/\//i.test(body.file_url)) return json({ error: 'file_url must be https' }, 400);
        const res = await fetch(body.file_url, { redirect: 'follow' });
        if (!res.ok) return json({ error: `Could not download file (${res.status})` }, 400);
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
        files.push({ name: jsonName ?? 'report', type: res.headers.get('content-type') ?? '', bytes: new Uint8Array(bytes) });
      }
    }
    if (files.length) {
      const collected = collectReportFiles(files);
      ({ text, skipped } = collected);
      fileName = (collected.names.length ? collected.names.join(', ') : jsonName)?.slice(0, 500) ?? null;
      console.log(
        `[fulfillment-csv] files=${collected.names.length} text=${text ? 'yes' : 'no'} names=${fileName ?? ''}` +
          (skipped.length ? ` skipped=${skipped.join('; ')}` : '')
      );
    } else {
      fileName = jsonName;
    }
  } catch (err) {
    if (err instanceof ReportTooLargeError) return json({ error: err.message }, 413);
    return json({ error: 'Could not read request body' }, 400);
  }

  // Postgres rejects text containing NUL, which would also sink the failure log
  text = stripNul(text);
  fileName = stripNul(fileName);

  if (!text) return json({ error: 'No CSV attached', ...(skipped.length ? { skipped } : {}) }, 400);

  // ?async=1 (Zapier's actions time out after about 30s): park the collected
  // text in Blobs, hand it to the background function (up to 15 minutes) and
  // answer at once. The result lands in import_runs (source 'csv'). If the
  // job can't be started, that is logged as a failed import too.
  if (url.searchParams.get('async') === '1') {
    const job = await startFulfillmentCsvJob(url.origin, { fileName, text });
    if (!job.ok) {
      console.log('[fulfillment-csv] async import not started', job.error);
      await logFulfillmentCsvFailure(fileName, job.error);
      return json({ error: job.error, files: fileName, ...(skipped.length ? { skipped } : {}) }, 502);
    }
    console.log(`[fulfillment-csv] async import queued job=${job.jobId}`);
    return json({ ok: true, accepted: true, files: fileName, ...(skipped.length ? { skipped } : {}), run: 'pending' }, 202);
  }

  try {
    return json(await runFulfillmentCsvImport({ fileName, text }));
  } catch (err) {
    if (err instanceof CsvValidationError) return json({ error: err.message }, 422);
    console.log('[fulfillment-csv] inline import failed', err instanceof Error ? err.message : err);
    return json({ error: err instanceof Error ? err.message : 'Import failed' }, 500);
  }
};

// Latest CSV import run, for checking on a manual send.
export const GET: APIRoute = async ({ request }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);
  const latest = await one<Record<string, unknown>>(
    sql()`select id, status, started_at, finished_at, snapshot_date, jobs_written, error, detail
         from import_runs where source = 'csv' order by id desc limit 1`
  );
  return json({ latest: latest ?? null });
};
