// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally —
// every relative import here carries its .ts extension.
//
// The fulfillment CSV fallback's pure half (implementation plan, section J
// step 8): parse TaxDome's emailed R1 "Fulfillment Snapshot" export and
// resolve its rows against the reference tables the API sync maintains. No
// I/O and no DB — everything here is a function of its inputs, so every
// branch is testable without Postgres:
//   node --test tests/fulfillment-csv.test.mjs
// The DB wrapper (import_runs bookkeeping, lookups, inserts, the diff call)
// lives in src/lib/fulfillment-csv-import.ts.

import { firmDate, reportProducedAt } from './taxdome-date.ts';

/** Thrown when an R1 export doesn't parse; the message is safe to show a Zap. */
export class CsvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvValidationError';
  }
}

// ── Generic CSV parsing ────────────────────────────────────────────────────

/**
 * A small deterministic RFC 4180 parser (no dependency): BOM stripped, CRLF
 * and LF line endings, quoted fields with embedded commas, doubled quotes and
 * newlines. A single trailing empty line (the newline after the last row) is
 * ignored; blank lines in the middle parse as single-empty-cell rows.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false; // currently inside quotes
  let wasQuoted = false; // this field started with a quote

  const endField = (): void => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      continue;
    }
    if (c === ',') {
      endField();
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    field += c;
  }
  // The last row only exists when the text didn't end on a line break
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Splits the text collectReportFiles produces (files joined as
 * "=== File: name ===\n<text>") back into its entries. Text with no marker —
 * a plain CSV — comes back as one unnamed entry.
 */
export function splitCollectedText(joined: string): { name: string; text: string }[] {
  const lines = joined.split('\n');
  const entries: { name: string; text: string }[] = [];
  const leading: string[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const marker = /^=== File: (.+) ===\r?$/.exec(line);
    if (marker) {
      if (current) entries.push({ name: current.name, text: current.lines.join('\n').trim() });
      current = { name: marker[1], lines: [] };
    } else if (current) current.lines.push(line);
    else leading.push(line);
  }
  if (current) entries.push({ name: current.name, text: current.lines.join('\n').trim() });
  const head = leading.join('\n');
  if (head.trim()) entries.unshift({ name: '', text: head.trim() });
  return entries;
}

/** Index of the first row whose trimmed cells include exactly 'Job Id'; -1 when none. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((cell) => cell.trim() === 'Job Id')) return i;
  }
  return -1;
}

// ── The R1 export (plan section F) ─────────────────────────────────────────

/** The columns every R1 export must carry (matched by name, never position). */
const REQUIRED_COLUMNS = [
  'Job Id',
  'Job Name',
  'Account Name',
  'Pipeline',
  'Pipeline Stage',
  'Pipeline Stage Order',
  'Job Assignee',
  'Job Days In Current Stage',
] as const;

/** One parsed R1 data row; dates normalized to YYYY-MM-DD, null when absent. */
export interface R1Row {
  job_id: number;
  job_name: string;
  account_name: string;
  account_tag: string | null;
  pipeline: string;
  pipeline_stage: string;
  pipeline_stage_order: number | null;
  job_assignee: string | null;
  job_priority: string | null;
  intake_date: string | null;
  start_date: string | null;
  due_date: string | null;
  internal_deadline: string | null;
  days_in_stage: number;
}

