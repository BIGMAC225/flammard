// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally —
// every relative import here carries its .ts extension, and db.ts (whose
// './env' import node cannot resolve) is only imported inside
// runFulfillmentPoll, which the tests never call.
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { loadLatestSnapshots, runFulfillmentDiff } from './fulfillment-diff.ts';
import { runFulfillmentRules } from './fulfillment-rules.ts';
import { firmDate } from './taxdome-date.ts';
import { JOB_FIELDS, tdApiFromEnv, type TdApi } from './td-api.ts';

// The fulfillment poller's sync logic (implementation plan, section J step 6):
// one TaxDome API walk that refreshes the reference tables (pipelines, stages,
// job statuses, people, clients), upserts today's job snapshots and records
// its own outcome in import_runs. The mapping helpers are pure (no I/O) so
// they can be tested directly:
//   node --test tests/fulfillment-poll.test.mjs

const BATCH = 200;

type Db = NeonQueryFunction<false, false>;

/** One TaxDome job record (JOB_FIELDS); dates stay the API's ISO strings. */
export interface TdJob {
  id: number;
  client_id: number;
  name: string | null;
  pipeline_stage_id: number;
  pipeline_job_status_id: number | null;
  moved_at: string;
  status_changed_at: string | null;
  intake_date: string | null;
  start_date: string | null;
  due_date: string | null;
  internal_deadline: string | null;
  completed_at: string | null;
  time_budget: number | null;
  time_tracked: number | null;
  priority: string | null;
}

/** One /job_assignments row (fields: id, job_id, actor_type, actor_id). */
export interface TdAssignment {
  id: number;
  job_id: number | null;
  actor_type: string | null;
  actor_id: number | null;
}

/** One /owner or /employees record; "type" is the actor_type key. */
export interface TdPerson {
  id: number;
  type: string;
  user_id?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  role?: string | null;
}

/** One /clients record, as the byIds fetch asks for it. */
export interface TdClient {
  id: number;
  account_name?: string | null;
  company_name?: string | null;
  account_type?: string | null;
  code?: string | null;
  lead?: boolean | null;
  archived_at?: string | null;
  tag_ids?: number[] | null;
}

// ── Pure mapping helpers ──────────────────────────────────────────────────

/** Trimmed "First Last", empty parts dropped. */
export function displayName(first: string | null, last: string | null): string {
  return [first?.trim(), last?.trim()].filter((part): part is string => !!part).join(' ');
}

/**
 * Assignment rows per job: ids sorted ascending and deduplicated, actors as
 * 'Employee:12' / 'Owner:3' in the same order. Rows with a null job_id or
 * actor_id are skipped.
 */
export function groupAssignments(
  rows: Array<Pick<TdAssignment, 'job_id' | 'actor_type' | 'actor_id'>>
): Map<number, { ids: number[]; actors: string[] }> {
  const byJob = new Map<number, Map<number, string>>();
  for (const { job_id, actor_type, actor_id } of rows) {
    if (job_id == null || actor_id == null || !actor_type) continue;
    let actors = byJob.get(job_id);
    if (!actors) byJob.set(job_id, (actors = new Map()));
    if (!actors.has(actor_id)) actors.set(actor_id, `${actor_type}:${actor_id}`);
  }
  const grouped = new Map<number, { ids: number[]; actors: string[] }>();
  for (const [jobId, actors] of byJob) {
    const ids = [...actors.keys()].sort((a, b) => a - b);
    grouped.set(jobId, { ids, actors: ids.map((id) => actors.get(id)!) });
  }
  return grouped;
}

/** What mapJobSnapshot needs to know about the walk it belongs to. */
export interface PollContext {
  stages: Map<number, { pipeline_id: number }>;
  statuses: Set<number>;
  assignments: Map<number, { ids: number[]; actors: string[] }>;
  snapshotDate: string;
  capturedAt: Date;
  runId: number;
}

