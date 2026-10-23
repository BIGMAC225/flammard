// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally —
// every relative import here carries its .ts extension, and db.ts (whose
// './env' import node cannot resolve) is only imported inside
// runFulfillmentDiff, which the tests never call.
import type { NeonQueryFunction, NeonQueryInTransaction } from '@neondatabase/serverless';
import { firmDate } from './taxdome-date.ts';

// The fulfillment diff engine (implementation plan, section J step 7): turns
// the gap between this run's job_snapshots rows and the latest earlier ones
// into stage_intervals closes/opens and job_events rows (plan section G).
// diffSnapshots is a pure function of its inputs, so every branch is testable
// without Postgres:
//   node --test tests/fulfillment-diff.test.mjs
// runFulfillmentDiff is the thin DB wrapper: load the inputs, diff, apply the
// plan in one transaction, return the counts for import_runs. The poller
// passes deps.previous explicitly (from loadLatestSnapshots, read before its
// own write): job_snapshots is keyed (snapshot_date, job_id), so a same-day
// re-run overwrites today's earlier observation before the diff could query
// it back. The default "latest captured before this run" query is right only
// for the CSV path, whose rows never overwrite.

const BATCH = 200;

export type Db = NeonQueryFunction<false, false>;

/** timestamptz as Postgres returns it (Date) or as the API and fixtures spell it (ISO string). */
export type Timestamp = string | Date;

/** A job_snapshots row, restricted to the columns the diff rules read. */
export interface SnapshotRow {
  job_id: number;
  pipeline_id: number;
  stage_id: number;
  status_id: number | null;
  moved_at: Timestamp;
  status_changed_at: Timestamp | null;
  intake_date: Timestamp | null;
  completed_at: Timestamp | null;
  captured_at: Timestamp;
}

/** A job's open stage_intervals row (exited_at is null). */
export interface OpenInterval {
  id: number;
  stage_id: number;
  entered_at: Timestamp;
}

/** Everything the rules need to know about one diff pass. */
export interface DiffInput {
  /** The rows this run wrote (one per job). */
  current: SnapshotRow[];
  /** job_id -> the latest snapshot with captured_at strictly before this run's. */
  previous: Map<number, SnapshotRow>;
  /** job_id -> the open stage_intervals row (every open interval, not just this run's jobs). */
  openIntervals: Map<number, OpenInterval>;
  /** status_id -> kind; a missing row or null kind is treated as 'active' (flagged kind_unknown). */
  statusKind: Map<number, string | null>;
  /** stage_id -> stage_order; null orders compare as 'moved'. */
  stageOrder: Map<number, number | null>;
  /** True when job_events is empty: the backfill rule applies to first sightings. */
  firstRunEver: boolean;
  /** True for source 'api' (the walk covers every job): absence means deleted or hidden. */
  fullWalk: boolean;
  /** This run's captured_at. */
  runAt: Date;
  /** The wrapper stamps it on the events it inserts; the rules don't read it. */
  runId: number;
}

export type DiffEventType =
  | 'new'
  | 'moved'
  | 'moved_back'
  | 'status_changed'
  | 'completed'
  | 'archived'
  | 'reopened';

/** Counts per event type; assumed_deleted also counts its 'archived' events in archived. */
export interface DiffCounts extends Record<DiffEventType, number> {
  assumed_deleted: number;
}

/**
 * A close keyed by the interval's DB id — or, for an interval this same pass
 * opened (which has no id yet), by its natural key (job_id, stage_id, entered_at).
 */
export interface CloseInterval {
  id: number | null;
  job_id: number;
  stage_id: number;
  entered_at: string;
  exited_at: string;
  days: number;
}

/** An interval to open, entered_at always the job's current moved_at. */
export interface OpenIntervalPlan {
  job_id: number;
  pipeline_id: number;
  stage_id: number;
  entered_at: string;
}

/** One job_events row as it will be inserted (import_run_id added by the wrapper). */
export interface DiffEvent {
  job_id: number;
  event_type: DiffEventType;
  at: string;
  from_stage_id: number | null;
  to_stage_id: number | null;
  detail: Record<string, unknown> | null;
}

/** Everything the wrapper has to write for one diff pass. */
export interface DiffPlan {
  closeIntervals: CloseInterval[];
  openIntervals: OpenIntervalPlan[];
  events: DiffEvent[];
  counts: DiffCounts;
}

const toDate = (value: Timestamp): Date => (value instanceof Date ? value : new Date(value));
const iso = (value: Timestamp): string => toDate(value).toISOString();

