// .ts extension: the signing helpers here are imported directly by tests
// under node --test (type stripping), which resolves relative imports
// literally — every relative import carries its .ts extension, and db.ts
// (whose './env' import node cannot resolve) is only imported inside the
// functions the tests never call.
//
// The fulfillment CSV fallback's DB half (implementation plan, section J step
// 8): runFulfillmentCsvImport turns the collected text of an R1 "Fulfillment
// Snapshot" export into job_snapshots rows (one import_runs row per import,
// plan section F) and hands off to the diff engine, exactly like the API
// poller does. The parsing and resolving live, pure, in
// src/lib/fulfillment-csv.ts.
//
// The ?async=1 hand-off (webhook -> Netlify background function) mirrors
// src/lib/taxdome-import.ts and src/lib/taxdome-job.ts: the export is parked
// in Netlify Blobs under a random job id, and the background function is
// called with { job_id, file_name } signed with a key derived from
// SESSION_SECRET (label 'flammard:fulfillment-import', so no other job's
// signature is valid here).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fulfillmentJobs } from './blobs.ts';
import { env } from './env.ts';
import {
  buildCsvInsert,
  CsvValidationError,
  findHeaderRow,
  parseCsv,
  parseR1,
  resolveRows,
  snapshotDateFromFileName,
  snapshotDateFromPreamble,
  splitCollectedText,
  type Lookups,
} from './fulfillment-csv.ts';
import { runFulfillmentDiff } from './fulfillment-diff.ts';
import { runFulfillmentRules } from './fulfillment-rules.ts';
import { stripNul } from './taxdome-files.ts';
import { isJobId } from './taxdome-job.ts';

const BATCH = 200;

export interface CsvImportResult {
  ok: true;
  run_id: number;
  snapshot_date: string;
  rows_in_file: number;
  jobs_written: number;
  unknown_stages: string[];
  unknown_clients: string[];
}

/**
 * Imports one collected R1 export: a 'running' import_runs row, the pure
 * parse/resolve, the snapshot insert (never overwriting an existing day's
 * row), the diff pass and the run's own outcome. On any failure — including
 * CsvValidationError — the run is set to 'error' with the message and the
 * error is rethrown; the caller only logs.
 */
