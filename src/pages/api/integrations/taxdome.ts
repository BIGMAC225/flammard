import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { getData as pdfWorkerData } from 'pdf-parse/worker';
import { json } from '../../../lib/api';
import { many, one, sql } from '../../../lib/db';
import { aiProvider, extractScorecardFromReport } from '../../../lib/claude';
import { streamJSON } from '../../../lib/stream-json';
import { isTeam } from '../../../lib/teams';
import { collectReportFiles, MAX_REPORT_BYTES, ReportTooLargeError, stripNul, type ReportFile } from '../../../lib/taxdome-files';
import { env } from '../../../lib/env';
import type { ScorecardMetric } from '../../../types';

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

const MAX_FILE_BYTES = MAX_REPORT_BYTES;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// pdfjs looks for its worker by relative path, which doesn't survive being
// bundled into a serverless function; hand it the inlined worker instead.
let workerReady = false;
async function pdfToText(pdf: Buffer): Promise<string> {
  if (!workerReady) {
    PDFParse.setWorker(pdfWorkerData());
    workerReady = true;
  }
  const parser = new PDFParse({ data: pdf });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export const POST: APIRoute = async ({ request, url, locals }) => {
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

  const db = sql();

  // Every failure ends up as a 'failed' row in the import log, including ones
  // thrown by something unexpected; if even that insert fails, the function
  // log is all that's left.
  let failureLogged = false;
  const logFailure = async (message: string) => {
    failureLogged = true;
    try {
      await db`
        insert into taxdome_imports (team, file_name, raw_text, status, error)
        values (${team}, ${fileName}, ${text}, 'failed', ${stripNul(message)})
      `;
    } catch (err) {
      console.log('[taxdome] could not log failed import', message, err instanceof Error ? err.message : err);
    }
  };

  const work = async () => {
    const metrics = await many<Pick<ScorecardMetric, 'id' | 'title' | 'goal' | 'unit' | 'frequency' | 'description'>>(
      db`select id, title, goal, unit, frequency, description from scorecard_metrics where active and team = ${team} order by sort_order`
    );

    // Records the failure so it shows on the Scorecard page, then throws
    const fail = async (message: string): Promise<never> => {
      await logFailure(message);
      throw new Error(message);
    };

    if (!metrics.length) await fail('No active scorecard metrics — add metrics in the Scorecard page first');

    if (!text && pdf) {
      try {
        text = stripNul(await pdfToText(pdf));
      } catch (err) {
        await fail(`PDF text extraction failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
    if (!text || text.trim().length < 30) await fail('The PDF contains no readable text');

    let extracted;
    try {
      extracted = await extractScorecardFromReport(text!, metrics);
    } catch (err) {
      return fail(`Extraction failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // The model returns dates as text; don't let a malformed one break the insert
    const periodStart = extracted.period_start && ISO_DATE.test(extracted.period_start) ? extracted.period_start : null;
    const periodDate =
      extracted.period_end && ISO_DATE.test(extracted.period_end)
        ? extracted.period_end
        : new Date().toISOString().slice(0, 10);

    let importRow: { id: string } | null = null;
    try {
      importRow = await one<{ id: string }>(db`
        insert into taxdome_imports (team, file_name, report_title, period_start, period_end, raw_text, extracted, status, entries_written)
        values (${team}, ${fileName}, ${extracted.report_title}, ${periodStart}, ${periodDate}, ${text}, ${JSON.stringify(extracted)}::jsonb,
                'processed', ${extracted.values.length})
        returning id
      `);
    } catch (err) {
      return fail(`Saving import failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    if (!importRow) return fail('Saving import failed');

    try {
      const rowId = importRow.id;
      if (extracted.values.length) {
        await db.transaction(
          extracted.values.map(
            (v) => db`
              insert into scorecard_entries (metric_id, period_date, value, on_track, notes, source, import_id)
              values (${v.metric_id}, ${periodDate}, ${v.value}, ${v.on_track}, ${v.notes}, 'taxdome', ${rowId})
              on conflict (metric_id, period_date) do update set
                value = excluded.value, on_track = excluded.on_track, notes = excluded.notes,
                source = 'taxdome', import_id = excluded.import_id`
          )
        );
      }
    } catch (err) {
      const message = `Saving entries failed: ${err instanceof Error ? err.message : 'unknown'}`;
      failureLogged = true;
      await db`update taxdome_imports set status = 'failed', error = ${stripNul(message)}, entries_written = 0 where id = ${importRow.id}`;
      throw new Error(message);
    }

    return {
      ok: true,
      import_id: importRow.id,
      period_date: periodDate,
      entries_written: extracted.values.length,
      unmatched: extracted.unmatched,
    };
  };

  const run = async () => {
    try {
      return await work();
    } catch (err) {
      if (!failureLogged) await logFailure(`Import failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw err;
    }
  };

  // ?async=1 (used by the Flammard Zapier app, whose actions time out after
  // about 30s): answer at once and finish the import after the response.
  // The result lands in the Scorecard page's import log either way.
  const waitUntil = (locals as { netlify?: { context?: { waitUntil?: (p: Promise<unknown>) => void } } }).netlify?.context
    ?.waitUntil;
  if (url.searchParams.get('async') === '1' && typeof waitUntil === 'function') {
    waitUntil(
      run()
        .then((r) => console.log('[taxdome] async import done', JSON.stringify(r)))
        .catch((err) => console.log('[taxdome] async import failed', err instanceof Error ? err.message : err))
    );
    return json({ ok: true, accepted: true, files: fileName, ...(skipped.length ? { skipped } : {}), note: 'Import is running; check the Scorecard page in a minute.' }, 202);
  }
  return streamJSON(run);
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