/** Whole firm-local days between two instants: the firmDate() difference. */
function firmDayDiff(from: Timestamp, to: Timestamp): number {
  return (Date.parse(firmDate(toDate(to))) - Date.parse(firmDate(toDate(from)))) / 86_400_000;
}

/**
 * The plan section G rules. Pure: reads nothing, writes nothing. Within one
 * job, an interval opened earlier in the same pass is the one later branches
 * close; closing when nothing is open does nothing, and opening when the job
 * already has an open interval skips the open but keeps the event.
 */
export function diffSnapshots(input: DiffInput): DiffPlan {
  const closeIntervals: CloseInterval[] = [];
  const openPlan: OpenIntervalPlan[] = [];
  const events: DiffEvent[] = [];
  const counts: DiffCounts = {
    new: 0, moved: 0, moved_back: 0, status_changed: 0, completed: 0, archived: 0, reopened: 0,
    assumed_deleted: 0,
  };

  // An unknown status (no row, or a row with kind null) behaves as 'active';
  // every event such a job produces carries detail.kind_unknown.
  const kindOf = (statusId: number | null): { kind: string; unknown: boolean } => {
    const kind = statusId == null ? null : input.statusKind.get(statusId) ?? null;
    return kind == null ? { kind: 'active', unknown: true } : { kind, unknown: false };
  };

  const currentJobIds = new Set<number>();

  for (const cur of input.current) {
    currentJobIds.add(cur.job_id);
    const kind = kindOf(cur.status_id);
    // The job's open interval as this pass sees it: the DB row first, then
    // whatever this pass opened for it.
    let open: { id: number | null; stage_id: number; entered_at: Timestamp } | null =
      input.openIntervals.get(cur.job_id) ?? null;

    const emit = (
      event_type: DiffEventType,
      at: Timestamp,
      from_stage_id: number | null = null,
      to_stage_id: number | null = null,
      detail: Record<string, unknown> | null = null
    ): void => {
      const merged = { ...(detail ?? {}), ...(kind.unknown ? { kind_unknown: true } : {}) };
      events.push({
        job_id: cur.job_id,
        event_type,
        at: iso(at),
        from_stage_id,
        to_stage_id,
        detail: Object.keys(merged).length ? merged : null,
      });
      counts[event_type]++;
    };
    const closeOpen = (exitedAt: Timestamp): void => {
      if (!open) return; // nothing is open: do nothing, do not invent one
      closeIntervals.push({
        id: open.id,
        job_id: cur.job_id,
        stage_id: open.stage_id,
        entered_at: iso(open.entered_at),
        exited_at: iso(exitedAt),
        days: firmDayDiff(open.entered_at, exitedAt),
      });
      open = null;
    };
    const openInterval = (stageId: number): void => {
      if (open) return; // already open for the job: skip the open, keep the event
      open = { id: null, stage_id: stageId, entered_at: cur.moved_at };
      openPlan.push({ job_id: cur.job_id, pipeline_id: cur.pipeline_id, stage_id: stageId, entered_at: iso(cur.moved_at) });
    };

    const prev = input.previous.get(cur.job_id) ?? null;
    if (!prev) {
      // First sighting
      openInterval(cur.stage_id);
      if (input.firstRunEver) {
        // Backfill: seed history without inventing it — one interval, one
        // 'new' event at the intake date, no synthetic moves
        emit('new', cur.intake_date ?? cur.moved_at, null, null, { backfill: true });
      } else {
        emit('new', cur.captured_at);
      }
    } else {
      const prevKind = kindOf(prev.status_id);
      if (cur.stage_id !== prev.stage_id) {
        // Stage change: close at the exact moved_at, not the poll time. Stages
        // passed through between two polls are not knowable; the gap is implicit.
        closeOpen(cur.moved_at);
        openInterval(cur.stage_id);
        const newOrder = input.stageOrder.get(cur.stage_id) ?? null;
        const oldOrder = input.stageOrder.get(prev.stage_id) ?? null;
        emit(
          newOrder != null && oldOrder != null && newOrder < oldOrder ? 'moved_back' : 'moved',
          cur.moved_at,
          prev.stage_id,
          cur.stage_id
        );
      } else if (toDate(cur.moved_at).getTime() > toDate(prev.moved_at).getTime()) {
        // Same stage, clock reset: out and back (days may be 0)
        closeOpen(cur.moved_at);
        openInterval(cur.stage_id);
        emit('moved', cur.moved_at, cur.stage_id, cur.stage_id, { bounce: true });
      }

      if (kind.kind === 'completed' && prevKind.kind !== 'completed') {
        const at = cur.completed_at ?? cur.captured_at;
        closeOpen(at);
        emit('completed', at);
      }
      if (kind.kind === 'archived' && prevKind.kind !== 'archived' && prevKind.kind !== 'completed') {
        closeOpen(cur.captured_at);
        emit('archived', cur.captured_at);
      }
      if ((prevKind.kind === 'archived' || prevKind.kind === 'completed') && kind.kind === 'active') {
        openInterval(cur.stage_id); // skipped when the job never left
        emit('reopened', cur.status_changed_at ?? cur.captured_at);
      }
      if (cur.status_id !== prev.status_id && kind.kind === prevKind.kind) {
        emit('status_changed', cur.status_changed_at ?? cur.captured_at, null, null, {
          from_status_id: prev.status_id,
          to_status_id: cur.status_id,
        });
      }
    }
  }

  if (input.fullWalk) {
    // The API walk covers all jobs, so absence means deleted or hidden from
    // the key. (The CSV export is filtered to unarchived jobs, so absence
    // proves nothing there and the block is skipped.)
    for (const [jobId, interval] of input.openIntervals) {
      if (currentJobIds.has(jobId)) continue;
      closeIntervals.push({
        id: interval.id,
        job_id: jobId,
        stage_id: interval.stage_id,
        entered_at: iso(interval.entered_at),
        exited_at: iso(input.runAt),
        days: firmDayDiff(interval.entered_at, input.runAt),
      });
      events.push({
        job_id: jobId,
        event_type: 'archived',
        at: iso(input.runAt),
        from_stage_id: null,
        to_stage_id: null,
        detail: { assumed_deleted: true },
      });
      counts.archived++;
      counts.assumed_deleted++;
    }
  }

  return { closeIntervals, openIntervals: openPlan, events, counts };
}