/** A job_snapshots row as the upsert sends it (dates stay strings; Postgres casts). */
export interface JobSnapshotRow {
  snapshot_date: string;
  job_id: number;
  job_name: string | null;
  pipeline_id: number;
  stage_id: number;
  status_id: number | null;
  moved_at: string;
  status_changed_at: string | null;
  intake_date: string | null;
  start_date: string | null;
  due_date: string | null;
  internal_deadline: string | null;
  completed_at: string | null;
  time_budget: number | null;
  time_tracked: number | null;
  priority: string | null;
  assignee_ids: number[];
  assignee_actors: string[];
  client_id: number;
  source: 'api' | 'csv';
  import_run_id: number;
  captured_at: Date;
}

/** Either the row, or why the job was skipped (unknown stage id). */
export type MappedSnapshot = JobSnapshotRow | { skipped: 'unknown_stage'; stage_id: number };

/**
 * One job to its job_snapshots row: pipeline_id comes from the stage, status_id
 * is null when the status id is unknown, priority and name pass through
 * (null allowed), dates pass through as strings. Jobs whose stage id is not in
 * ctx.stages come back as { skipped: 'unknown_stage', stage_id }.
 */
export function mapJobSnapshot(job: TdJob, ctx: PollContext): MappedSnapshot {
  const stage = ctx.stages.get(job.pipeline_stage_id);
  if (!stage) return { skipped: 'unknown_stage', stage_id: job.pipeline_stage_id };
  const assignment = ctx.assignments.get(job.id) ?? { ids: [], actors: [] };
  const statusId = job.pipeline_job_status_id;
  return {
    snapshot_date: ctx.snapshotDate,
    job_id: job.id,
    job_name: job.name,
    pipeline_id: stage.pipeline_id,
    stage_id: job.pipeline_stage_id,
    status_id: statusId != null && ctx.statuses.has(statusId) ? statusId : null,
    moved_at: job.moved_at,
    status_changed_at: job.status_changed_at,
    intake_date: job.intake_date,
    start_date: job.start_date,
    due_date: job.due_date,
    internal_deadline: job.internal_deadline,
    completed_at: job.completed_at,
    time_budget: job.time_budget,
    time_tracked: job.time_tracked,
    priority: job.priority,
    assignee_ids: assignment.ids,
    assignee_actors: assignment.actors,
    client_id: job.client_id,
    source: 'api',
    import_run_id: ctx.runId,
    captured_at: ctx.capturedAt,
  };
}

const SNAPSHOT_COLUMNS = [
  'snapshot_date', 'job_id', 'job_name', 'pipeline_id', 'stage_id', 'status_id',
  'moved_at', 'status_changed_at', 'intake_date', 'start_date', 'due_date',
  'internal_deadline', 'completed_at', 'time_budget', 'time_tracked', 'priority',
  'assignee_ids', 'assignee_actors', 'client_id', 'source', 'import_run_id', 'captured_at',
] as const satisfies readonly (keyof JobSnapshotRow)[];

// Casts for the params Postgres can't infer: arrays and the source enum.
const SNAPSHOT_CASTS: Record<string, string> = {
  assignee_ids: '::bigint[]',
  assignee_actors: '::text[]',
  source: '::fulfillment_source',
};

/**
 * One multi-row insert for job_snapshots with $n placeholders (row-major),
 * on conflict (snapshot_date, job_id) updating the live columns from
 * EXCLUDED and only when the new capture is not older (plan section E).
 * The rows must be non-empty; callers send batches of BATCH.
 */
