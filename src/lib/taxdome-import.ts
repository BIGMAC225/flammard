import { randomUUID } from 'node:crypto';
import { many, one, sql } from './db';
import { extractScorecardFromReport } from './claude';
import { stripNul } from './taxdome-files';
import { taxdomeReportDate } from './taxdome-date';
import { env } from './env';
import { taxdomeJobs } from './blobs';
import {
  JOB_HEADER,
  jobKeys,
  parseJobMeta,
  signTaxdomeJob,
  type TaxdomeJobMeta,
  type TaxdomeJobRequest,
} from './taxdome-job';
import type { ScorecardMetric } from '../types';

// TaxDome report → scorecard entries. Used by POST /api/integrations/taxdome
// inline (streamed JSON, no ?async) and by the Netlify background function
// netlify/functions/taxdome-import-background.mts (?async=1, used by Zapier),
// which may run up to 15 minutes, so a slow model finishes instead of being
// killed with the page request.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A report ready to import: what the webhook collected from the request. */
export interface TaxdomeReport {
  team: string;
  fileName: string | null;
  text: string | null;
  pdf: Buffer | null;
}

export interface TaxdomeImportResult {
  ok: true;
  import_id: string;
  period_date: string;
  entries_written: number;
  unmatched: unknown;
}

// pdfjs looks for its worker by relative path, which doesn't survive being
// bundled into a serverless function; hand it the inlined worker instead.
// Loaded on first use: pdfjs (and its native canvas polyfill) is only needed
// for PDF reports, so a CSV import never depends on it.
let pdfParse: Promise<typeof import('pdf-parse')> | null = null;
async function pdfToText(pdf: Buffer): Promise<string> {
  pdfParse ??= Promise.all([import('pdf-parse'), import('pdf-parse/worker')]).then(([mod, worker]) => {
    mod.PDFParse.setWorker(worker.getData());
    return mod;
  }).catch((err) => {
    pdfParse = null; // let the next PDF try again
    throw err;
  });
  const { PDFParse } = await pdfParse;
  const parser = new PDFParse({ data: pdf });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Writes a 'failed' row to the import log so it shows on the Scorecard page.
 * Never throws: if even this insert fails, the function log is all that's left.
 */
export async function logTaxdomeFailure(
  report: Pick<TaxdomeReport, 'team' | 'fileName' | 'text'>,
  message: string
): Promise<void> {
  try {
    await sql()`
      insert into taxdome_imports (team, file_name, raw_text, status, error)
      values (${report.team}, ${stripNul(report.fileName)}, ${stripNul(report.text)}, 'failed', ${stripNul(message)})
    `;
  } catch (err) {
    console.log('[taxdome] could not log failed import', message, err instanceof Error ? err.message : err);
  }
}

/**
 * Extracts the scorecard numbers and saves the import and its entries.
 * Every failure ends up as a 'failed' row in the import log (including ones
 * thrown by something unexpected) and is then rethrown.
 */
export async function runTaxdomeImport(report: TaxdomeReport): Promise<TaxdomeImportResult> {
  const { team, fileName } = report;
  let text = stripNul(report.text);
  const pdf = report.pdf;
  const db = sql();

  let failureLogged = false;
  const logFailure = async (message: string) => {
    failureLogged = true;
    await logTaxdomeFailure({ team, fileName, text }, message);
  };

  const work = async (): Promise<TaxdomeImportResult> => {
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

    // The model's reading of the period the report covers is kept on the
    // import row for reference only. It returns dates as text; don't let a
    // malformed one break the insert.
    const periodStart = extracted.period_start && ISO_DATE.test(extracted.period_start) ? extracted.period_start : null;
    const periodEnd = extracted.period_end && ISO_DATE.test(extracted.period_end) ? extracted.period_end : null;
    // The entries are dated by the day the report was produced (Chicago time),
    // read from the report's own timestamp rather than asked of the model.
    const periodDate = taxdomeReportDate(text);

    let importRow: { id: string } | null = null;
    try {
      importRow = await one<{ id: string }>(db`
        insert into taxdome_imports (team, file_name, report_title, period_start, period_end, raw_text, extracted, status, entries_written)
        values (${team}, ${fileName}, ${extracted.report_title}, ${periodStart}, ${periodEnd}, ${text}, ${JSON.stringify(extracted)}::jsonb,
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

  try {
    return await work();
  } catch (err) {
    if (!failureLogged) await logFailure(`Import failed: ${err instanceof Error ? err.message : 'unknown'}`);
    throw err;
  }
}

// ── Background job hand-off (?async=1) ────────────────────────────────────
// The report can be up to 20 MB, more than a function request body may carry,
// so it goes to Netlify Blobs; the background function gets only the job id.

const BACKGROUND_PATH = '/.netlify/functions/taxdome-import-background';

/**
 * Stores the report and calls the background function. Resolves with an
 * error message (and removes the stored report) when the job could not be
 * started; the caller logs that as a failed import.
 */
export async function startTaxdomeImportJob(origin: string, report: TaxdomeReport): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const jobId = randomUUID();
  const keys = jobKeys(jobId);
  const request: TaxdomeJobRequest = { job_id: jobId, team: report.team, file_name: report.fileName };

  let signature: string;
  try {
    signature = signTaxdomeJob(env('SESSION_SECRET'), request);
  } catch (err) {
    return { ok: false, error: `Could not start the background import: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const store = taxdomeJobs();
    const meta: TaxdomeJobMeta = { team: report.team, fileName: report.fileName, text: report.text, hasPdf: !!report.pdf };
    if (report.pdf) {
      const pdf = report.pdf;
      await store.set(keys.pdf, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer);
    }
    await store.setJSON(keys.meta, meta);
  } catch (err) {
    await deleteTaxdomeJob(jobId);
    return { ok: false, error: `Could not store the report for the background import: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const res = await fetch(new URL(BACKGROUND_PATH, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [JOB_HEADER]: signature },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202 || res.ok) return { ok: true, jobId };
    await deleteTaxdomeJob(jobId);
    return { ok: false, error: `Could not start the background import: background function answered HTTP ${res.status}` };
  } catch (err) {
    await deleteTaxdomeJob(jobId);
    return { ok: false, error: `Could not start the background import: ${err instanceof Error ? err.message : 'unreachable'}` };
  }
}

/** Loads a stored report; null when it is missing or malformed. */
export async function loadTaxdomeJob(jobId: string): Promise<TaxdomeReport | null> {
  const store = taxdomeJobs();
  const keys = jobKeys(jobId);
  const meta = parseJobMeta(await store.get(keys.meta, { type: 'json' }));
  if (!meta) return null;
  let pdf: Buffer | null = null;
  if (meta.hasPdf) {
    const bytes = await store.get(keys.pdf, { type: 'arrayBuffer' });
    if (!bytes) return null;
    pdf = Buffer.from(bytes);
  }
  return { team: meta.team, fileName: meta.fileName, text: meta.text, pdf };
}

/** Removes a job's stored report. Never throws. */
export async function deleteTaxdomeJob(jobId: string): Promise<void> {
  try {
    const store = taxdomeJobs();
    const keys = jobKeys(jobId);
    await Promise.all([store.delete(keys.meta), store.delete(keys.pdf)]);
  } catch (err) {
    console.log('[taxdome] could not delete job blobs', jobId, err instanceof Error ? err.message : err);
  }
}