// ── The DB wrapper ────────────────────────────────────────────────────────

interface Statement {
  text: string;
  params: unknown[];
}

function chunk<T>(rows: T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  return batches;
}

/** One multi-row `values` list with $n placeholders (row-major); casts per column index. */
function valuesSql(rows: unknown[][], casts: string[] = []): { values: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map(
    (row) =>
      `(${row.map((value, i) => {
        params.push(value);
        return `$${params.length}${casts[i] ?? ''}`;
      }).join(', ')})`
  );
  return { values: values.join(', '), params };
}

/**
 * The plan as SQL statements in apply order: closes by id, opens, closes of
 * intervals this pass opened (by their natural key, which only exists after
 * the opens), then the events. Multi-row, $n placeholders, BATCH rows per
 * statement; values only ever travel as params, never in the SQL text.
 */
export function buildApplyStatements(plan: DiffPlan, runId: number): Statement[] {
  const statements: Statement[] = [];

  for (const batch of chunk(plan.closeIntervals.filter((c) => c.id != null))) {
    const { values, params } = valuesSql(
      batch.map((c) => [c.id, c.exited_at, c.days]),
      ['::bigint', '::timestamptz', '::int']
    );
    statements.push({
      text: `update stage_intervals as si set exited_at = v.exited_at, days = v.days
        from (values ${values}) as v(id, exited_at, days)
        where si.id = v.id`,
      params,
    });
  }

  for (const batch of chunk(plan.openIntervals)) {
    const { values, params } = valuesSql(
      batch.map((o) => [o.job_id, o.pipeline_id, o.stage_id, o.entered_at]),
      ['::bigint', '::bigint', '::bigint', '::timestamptz']
    );
    statements.push({
      text: `insert into stage_intervals (job_id, pipeline_id, stage_id, entered_at)
        values ${values}
        on conflict (job_id, stage_id, entered_at) do nothing`,
      params,
    });
  }

  for (const batch of chunk(plan.closeIntervals.filter((c) => c.id == null))) {
    const { values, params } = valuesSql(
      batch.map((c) => [c.job_id, c.stage_id, c.entered_at, c.exited_at, c.days]),
      ['::bigint', '::bigint', '::timestamptz', '::timestamptz', '::int']
    );
    statements.push({
      text: `update stage_intervals as si set exited_at = v.exited_at, days = v.days
        from (values ${values}) as v(job_id, stage_id, entered_at, exited_at, days)
        where si.job_id = v.job_id and si.stage_id = v.stage_id and si.entered_at = v.entered_at`,
      params,
    });
  }

  for (const batch of chunk(plan.events)) {
    const { values, params } = valuesSql(
      batch.map((e) => [
        e.job_id, e.event_type, e.at, e.from_stage_id, e.to_stage_id,
        e.detail == null ? null : JSON.stringify(e.detail), runId,
      ]),
      ['::bigint', '', '::timestamptz', '::bigint', '::bigint', '::jsonb', '::bigint']
    );
    statements.push({
      text: `insert into job_events (job_id, event_type, at, from_stage_id, to_stage_id, detail, import_run_id)
        values ${values}`,
      params,
    });
  }

  return statements;
}