export function buildSnapshotUpsert(rows: JobSnapshotRow[]): { text: string; params: unknown[] } {
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
    on conflict (snapshot_date, job_id) do update set
      stage_id = excluded.stage_id,
      status_id = excluded.status_id,
      moved_at = excluded.moved_at,
      status_changed_at = excluded.status_changed_at,
      due_date = excluded.due_date,
      internal_deadline = excluded.internal_deadline,
      completed_at = excluded.completed_at,
      priority = excluded.priority,
      assignee_ids = excluded.assignee_ids,
      assignee_actors = excluded.assignee_actors,
      source = 'api',
      import_run_id = excluded.import_run_id,
      captured_at = excluded.captured_at
    where excluded.captured_at >= job_snapshots.captured_at`;
  return { text, params };
}

/**
 * Client ids from this walk that td_clients doesn't have or hasn't synced in
 * maxAgeDays; sorted ascending, duplicates dropped.
 */
export function staleClientIds(seen: Iterable<number>, known: Map<number, Date>, now: Date, maxAgeDays = 30): number[] {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const stale: number[] = [];
  for (const id of new Set(seen)) {
    const synced = known.get(id);
    if (!synced || synced.getTime() < cutoff) stale.push(id);
  }
  return stale.sort((a, b) => a - b);
}

/** Removes anything that looks like a TaxDome API key before it is logged. */
const stripKeys = (text: string): string => text.replace(/tdk_[A-Za-z0-9_]+/g, 'tdk_***');

function chunk<T>(rows: T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  return batches;
}

/**
 * One parameterised multi-row insert … on conflict do update per batch of
 * BATCH rows; values only ever travel as $n params, never in the SQL text.
 */
async function upsertRows(
  db: Db,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
  updates: string[],
  casts: Record<string, string> = {}
): Promise<void> {
  for (const batch of chunk(rows)) {
    const params: unknown[] = [];
    const values = batch.map(
      (row) =>
        `(${row.map((value, i) => {
          params.push(value);
          return `$${params.length}${casts[columns[i]] ?? ''}`;
        }).join(', ')})`
    );
    const sets = updates.map((col) => `${col} = excluded.${col}`).join(', ');
    await db.query(
      `insert into ${table} (${columns.join(', ')}) values ${values.join(', ')} on conflict ${conflict} do update set ${sets}`,
      params
    );
  }
}

// ── The run ───────────────────────────────────────────────────────────────

/** Written to import_runs.detail on success; no key, no email. */
export interface PollRunDetail {
  firm_name: string | null;
  subdomain: string | null;
  timezone: string | null;
  total_found: number | null;
  pages: number;
  unknown_stage_ids: number[];
  placeholder_clients: number;
  assignments: number;
  pipelines: number;
  stages: number;
  statuses: number;
  people: number;
  clients_refreshed: number;
}

export interface PollResult {
  run_id: number;
  snapshot_date: string;
  requests_made: number;
  jobs_written: number;
  detail: PollRunDetail;
}

export interface PollDeps {
  api?: TdApi;
  now?: () => Date;
}

/**
 * Runs one poll for an import_runs row (source 'api', status 'running'):
 * the /me header, the reference-table syncs, the jobs and assignments walks,
 * the client refresh, the snapshot upsert and the run's own outcome — plan
 * section E, in that order. On any error the run is set to 'error' (with the
 * message stripped of anything key-like) and the error is rethrown; the
 * caller only logs.
 */
export async function runFulfillmentPoll(runId: number, deps: PollDeps = {}): Promise<PollResult> {
  const api = deps.api ?? tdApiFromEnv();
  const now = deps.now ?? (() => new Date());
  const { many, sql } = await import('./db.ts');
  const db = sql();
  const capturedAt = now();
  const snapshotDate = firmDate(capturedAt);

  const detail: PollRunDetail = {
    firm_name: null,
    subdomain: null,
    timezone: null,
    total_found: null,
    pages: 0,
    unknown_stage_ids: [],
    placeholder_clients: 0,
    assignments: 0,
    pipelines: 0,
    stages: 0,
    statuses: 0,
    people: 0,
    clients_refreshed: 0,
  };

  try {
    // The firm, for the run detail only (no key, no email)
    const me = await api.get<{ firm_name?: string; subdomain?: string; timezone?: string }>('/me');
    detail.firm_name = me.data.firm_name ?? null;
    detail.subdomain = me.data.subdomain ?? null;
    detail.timezone = me.data.timezone ?? null;

    // Reference tables
    const pipelines = await api.walk<{ id: number; title: string; default_job_template_id: number | null }>(
      '/pipelines', { limit: 200 });
    await upsertRows(db, 'td_pipelines', ['id', 'title', 'default_job_template_id', 'synced_at'],
      pipelines.rows.map((p) => [p.id, p.title, p.default_job_template_id, capturedAt]), '(id)',
      ['title', 'default_job_template_id', 'synced_at']);
    detail.pipelines = pipelines.rows.length;

    // stage_order stores the API field "order" (a reserved word in SQL)
    const stages = await api.walk<{
      id: number; pipeline_id: number; title: string; order: number | null;
      stage_limit_days: number | null; automove_jobs: boolean | null;
    }>('/pipeline_stages', { limit: 200 });
    if (stages.rows.length) {
      // td_pipeline_stages has a unique (pipeline_id, stage_order): two stages
      // swapping order would otherwise collide mid-statement; nulls are distinct for the index.
      await db.query('update td_pipeline_stages set stage_order = null where id = any($1::bigint[])',
        [stages.rows.map((s) => s.id)]);
    }
    await upsertRows(db, 'td_pipeline_stages',
      ['id', 'pipeline_id', 'title', 'stage_order', 'stage_limit_days', 'automove_jobs', 'synced_at'],
      stages.rows.map((s) => [s.id, s.pipeline_id, s.title, s.order, s.stage_limit_days, s.automove_jobs, capturedAt]),
      '(id)', ['pipeline_id', 'title', 'stage_order', 'stage_limit_days', 'automove_jobs', 'synced_at']);
    detail.stages = stages.rows.length;

    // kind is stored as the API spells it; the code never branches on name
    const statuses = await api.walk<{ id: number; pipeline_id: number; kind: string | null; name: string | null }>(
      '/job_statuses', { limit: 200 });
    await upsertRows(db, 'td_job_statuses', ['id', 'pipeline_id', 'kind', 'name', 'synced_at'],
      statuses.rows.map((s) => [s.id, s.pipeline_id, s.kind, s.name, capturedAt]), '(id)',
      ['pipeline_id', 'kind', 'name', 'synced_at']);
    detail.statuses = statuses.rows.length;

    const owner = await api.get<TdPerson>('/owner');
    const employees = await api.walk<TdPerson>('/employees', { limit: 200 });
    const people = [owner.data, ...employees.rows];
    await upsertRows(db, 'td_people',
      ['actor_type', 'id', 'user_id', 'first_name', 'last_name', 'email', 'role', 'display_name', 'synced_at'],
      people.map((p) => [p.type, p.id, p.user_id ?? null, p.first_name ?? null, p.last_name ?? null, p.email ?? null,
        p.role ?? null, displayName(p.first_name ?? null, p.last_name ?? null), capturedAt]),
      '(actor_type, id)', ['user_id', 'first_name', 'last_name', 'email', 'role', 'display_name', 'synced_at']);
    detail.people = people.length;

    // Jobs and assignments
    const jobsWalk = await api.walk<TdJob>('/jobs', { fields: JOB_FIELDS, sort: 'created_at', limit: 200 });
    detail.total_found = jobsWalk.totalFound;
    detail.pages = jobsWalk.pages;

    const assignments = await api.walk<TdAssignment>('/job_assignments',
      { fields: ['id', 'job_id', 'actor_type', 'actor_id'], limit: 200 });
    detail.assignments = assignments.rows.length;

    // Clients the jobs reference: refresh the stale ones, then keep the FK
    // valid for any the key cannot see
    const seenClientIds = [...new Set(jobsWalk.rows.map((j) => j.client_id))];
    const knownRows = seenClientIds.length
      ? await many<{ id: number; synced_at: string }>(
          db.query('select id, synced_at from td_clients where id = any($1::bigint[])', [seenClientIds]))
      : [];
    const stale = staleClientIds(seenClientIds, new Map(knownRows.map((r) => [r.id, new Date(r.synced_at)])), capturedAt);
    if (stale.length) {
      const clients = await api.byIds<TdClient>('/clients', stale,
        { fields: ['id', 'account_name', 'company_name', 'account_type', 'code', 'lead', 'archived_at', 'tag_ids'] });
      await upsertRows(db, 'td_clients',
        ['id', 'account_name', 'company_name', 'account_type', 'code', 'lead', 'archived_at', 'tag_ids', 'synced_at'],
        clients.map((c) => [c.id, c.account_name ?? null, c.company_name ?? null, c.account_type ?? null, c.code ?? null,
          c.lead ?? null, c.archived_at ?? null, c.tag_ids ?? [], capturedAt]),
        '(id)', ['account_name', 'company_name', 'account_type', 'code', 'lead', 'archived_at', 'tag_ids', 'synced_at'],
        { tag_ids: '::bigint[]' });
      detail.clients_refreshed = clients.length;
    }
    const present = seenClientIds.length
      ? new Set((await many<{ id: number }>(
          db.query('select id from td_clients where id = any($1::bigint[])', [seenClientIds]))).map((r) => r.id))
      : new Set<number>();
    const missingClientIds = seenClientIds.filter((id) => !present.has(id));
    if (missingClientIds.length) {
      await upsertRows(db, 'td_clients', ['id', 'synced_at'],
        missingClientIds.map((id) => [id, capturedAt]), '(id)', ['synced_at']);
      detail.placeholder_clients = missingClientIds.length;
    }

    // Snapshots: unknown stages are recorded, not written
    const ctx: PollContext = {
      stages: new Map(stages.rows.map((s) => [s.id, { pipeline_id: s.pipeline_id }])),
      statuses: new Set(statuses.rows.map((s) => s.id)),
      assignments: groupAssignments(assignments.rows),
      snapshotDate,
      capturedAt,
      runId,
    };
    const rows: JobSnapshotRow[] = [];
    const unknownStageIds = new Set<number>();
    for (const job of jobsWalk.rows) {
      const mapped = mapJobSnapshot(job, ctx);
      if ('skipped' in mapped) {
        unknownStageIds.add(mapped.stage_id);
        continue;
      }
      rows.push(mapped);
    }
    detail.unknown_stage_ids = [...unknownStageIds].sort((a, b) => a - b);
    // job_snapshots has a daily primary key (snapshot_date, job_id): the upsert
    // below would overwrite today's earlier observation; the diff needs the true previous one.
    const previous = await loadLatestSnapshots(db, rows.map((r) => r.job_id));
    for (const batch of chunk(rows)) {
      const { text, params } = buildSnapshotUpsert(batch);
      await db.query(text, params);
    }
    // Steps 7 (the diff engine) and 9 (the rules runner) hook in here.
    const diffCounts = await runFulfillmentDiff(runId, { previous });

    const result: PollResult = {
      run_id: runId,
      snapshot_date: snapshotDate,
      requests_made: api.requestsMade,
      jobs_written: rows.length,
      detail,
    };
    await db`
      update import_runs set
        status = 'ok', finished_at = now(), snapshot_date = ${snapshotDate},
        requests_made = ${api.requestsMade}, jobs_written = ${rows.length},
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
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db`
        update import_runs set status = 'error', finished_at = now(),
          requests_made = ${api.requestsMade}, error = ${stripKeys(message)}
        where id = ${runId}`;
    } catch (logErr) {
      console.log('[fulfillment-poll] could not record the failed run', logErr instanceof Error ? logErr.message : logErr);
    }
    throw err;
  }
}
