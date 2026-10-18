import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { json } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { aiProvider } from '../../../lib/claude';
import { streamJSON } from '../../../lib/stream-json';
import { isTeam } from '../../../lib/teams';
import { collectReportFiles, MAX_REPORT_BYTES, ReportTooLargeError, stripNul, type ReportFile } from '../../../lib/taxdome-files';
import { env } from '../../../lib/env';
import { logTaxdomeFailure, runTaxdomeImport, startTaxdomeImportJob, type TaxdomeReport } from '../../../lib/taxdome-import';

// Inbound webhook for TaxDome report exports, called by Zapier when the
// scheduled report email arrives. See docs/AUTOMATION.md for the Zap setup.
//
// Accepts, in order of preference:
//   1. multipart/form-data with the PDF, CSVs, or a .zip of them as file parts
//      (Zapier's Gmail "All Attachments" sends one .zip)
//   2. JSON { "file_url": "https://...", "file_name": "report.pdf" }  (PDF, CSV or .zip)
//   3. JSON { "file_base64": "...", "file_name": "report.pdf" }       (PDF, CSV or .zip)
//   4. JSON { "text": "..." } (already-extracted text)
//
// Auth: `Authorization: Bearer <TAXDOME_WEBHOOK_SECRET>`.
// Team: `?team=leadership|management` (default leadership) — one Zap per team.

// With ?async=1 the import itself runs in the background function
// netlify/functions/taxdome-import-background.mts; see src/lib/taxdome-import.ts.

const MAX_FILE_BYTES = MAX_REPORT_BYTES;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request, url }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  const teamParam = url.searchParams.get('team') ?? 'leadership';
  if (!isTeam(teamParam)) return json({ error: 'Unknown team' }, 400);
  const team = teamParam;
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);

  const auth = request.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  // One line per call so a Zap can be debugged from the function log (no secrets logged)
  console.log(
    `[taxdome] request team=${team} type=${(request.headers.get('content-type') ?? '').split(';')[0]} ` +
      `length=${request.headers.get('content-length') ?? '?'} auth=${secretMatches(token, secret) ? 'ok' : auth ? 'wrong' : 'missing'}`
  );
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);

  let fileName: string | null = null;
  let pdf: Buffer | null = null;
  let text: string | null = null;
  let skipped: string[] = [];

  try {
    const contentType = request.headers.get('content-type') ?? '';
    // TaxDome's scheduled liveboard email can carry one PDF or one CSV per
    // tile; Zapier forwards all of them, either as separate files or as one
    // .zip. Text files are joined (each under its file name) and handed to the
    // extractor together; a PDF is used when there's no text file.
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
      ({ text, pdf, skipped } = collected);
      fileName = (collected.names.length ? collected.names.join(', ') : jsonName)?.slice(0, 500) ?? null;
      console.log(
        `[taxdome] files=${collected.names.length} text=${text ? 'yes' : 'no'} pdf=${pdf ? 'yes' : 'no'} names=${fileName ?? ''}` +
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

  if (!pdf && !text) return json({ error: 'No report attached', ...(skipped.length ? { skipped } : {}) }, 400);

  const report: TaxdomeReport = { team, fileName, text, pdf };

  // ?async=1 (used by the Flammard Zapier app, whose actions time out after
  // about 30s): hand the report to the background function (up to 15 minutes)
  // and answer at once. The result lands in the Scorecard page's import log.
  // If the job can't be started, that is logged as a failed import too.
  if (url.searchParams.get('async') === '1') {
    const job = await startTaxdomeImportJob(url.origin, report);
    if (!job.ok) {
      console.log('[taxdome] async import not started', job.error);
      await logTaxdomeFailure(report, job.error);
      return json({ error: job.error, files: fileName, ...(skipped.length ? { skipped } : {}) }, 502);
    }
    console.log(`[taxdome] async import queued job=${job.jobId}`);
    return json({ ok: true, accepted: true, files: fileName, ...(skipped.length ? { skipped } : {}), note: 'Import is running; check the Scorecard page in a minute.' }, 202);
  }
  return streamJSON(() => runTaxdomeImport(report));
};

// Connection check for the Flammard Zapier app: 200 with the team's active
// metric count when the secret is right, 401 otherwise.
export const GET: APIRoute = async ({ request, url }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);
  const team = url.searchParams.get('team') ?? 'leadership';
  if (!isTeam(team)) return json({ error: 'Unknown team' }, 400);
  const row = await one<{ n: number }>(sql()`select count(*)::int as n from scorecard_metrics where active and team = ${team}`);
  return json({ ok: true, team, active_metrics: row?.n ?? 0, ai_provider: aiProvider() });
};