/**
 * The latest job_snapshots row per job id, regardless of captured_at — the
 * observation the poller must read before its own upsert overwrites today's
 * row (the daily (snapshot_date, job_id) primary key). Takes the query
 * function as a parameter so this module still never imports db.ts (header).
 */
export async function loadLatestSnapshots(db: Db, jobIds: number[]): Promise<Map<number, SnapshotRow>> {
  if (!jobIds.length) return new Map();
  const rows = (await db.query(
    `select distinct on (job_id) job_id, pipeline_id, stage_id, status_id, moved_at,
      status_changed_at, intake_date, completed_at, captured_at
    from job_snapshots
    where job_id = any($1::bigint[])
    order by job_id, captured_at desc`,
    [jobIds]
  )) as SnapshotRow[];
  return new Map(rows.map((r) => [r.job_id, r]));
}

/**
 * Diffs the snapshots one import run just wrote against everything earlier and
 * applies the resulting closes, opens and events in a single transaction.
 * Returns the counts for the import_runs jobs_* columns. deps.previous, when
 * given, is used as the previous map instead of querying it — the poller
 * reads it before its own upsert overwrites today's row.
 */
export async function runFulfillmentDiff(
  runId: number,
  deps: { previous?: Map<number, SnapshotRow> } = {}
): Promise<DiffCounts> {
  const { many, sql } = await import('./db.ts');
  const db = sql();

  // The run (its source decides fullWalk) and its own rows
  const runRows = await many<{ source: 'api' | 'csv'; started_at: Date }>(
    db.query('select source, started_at from import_runs where id = $1', [runId])
  );
  if (!runRows.length) throw new Error(`import run ${runId} not found`);
  const { source, started_at } = runRows[0];

  const current = await many<SnapshotRow>(
    db.query(
      `select job_id, pipeline_id, stage_id, status_id, moved_at, status_changed_at,
        intake_date, completed_at, captured_at
      from job_snapshots where import_run_id = $1`,
      [runId]
    )
  );

  const jobIds = [...new Set(current.map((r) => r.job_id))];
  const runAt = current.length
    ? new Date(Math.max(...current.map((r) => toDate(r.captured_at).getTime())))
    : started_at;
  // The latest earlier snapshot per job (captured_at strictly before this
  // run's); the poller passes deps.previous instead, because its own upsert
  // has already overwritten today's row (see the header comment)
  const previousRows = !deps.previous && jobIds.length
    ? await many<SnapshotRow>(
        db.query(
          `select distinct on (job_id) job_id, pipeline_id, stage_id, status_id, moved_at,
            status_changed_at, intake_date, completed_at, captured_at
          from job_snapshots
          where job_id = any($1::bigint[]) and captured_at < $2
          order by job_id, captured_at desc`,
          [jobIds, runAt]
        )
      )
    : [];
  const previous = deps.previous ?? new Map(previousRows.map((r) => [r.job_id, r]));

  // Every open interval, not just this run's jobs: the fullWalk rule needs the
  // ones whose job is absent from the walk
  const openRows = await many<OpenInterval & { job_id: number }>(
    db.query('select id, job_id, stage_id, entered_at from stage_intervals where exited_at is null')
  );

  const statusRows = await many<{ id: number; kind: string | null }>(db.query('select id, kind from td_job_statuses'));
  const stageRows = await many<{ id: number; stage_order: number | null }>(
    db.query('select id, stage_order from td_pipeline_stages')
  );
  const firstRows = await many<{ first: boolean }>(
    db.query('select not exists (select 1 from job_events) as first')
  );

  const plan = diffSnapshots({
    current,
    previous,
    openIntervals: new Map(openRows.map((r) => [r.job_id, r])),
    statusKind: new Map(statusRows.map((r) => [r.id, r.kind])),
    stageOrder: new Map(stageRows.map((r) => [r.id, r.stage_order])),
    firstRunEver: firstRows[0]?.first ?? false,
    fullWalk: source === 'api',
    runAt,
    runId,
  });

  const statements = buildApplyStatements(plan, runId);
  if (statements.length) {
    // The d.ts wants NeonQueryInTransaction[]; tx.query's promises carry the
    // query data at runtime and are all sent as one transaction
    await db.transaction((tx) =>
      statements.map(({ text, params }) => tx.query(text, params)) as unknown as NeonQueryInTransaction[]
    );
  }

  return plan.counts;
}