export interface R1Parse {
  /** Row index of the header line (found by scanning, never a fixed offset). */
  headerIndex: number;
  /** The header's trimmed column names, 'Job Is Archived' dropped. */
  columns: string[];
  rows: R1Row[];
  /** The lines above the header, for the snapshot-date fallback. */
  preamble: string;
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const MDY_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** YYYY-MM-DD, or null when the parts don't form a real date (never throws). */
function ymd(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** ISO (YYYY-MM-DD) first, else M/D/YYYY, else null — never throws on a date. */
function parseR1Date(cellText: string): string | null {
  const s = cellText.trim();
  if (!s) return null;
  let m = ISO_DATE.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = MDY_DATE.exec(s);
  if (m) return ymd(Number(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

const textOrNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());
// Numbers in the export may carry thousands separators ("1,234")
const numeric = (s: string): string => s.replace(/,/g, '').trim();

/**
 * Parses one R1 export. Columns are matched by name; the header row is found
 * by scanning for a line whose cells include exactly "Job Id" (the preamble
 * above it is variable length). Rows with every cell blank are skipped.
 * Throws CsvValidationError naming the problem when there is no header row, a
 * required column is missing, there are no data rows, a Job Id is not a
 * number or repeats, or Job Days In Current Stage is not numeric.
 */
export function parseR1(text: string): R1Parse {
  const cells = parseCsv(text);
  const headerIndex = findHeaderRow(cells);
  if (headerIndex < 0) throw new CsvValidationError('No header row found: no line contains a "Job Id" column');

  const header = cells[headerIndex].map((cell) => cell.trim());
  const columns = header.filter((name) => name !== 'Job Is Archived');
  const at = new Map<string, number>();
  header.forEach((name, i) => {
    if (!at.has(name)) at.set(name, i);
  });
  const missing = REQUIRED_COLUMNS.filter((name) => !at.has(name));
  if (missing.length) throw new CsvValidationError(`Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);

  const cell = (row: string[], name: string): string => {
    const i = at.get(name);
    return i == null || i >= row.length ? '' : (row[i] ?? '');
  };

  const rows: R1Row[] = [];
  const seen = new Set<number>();
  for (let r = headerIndex + 1; r < cells.length; r++) {
    const row = cells[r];
    if (row.every((c) => c.trim() === '')) continue;

    const jobId = Number(numeric(cell(row, 'Job Id')));
    if (!Number.isInteger(jobId)) {
      throw new CsvValidationError(`Invalid Job Id "${cell(row, 'Job Id').trim()}" in data row ${r + 1}`);
    }
    if (seen.has(jobId)) throw new CsvValidationError(`Duplicate Job Id ${jobId}`);
    seen.add(jobId);

    const days = Number(numeric(cell(row, 'Job Days In Current Stage')));
    if (!Number.isFinite(days)) {
      throw new CsvValidationError(`Invalid Job Days In Current Stage "${cell(row, 'Job Days In Current Stage').trim()}" for Job Id ${jobId}`);
    }
    const order = Number(numeric(cell(row, 'Pipeline Stage Order')));

    rows.push({
      job_id: jobId,
      job_name: cell(row, 'Job Name').trim(),
      account_name: cell(row, 'Account Name').trim(),
      account_tag: textOrNull(cell(row, 'Account Tag')),
      pipeline: cell(row, 'Pipeline').trim(),
      pipeline_stage: cell(row, 'Pipeline Stage').trim(),
      pipeline_stage_order: Number.isInteger(order) ? order : null,
      job_assignee: textOrNull(cell(row, 'Job Assignee')),
      job_priority: textOrNull(cell(row, 'Job Priority')),
      intake_date: parseR1Date(cell(row, 'Job Intake Date')),
      start_date: parseR1Date(cell(row, 'Job Start Date')),
      due_date: parseR1Date(cell(row, 'Job Due Date')),
      internal_deadline: parseR1Date(cell(row, 'Job Internal Deadline')),
      days_in_stage: Math.trunc(days),
    });
  }
  if (!rows.length) throw new CsvValidationError('The export contains no data rows');

  const preamble = cells.slice(0, headerIndex).map((row) => row.join(',')).join('\n');
  return { headerIndex, columns, rows, preamble };
}

// ── The snapshot date ──────────────────────────────────────────────────────

// "... (YYYY-MM-DD HH_mm_ss).csv" / ".zip" — the stamp is UTC (TaxDome's
// export naming), so it is converted to the Chicago date with firmDate.
const FILE_STAMP = /\((\d{4})-(\d{2})-(\d{2}) (\d{2})_(\d{2})_(\d{2})\)\.(?:csv|zip)$/i;

/** The Chicago date the file name's "(YYYY-MM-DD HH_mm_ss)" stamp falls on; null without the pattern. */
export function snapshotDateFromFileName(name: string): string | null {
  const m = FILE_STAMP.exec(name.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const stamp = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (stamp.getUTCFullYear() !== y || stamp.getUTCMonth() !== mo - 1 || stamp.getUTCDate() !== d) return null;
  return firmDate(stamp);
}

/** The Chicago date of the preamble's "Data extract produced by … on …" line; null without one. */
export function snapshotDateFromPreamble(text: string): string | null {
  const producedAt = reportProducedAt(text);
  return producedAt ? firmDate(producedAt) : null;
}

/** Chicago's hour/minute/date at an instant, from Intl (no date library). */
function chicagoClock(at: Date): { y: number; mo: number; d: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: num('year'), mo: num('month'), d: num('day'), hour: num('hour') % 24, minute: num('minute') };
}

/**
 * The UTC instant of 00:00 America/Chicago on a YYYY-MM-DD date: start from
 * Date.UTC(y, m-1, d, 6) (06:00 UTC is midnight CST) and step back by the
 * hour Intl reports until the local clock reads midnight on that date (CDT
 * needs one hour less; DST transitions never touch midnight).
 */
export function chicagoMidnightIso(dateYmd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) throw new Error(`chicagoMidnightIso: expected a YYYY-MM-DD date, got "${dateYmd}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let at = new Date(Date.UTC(y, mo - 1, d, 6));
  for (let step = 0; step < 3; step++) {
    const local = chicagoClock(at);
    if (local.y === y && local.mo === mo && local.d === d && local.hour === 0 && local.minute === 0) return at.toISOString();
    at = new Date(at.getTime() - local.hour * 3_600_000);
  }
  return at.toISOString();
}

/** Midnight Chicago of the snapshot date minus whole days — the CSV's stand-in for the API's moved_at. */
export function movedAtFromDays(snapshotDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(snapshotDate.trim());
  if (!m) throw new Error(`movedAtFromDays: expected a YYYY-MM-DD date, got "${snapshotDate}"`);
  const earlier = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - Math.trunc(days)));
  return chicagoMidnightIso(
    `${earlier.getUTCFullYear()}-${String(earlier.getUTCMonth() + 1).padStart(2, '0')}-${String(earlier.getUTCDate()).padStart(2, '0')}`
  );
}

// ── Resolving rows against the reference tables ────────────────────────────

/** The reference tables the API sync maintains, as name-keyed lookups. */
export interface Lookups {
  /** pipeline title -> td_pipelines.id */
  pipelines: Map<string, number>;
  /** `${pipelineId}\u0000${stage title}` -> td_pipeline_stages.id */
  stages: Map<string, number>;
  /** pipeline id -> the pipeline's 'active' td_job_statuses id (lowest id) */
  activeStatus: Map<number, number>;
  /** person display name -> td_people row */
  people: Map<string, { actor_type: string; id: number }>;
  /** lowercased account name -> td_clients.id */
  clients: Map<string, number>;
}

/** A job_snapshots row as the CSV insert sends it (same 22 columns as the API upsert). */
export interface SnapshotInsert {
  snapshot_date: string;
  job_id: number;
  job_name: string | null;
  pipeline_id: number;
  stage_id: number;
  status_id: number | null;
  moved_at: string;
  status_changed_at: null;
  intake_date: string | null;
  start_date: string | null;
  due_date: string | null;
  internal_deadline: string | null;
  completed_at: null;
  time_budget: null;
  time_tracked: null;
  priority: string | null;
  assignee_ids: number[];
  assignee_actors: string[];
  client_id: number;
  source: 'csv';
  import_run_id: number;
  captured_at: Date;
}

export interface ResolveResult {
  rows: SnapshotInsert[];
  /** "Pipeline / Stage" of rows not written (unknown pipeline or stage), deduplicated. */
  unknown_stages: string[];
  /** Account names with no td_clients row, deduplicated (client_id is not nullable and the CSV lacks TaxDome ids). */
  unknown_clients: string[];
  /** Assignee names with no td_people row, deduplicated. */
  unmatched_assignees: string[];
}

/**
 * R1 rows to job_snapshots values. Exact-name lookups after trim (pipeline
 * names keep their double spaces); rows whose pipeline or stage is unknown,
 * or whose account name has no client row, are not written and are listed
 * instead. Job Assignee splits on ',' or ';'; unmatched names are listed and
 * the job keeps the matched ones. priority is lowercased, status_id is the
 * pipeline's active status, moved_at is movedAtFromDays(snapshot, days).
 */
export function resolveRows(
  rows: R1Row[],
  lookups: Lookups,
  snapshotDate: string,
  runId: number,
  capturedAt: Date
): ResolveResult {
  const inserted: SnapshotInsert[] = [];
  const unknownStages = new Set<string>();
  const unknownClients = new Set<string>();
  const unmatchedAssignees = new Set<string>();

  for (const row of rows) {
    const pipeline = row.pipeline.trim();
    const stage = row.pipeline_stage.trim();
    const pipelineId = lookups.pipelines.get(pipeline);
    const stageId = pipelineId != null ? lookups.stages.get(`${pipelineId}\u0000${stage}`) : undefined;
    const clientId = lookups.clients.get(row.account_name.trim().toLowerCase());
    if (pipelineId == null || stageId == null) unknownStages.add(`${pipeline} / ${stage}`);
    if (clientId == null) unknownClients.add(row.account_name.trim());
    if (pipelineId == null || stageId == null || clientId == null) continue;

    // "Jane Example, John Sample" (or semicolon-separated) -> one actor each
    const assigneeIds: number[] = [];
    const assigneeActors: string[] = [];
    for (const name of (row.job_assignee ?? '').split(/[,;]/)) {
      const person = lookups.people.get(name.trim());
      if (!person) {
        if (name.trim()) unmatchedAssignees.add(name.trim());
        continue;
      }
      assigneeIds.push(person.id);
      assigneeActors.push(`${person.actor_type}:${person.id}`);
    }

    inserted.push({
      snapshot_date: snapshotDate,
      job_id: row.job_id,
      job_name: row.job_name,
      pipeline_id: pipelineId,
      stage_id: stageId,
      status_id: lookups.activeStatus.get(pipelineId) ?? null,
      moved_at: movedAtFromDays(snapshotDate, row.days_in_stage),
      status_changed_at: null,
      intake_date: row.intake_date,
      start_date: row.start_date,
      due_date: row.due_date,
      internal_deadline: row.internal_deadline,
      completed_at: null,
      time_budget: null,
      time_tracked: null,
      priority: row.job_priority != null ? row.job_priority.toLowerCase() : null,
      assignee_ids: assigneeIds,
      assignee_actors: assigneeActors,
      client_id: clientId,
      source: 'csv',
      import_run_id: runId,
      captured_at: capturedAt,
    });
  }

  return { rows: inserted, unknown_stages: [...unknownStages], unknown_clients: [...unknownClients], unmatched_assignees: [...unmatchedAssignees] };
}

// ── The insert ─────────────────────────────────────────────────────────────

const SNAPSHOT_COLUMNS = [
  'snapshot_date', 'job_id', 'job_name', 'pipeline_id', 'stage_id', 'status_id',
  'moved_at', 'status_changed_at', 'intake_date', 'start_date', 'due_date',
  'internal_deadline', 'completed_at', 'time_budget', 'time_tracked', 'priority',
  'assignee_ids', 'assignee_actors', 'client_id', 'source', 'import_run_id', 'captured_at',
] as const satisfies readonly (keyof SnapshotInsert)[];

// Casts for the params Postgres can't infer: arrays and the source enum.
const SNAPSHOT_CASTS: Record<string, string> = {
  assignee_ids: '::bigint[]',
  assignee_actors: '::text[]',
  source: '::fulfillment_source',
};

/**
 * One multi-row insert for job_snapshots with $n placeholders (row-major),
 * same 22 columns as the API upsert, ending with "on conflict … do nothing
 * returning job_id": a CSV run never overwrites what an API run already wrote
 * that day, and the caller counts the rows actually inserted. The rows must
 * be non-empty; callers send batches.
 */
export function buildCsvInsert(rows: SnapshotInsert[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map(
    (row) =>
      `(${SNAPSHOT_COLUMNS.map((col) => {
        params.push(row[col]);
        return `$${params.length}${SNAPSHOT_CASTS[col] ?? ''}`;
      }).join(', ')})`
  );
  const text = `
    insert into job_snapshots (${SNAPSHOT_COLUMNS.join(', ')})
    values ${values.join(', ')}
    on conflict (snapshot_date, job_id) do nothing
    returning job_id`;
  return { text, params };
}
