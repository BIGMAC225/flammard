import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { getData as pdfWorkerData } from 'pdf-parse/worker';
import { json } from '../../../lib/api';
import { createServiceClient } from '../../../lib/supabase-server';
import { extractScorecardFromReport } from '../../../lib/claude';
import { streamJSON } from '../../../lib/stream-json';
import type { ScorecardMetric } from '../../../types';

// Inbound webhook for TaxDome report exports, called by Zapier when the
// scheduled report email arrives. See docs/AUTOMATION.md for the Zap setup.
//
// Accepts, in order of preference:
//   1. multipart/form-data with the PDF as a file part
//   2. JSON { "file_url": "https://...", "file_name": "report.pdf" }
//   3. JSON { "file_base64": "...", "file_name": "report.pdf" }
//   4. JSON { "text": "..." } (already-extracted text)
//
// Auth: `Authorization: Bearer <TAXDOME_WEBHOOK_SECRET>`.

const MAX_FILE_BYTES = 20 * 1024 * 1024;
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

export const POST: APIRoute = async ({ request }) => {
  const secret = import.meta.env.TAXDOME_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);

  const auth = request.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);

  let fileName: string | null = null;
  let pdf: Buffer | null = null;
  let text: string | null = null;

  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      for (const value of form.values()) {
        if (value instanceof File) {
          if (value.size > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
          fileName = value.name;
          pdf = Buffer.from(await value.arrayBuffer());
          break;
        }
      }
    } else {
      const body = (await request.json()) as {
        file_url?: string;
        file_base64?: string;
        file_name?: string;
        text?: string;
      };
      fileName = body.file_name ?? null;
      if (body.text) text = body.text;
      else if (body.file_base64) pdf = Buffer.from(body.file_base64, 'base64');
      else if (body.file_url) {
        // Only fetch over https, and never more than we'd accept as an upload
        if (!/^https:\/\//i.test(body.file_url)) return json({ error: 'file_url must be https' }, 400);
        const res = await fetch(body.file_url, { redirect: 'follow' });
        if (!res.ok) return json({ error: `Could not download file (${res.status})` }, 400);
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
        pdf = Buffer.from(bytes);
      }
      if (pdf && pdf.length > MAX_FILE_BYTES) return json({ error: 'File is too large (20 MB max)' }, 413);
    }
  } catch {
    return json({ error: 'Could not read request body' }, 400);
  }

  if (!pdf && !text) return json({ error: 'No report attached' }, 400);

  const service = createServiceClient();

  return streamJSON(async () => {
    const { data: metricRows } = await service
      .from('scorecard_metrics')
      .select('id, title, goal, unit, frequency, description')
      .eq('active', true)
      .order('sort_order');
    const metrics = (metricRows ?? []) as Pick<
      ScorecardMetric,
      'id' | 'title' | 'goal' | 'unit' | 'frequency' | 'description'
    >[];

    // Records the failure so it shows on the Scorecard page, then throws
    const fail = async (message: string): Promise<never> => {
      await service.from('taxdome_imports').insert({
        file_name: fileName,
        raw_text: text,
        status: 'failed',
        error: message,
      });
      throw new Error(message);
    };

    if (!metrics.length) await fail('No active scorecard metrics — add metrics in the Scorecard page first');

    if (!text && pdf) {
      try {
        text = await pdfToText(pdf);
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

    const { data: importRow, error: importError } = await service
      .from('taxdome_imports')
      .insert({
        file_name: fileName,
        report_title: extracted.report_title,
        period_start: periodStart,
        period_end: periodDate,
        raw_text: text,
        extracted,
        status: 'processed',
        entries_written: extracted.values.length,
      })
      .select('id')
      .single();
    if (importError) return fail(`Saving import failed: ${importError.message}`);

    if (extracted.values.length) {
      const { error } = await service.from('scorecard_entries').upsert(
        extracted.values.map((v) => ({
          metric_id: v.metric_id,
          period_date: periodDate,
          value: v.value,
          on_track: v.on_track,
          notes: v.notes,
          source: 'taxdome',
          import_id: importRow.id,
        })),
        { onConflict: 'metric_id,period_date' }
      );
      if (error) {
        await service
          .from('taxdome_imports')
          .update({ status: 'failed', error: `Saving entries failed: ${error.message}`, entries_written: 0 })
          .eq('id', importRow.id);
        throw new Error(`Saving entries failed: ${error.message}`);
      }
    }

    return {
      ok: true,
      import_id: importRow.id,
      period_date: periodDate,
      entries_written: extracted.values.length,
      unmatched: extracted.unmatched,
    };
  });
};