export async function runFulfillmentCsvImport({ fileName, text }: { fileName: string | null; text: string }): Promise<CsvImportResult> {
  const { many, one, sql } = await import('./db.ts');
  const db = sql();

  const run = await one<{ id: number }>(
    db`insert into import_runs (source, status, started_at) values ('csv', 'running', now()) returning id`
  );
  if (!run) throw new Error('Could not create the import run');
  const runId = run.id;

  try {
    // collectReportFiles may have joined several files; the R1 export is the
    // one with the Job Id header, the rest are listed and ignored.
    const entries = splitCollectedText(text);
    let entry: { name: string; text: string } | null = null;
    const ignoredFiles: string[] = [];
    for (const candidate of entries) {
      if (!entry && findHeaderRow(parseCsv(candidate.text)) >= 0) entry = candidate;
      else ignoredFiles.push(candidate.name);
    }
    if (!entry) {
      throw new CsvValidationError(
        `No R1 export found: none of the ${entries.length} file${entries.length === 1 ? '' : 's'} contains a "Job Id" header`
      );
    }

    const snapshotDate =
      snapshotDateFromFileName(entry.name) ??
      snapshotDateFromFileName(fileName ?? '') ??
      snapshotDateFromPreamble(entry.text);
    if (!snapshotDate) {
      throw new CsvValidationError(
        'Could not determine the snapshot date: the file names have no "(YYYY-MM-DD HH_mm_ss)" stamp and the text has no "Data extract produced by … on …" line'
      );
    }

    const parsed = parseR1(entry.text);

    // The lookups: the reference tables the API sync (the poller) maintains
    const pipelineRows = await many<{ id: number; title: string }>(db`select id, title from td_pipelines`);
    const stageRows = await many<{ id: number; pipeline_id: number; title: string }>(
      db`select id, pipeline_id, title from td_pipeline_stages`
    );
    const statusRows = await many<{ id: number; pipeline_id: number }>(
      db`select id, pipeline_id from td_job_statuses where kind = 'active' order by id`
    );
    const peopleRows = await many<{ actor_type: string; id: number; display_name: string | null }>(
      db`select actor_type, id, display_name from td_people where display_name is not null`
    );
    const clientRows = await many<{ id: number; account_name: string | null }>(
      db`select id, account_name from td_clients where account_name is not null`
    );
    const lookups: Lookups = {
      pipelines: new Map(pipelineRows.map((p) => [p.title, p.id])),
      stages: new Map(stageRows.map((s) => [`${s.pipeline_id}\u0000${s.title}`, s.id])),
      activeStatus: new Map(),
      people: new Map(),
      clients: new Map(),
    };
    for (const s of statusRows) if (!lookups.activeStatus.has(s.pipeline_id)) lookups.activeStatus.set(s.pipeline_id, s.id);
    for (const p of peopleRows) {
      const name = (p.display_name ?? '').trim();
      if (name && !lookups.people.has(name)) lookups.people.set(name, { actor_type: p.actor_type, id: p.id });
    }
    for (const c of clientRows) {
      const key = (c.account_name ?? '').trim().toLowerCase();
      if (key && !lookups.clients.has(key)) lookups.clients.set(key, c.id);
    }

    const capturedAt = new Date();
    const resolved = resolveRows(parsed.rows, lookups, snapshotDate, runId, capturedAt);

    // on conflict do nothing returning job_id: only the rows this run actually
    // inserted come back, so an API run earlier in the day is never counted
    // (or overwritten) by the CSV fallback
    const insertedIds: number[] = [];
    for (let i = 0; i < resolved.rows.length; i += BATCH) {
      const { text: insertText, params } = buildCsvInsert(resolved.rows.slice(i, i + BATCH));
      for (const row of await many<{ job_id: number }>(db.query(insertText, params))) insertedIds.push(row.job_id);
    }
    const jobsWritten = insertedIds.length;

    // The CSV never overwrites, so the diff's own "latest earlier snapshot"
    // query is right (the poller passes previous explicitly instead; see
    // src/lib/fulfillment-diff.ts).
    const diffCounts = await runFulfillmentDiff(runId);

    const detail = {
      file: entry.name,
      rows_in_file: parsed.rows.length,
      rows_resolved: resolved.rows.length,
      inserted: jobsWritten,
      skipped_conflict: resolved.rows.length - jobsWritten,
      unknown_stages: resolved.unknown_stages,
      unknown_clients: resolved.unknown_clients,
      unmatched_assignees: resolved.unmatched_assignees,
      ignored_files: ignoredFiles,
    };
    await db`
      update import_runs set
        status = 'ok', finished_at = now(), snapshot_date = ${snapshotDate},
        jobs_written = ${jobsWritten},
        jobs_new = ${diffCounts.new}, jobs_moved = ${diffCounts.moved},
        jobs_moved_back = ${diffCounts.moved_back}, jobs_completed = ${diffCounts.completed},
        jobs_archived = ${diffCounts.archived}, jobs_reopened = ${diffCounts.reopened},
        detail = ${JSON.stringify(detail)}::jsonb
      where id = ${runId}`;
    // Step 9 (the rules runner): guarded so a rules failure never fails the import
    try {
      await runFulfillmentRules({ mode: 'after-import', runId });
    } catch (err) {
      console.log('[fulfillment-rules] after-import run failed: ' + (err instanceof Error ? err.message : err));
    }

    return {
      ok: true,
      run_id: runId,
      snapshot_date: snapshotDate,
      rows_in_file: parsed.rows.length,
      jobs_written: jobsWritten,
      unknown_stages: resolved.unknown_stages,
      unknown_clients: resolved.unknown_clients,
    };
  } catch (err) {
    const message = stripNul(err instanceof Error ? err.message : String(err));
    try {
      await db`update import_runs set status = 'error', finished_at = now(), error = ${message} where id = ${runId}`;
    } catch (logErr) {
      console.log('[fulfillment-csv] could not record the failed run', logErr instanceof Error ? logErr.message : logErr);
    }
    throw err;
  }
}

/**
 * Writes a 'error' row to the import log so a failed hand-off shows in the
 * Fulfillment imports view. Never throws: the function log is all that's left.
 */
export async function logFulfillmentCsvFailure(fileName: string | null, message: string): Promise<void> {
  try {
    const { sql } = await import('./db.ts');
    await sql()`
      insert into import_runs (source, status, started_at, finished_at, error, detail)
      values ('csv', 'error', now(), now(), ${stripNul(message)}, ${JSON.stringify({ file: stripNul(fileName) })}::jsonb)`;
  } catch (err) {
    console.log('[fulfillment-csv] could not log the failed import', err instanceof Error ? err.message : err);
  }
}

// ── Background job hand-off (?async=1) ────────────────────────────────────

export const CSV_JOB_HEADER = 'x-flammard-job';

const BACKGROUND_PATH = '/.netlify/functions/fulfillment-import-background';

/** The request body sent to the background function. */
export interface CsvJobRequest {
  job_id: string;
  file_name: string | null;
}

/** What is stored in the blob under the job id. */
export interface CsvJobMeta {
  fileName: string | null;
  text: string;
}

/** Blob key for one job: the JSON meta (the export's collected text). */
export const csvJobKeys = (jobId: string) => ({ meta: `${jobId}/meta` });

function jobKey(sessionSecret: string | undefined): string {
  if (!sessionSecret) throw new Error('SESSION_SECRET is not configured');
  return createHmac('sha256', sessionSecret).update('flammard:fulfillment-import').digest('hex');
}

const canonical = (r: CsvJobRequest) => `${r.job_id}\n${r.file_name ?? ''}`;

export function signFulfillmentCsvJob(sessionSecret: string | undefined, req: CsvJobRequest): string {
  return createHmac('sha256', jobKey(sessionSecret)).update(canonical(req)).digest('hex');
}

export function verifyFulfillmentCsvJob(
  sessionSecret: string | undefined,
  req: CsvJobRequest,
  signature: string | null | undefined
): boolean {
  if (!signature || !sessionSecret) return false;
  const expected = Buffer.from(signFulfillmentCsvJob(sessionSecret, req));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parses the background function's body; null when it isn't a well-formed job request. */
export function parseCsvJobRequest(raw: string): CsvJobRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { job_id, file_name } = body as Record<string, unknown>;
  if (!isJobId(job_id)) return null;
  if (file_name != null && typeof file_name !== 'string') return null;
  return { job_id, file_name: (file_name as string | null | undefined) ?? null };
}

/** Validates the stored meta blob; null when it is missing or malformed. */
export function parseCsvJobMeta(value: unknown): CsvJobMeta | null {
  if (!value || typeof value !== 'object') return null;
  const { fileName, text } = value as Record<string, unknown>;
  if (fileName != null && typeof fileName !== 'string') return null;
  if (typeof text !== 'string' || !text) return null;
  return { fileName: (fileName as string | null | undefined) ?? null, text };
}

/**
 * Stores the export and calls the background function. Resolves with an error
 * message (and removes the stored export) when the job could not be started;
 * the caller logs that as a failed import.
 */
export async function startFulfillmentCsvJob(
  origin: string,
  job: { fileName: string | null; text: string }
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  const jobId = randomUUID();
  const request: CsvJobRequest = { job_id: jobId, file_name: job.fileName };

  let signature: string;
  try {
    signature = signFulfillmentCsvJob(env('SESSION_SECRET'), request);
  } catch (err) {
    return { ok: false, error: `Could not start the background import: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const store = fulfillmentJobs();
    const meta: CsvJobMeta = { fileName: job.fileName, text: job.text };
    await store.setJSON(csvJobKeys(jobId).meta, meta);
  } catch (err) {
    await deleteFulfillmentCsvJob(jobId);
    return { ok: false, error: `Could not store the export for the background import: ${err instanceof Error ? err.message : 'unknown'}` };
  }

  try {
    const res = await fetch(new URL(BACKGROUND_PATH, origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSV_JOB_HEADER]: signature },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202 || res.ok) return { ok: true, jobId };
    await deleteFulfillmentCsvJob(jobId);
    return { ok: false, error: `Could not start the background import: background function answered HTTP ${res.status}` };
  } catch (err) {
    await deleteFulfillmentCsvJob(jobId);
    return { ok: false, error: `Could not start the background import: ${err instanceof Error ? err.message : 'unreachable'}` };
  }
}

/** Loads a stored export; null when it is missing or malformed. */
export async function loadFulfillmentCsvJob(jobId: string): Promise<CsvJobMeta | null> {
  const store = fulfillmentJobs();
  const meta = parseCsvJobMeta(await store.get(csvJobKeys(jobId).meta, { type: 'json' }));
  return meta;
}

/** Removes a job's stored export. Never throws. */
export async function deleteFulfillmentCsvJob(jobId: string): Promise<void> {
  try {
    const store = fulfillmentJobs();
    await store.delete(csvJobKeys(jobId).meta);
  } catch (err) {
    console.log('[fulfillment-csv] could not delete the job blob', jobId, err instanceof Error ? err.message : err);
  }
}
