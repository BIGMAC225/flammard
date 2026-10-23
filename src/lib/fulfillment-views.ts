// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally:
// every relative import here carries its .ts extension, and db.ts (whose
// './env' import node cannot resolve) is never imported at all: the loaders
// take a Db argument, so the tests can exercise every pure function without
// Postgres:
//   node --test tests/fulfillment-views.test.mjs
//
// The fulfillment dashboard views' data layer (implementation plan, section J
// step 11; the views are plan section I, V1 to V8). Every view reads the same
// base: the latest snapshot per job, joined the way runFulfillmentRules in
// fulfillment-rules.ts joins it, so an empty stage_type_map resolves every
// stage to the 'unmapped' stall_rules row (stuck 7, critical 10, ball_with
// firm) and never throws. The pure functions (enrichment, aggregations,
// chart shaping) read nothing and write nothing and tolerate empty input;
// the loaders are thin db.query wrappers that do no shaping of their own.

import { effectiveThresholds, type Db } from './fulfillment-rules.ts';

// ── Shared row type ────────────────────────────────────────────────────────

/**
 * One job's latest snapshot joined to its pipeline, stage, status, client and
 * stall rule (V1 to V6, and the job detail). Ids are number | string: the
 * Neon HTTP driver may return bigint columns as strings, so pure functions
 * key maps and compare ids via String(id), never with === on raw values.
 */
export interface ViewRow {
  job_id: number | string;
  job_name: string | null;
  pipeline_id: number | string;
  pipeline_title: string;
  stage_id: number | string;
  stage_title: string;
  stage_order: number | null;
  snapshot_date: string;
  days_in_stage: number;
  moved_at: string | null;
  due_date: string | null;
  internal_deadline: string | null;
  intake_date: string | null;
  completed_at: string | null;
  /** From td_job_statuses; null when the status row is missing. */
  kind: string | null;
  status_name: string | null;
  priority: string | null;
  assignee_actors: string[];
  client_id: number | string;
  account_name: string | null;
  /** The mapped stage type, or 'unmapped' when stage_type_map has no row (it is empty today). */
  stage_type: string;
  ball_with: string;
  stage_limit_days: number | null;
  stuck_days: number | null;
  critical_days: number | null;
}

/** The view-rows query: the latest CTE and the joins every view loader uses. */
function viewRowsSql(opts: { pipelineId?: number | string; activeOnly?: boolean; jobId?: number | string } = {}): {
  text: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.activeOnly !== false) where.push("st.kind = 'active'");
  if (opts.pipelineId != null) {
    params.push(opts.pipelineId);
    where.push(`l.pipeline_id = $${params.length}::bigint`);
  }
  if (opts.jobId != null) {
    params.push(opts.jobId);
    where.push(`l.job_id = $${params.length}::bigint`);
  }
  const text = `
    with latest as (select distinct on (job_id) * from job_snapshots order by job_id, captured_at desc)
    select l.job_id, l.job_name, l.pipeline_id, p.title as pipeline_title, l.stage_id,
      ps.title as stage_title, ps.stage_order, l.snapshot_date::text, l.days_in_stage,
      l.moved_at::text, l.due_date::text, l.internal_deadline::text, l.intake_date::text,
      l.completed_at::text, st.kind, st.name as status_name, l.priority, l.assignee_actors,
      l.client_id, c.account_name,
      coalesce(m.stage_type, 'unmapped') as stage_type,
      coalesce(sr.ball_with, 'firm') as ball_with,
      ps.stage_limit_days, sr.stuck_days, sr.critical_days
    from latest l
    join td_pipelines p on p.id = l.pipeline_id
    join td_pipeline_stages ps on ps.id = l.stage_id
    left join td_job_statuses st on st.id = l.status_id
    left join td_clients c on c.id = l.client_id
    left join stage_type_map m on m.stage_id = l.stage_id
    left join stall_rules sr on sr.stage_type = coalesce(m.stage_type, 'unmapped')
    ${where.length ? `where ${where.join(' and ')}` : ''}`;
  return { text, params };
}

/**
 * The latest snapshot per job with every join the views need. activeOnly
 * defaults to true (st.kind = 'active'); pass false to also get completed and
 * archived jobs, which V8's cycle time needs. pipelineId narrows to one
 * pipeline (V2's board, V6's aging chart).
 */
export async function loadViewRows(
  db: Db,
  opts: { pipelineId?: number | string; activeOnly?: boolean } = {}
): Promise<ViewRow[]> {
  const { text, params } = viewRowsSql(opts);
  return (await db.query(text, params)) as ViewRow[];
}

// ── Enrichment ─────────────────────────────────────────────────────────────

export type Rag = 'green' | 'amber' | 'red';

/** A ViewRow with the thresholds and derived flags the views display. */
export interface EnrichedRow extends ViewRow {
  stuck: number;
  critical: number;
  /** days_in_stage minus stuck (negative while still green). */
  days_over: number;
  rag: Rag;
  past_internal_deadline: boolean;
  /** Whole days from snapshot_date to due_date, null without a due date. */
  days_to_due: number | null;
}

/** Whole days from one YYYY-MM-DD date to another (to minus from), UTC. */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** The RAG colour: red at or past critical, amber at or past stuck, else green. */
export function ragFor(days: number, stuck: number, critical: number): Rag {
  if (days >= critical) return 'red';
  if (days >= stuck) return 'amber';
  return 'green';
}

/**
 * Computes every derived field the views show, thresholds via
 * effectiveThresholds (the same formula the rules runner uses), deadlines by
 * plain YYYY-MM-DD string compare, exactly like evaluateJob does.
 */
export function enrich(rows: ViewRow[]): EnrichedRow[] {
  return rows.map((row) => {
    const { stuck, critical } = effectiveThresholds(row);
    return {
      ...row,
      stuck,
      critical,
      days_over: row.days_in_stage - stuck,
      rag: ragFor(row.days_in_stage, stuck, critical),
      past_internal_deadline: row.internal_deadline != null && row.internal_deadline < row.snapshot_date,
      days_to_due: row.due_date != null ? daysBetween(row.snapshot_date, row.due_date) : null,
    };
  });
}

// ── Shared sorting ─────────────────────────────────────────────────────────

/**
 * Orders stages (or anything stage-shaped) by stage_order ascending with
 * nulls last, then by name. Everything that lists stages uses this so the
 * board, the aging chart and the dwell table all agree.
 */
function byStageOrder<T extends { stage_order: number | null }>(name: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    if (a.stage_order != null && b.stage_order != null && a.stage_order !== b.stage_order) {
      return a.stage_order - b.stage_order;
    }
    if (a.stage_order == null && b.stage_order != null) return 1;
    if (a.stage_order != null && b.stage_order == null) return -1;
    const an = name(a);
    const bn = name(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  };
}

/** One td_pipeline_stages row as the board and aging chart need it. */
export interface StageLite {
  id: number | string;
  pipeline_id: number | string;
  title: string;
  stage_order: number | null;
  stage_limit_days: number | null;
}

// ── V1: overview ───────────────────────────────────────────────────────────

/** One pipeline's row on the overview (V1). */
export interface OverviewRow {
  pipeline_id: number | string;
  title: string;
  wip: number;
  /** Amber or red jobs. */
  stuck: number;
  /** Red jobs. */
  critical: number;
  /** Jobs whose stage_type is 'review'. */
  wip_in_review: number;
  oldest_days: number;
}

/** The overview's firm-wide totals (V1's header tiles). */
export interface OverviewTotals {
  wip: number;
  stuck: number;
  critical: number;
  wip_in_review: number;
  oldest_days: number;
}

/** Per-pipeline counts (V1), keyed by String(pipeline_id), sorted by title. */
export function overview(rows: EnrichedRow[]): OverviewRow[] {
  const byPipeline = new Map<string, OverviewRow>();
  for (const row of rows) {
    const key = String(row.pipeline_id);
    let agg = byPipeline.get(key);
    if (!agg) {
      agg = {
        pipeline_id: row.pipeline_id,
        title: row.pipeline_title,
        wip: 0,
        stuck: 0,
        critical: 0,
        wip_in_review: 0,
        oldest_days: 0,
      };
      byPipeline.set(key, agg);
    }
    agg.wip++;
    if (row.rag === 'amber' || row.rag === 'red') agg.stuck++;
    if (row.rag === 'red') agg.critical++;
    if (row.stage_type === 'review') agg.wip_in_review++;
    if (row.days_in_stage > agg.oldest_days) agg.oldest_days = row.days_in_stage;
  }
  return [...byPipeline.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/** Sums the overview rows; oldest_days is the max, 0 for no rows. */
export function overviewTotals(rows: OverviewRow[]): OverviewTotals {
  return {
    wip: rows.reduce((n, r) => n + r.wip, 0),
    stuck: rows.reduce((n, r) => n + r.stuck, 0),
    critical: rows.reduce((n, r) => n + r.critical, 0),
    wip_in_review: rows.reduce((n, r) => n + r.wip_in_review, 0),
    oldest_days: rows.length ? Math.max(...rows.map((r) => r.oldest_days)) : 0,
  };
}

// ── V2: board ──────────────────────────────────────────────────────────────

/** One board column (V2): the stage, its counts, and the cards. */
export interface BoardColumn {
  stage: StageLite;
  count: number;
  oldest: number;
  /** True when the column's rows have ball_with 'client' (the shaded column); false with no rows. */
  client_typed: boolean;
  /** The column's jobs, days_in_stage descending. */
  cards: EnrichedRow[];
}

const stageOrder = byStageOrder<StageLite>((s) => s.title);

/**
 * The kanban board (V2): one column per stage, even a stage with no jobs,
 * ordered by stage_order ascending (nulls last) then title, cards sorted
 * days_in_stage descending.
 */
export function board(stages: StageLite[], rows: EnrichedRow[]): BoardColumn[] {
  return [...stages].sort(stageOrder).map((stage) => {
    const cards = rows
      .filter((row) => String(row.stage_id) === String(stage.id))
      .sort((a, b) => b.days_in_stage - a.days_in_stage);
    return {
      stage,
      count: cards.length,
      oldest: cards.length ? cards[0].days_in_stage : 0,
      client_typed: cards.length > 0 && cards.every((card) => card.ball_with === 'client'),
      cards,
    };
  });
}

// ── V3: stuck list ─────────────────────────────────────────────────────────

/** How badly one row needs attention: red first, then past deadline, then amber. */
function severity(row: EnrichedRow): number {
  if (row.rag === 'red') return 0;
  if (row.past_internal_deadline) return 1;
  return 2;
}

/**
 * The stuck list (V3): every amber or red row, plus green ones past their
 * internal deadline, worst first (red, then past deadline, then amber; within
 * a tier by days_over descending).
 */
export function stuckList(rows: EnrichedRow[]): EnrichedRow[] {
  return rows
    .filter((row) => row.rag !== 'green' || row.past_internal_deadline)
    .sort((a, b) => severity(a) - severity(b) || b.days_over - a.days_over);
}

// ── V5: waiting on client ──────────────────────────────────────────────────

/** The waiting-on-client list (V5): ball_with 'client', oldest first. */
export function waitingOnClient(rows: EnrichedRow[]): EnrichedRow[] {
  return rows
    .filter((row) => row.ball_with === 'client')
    .sort((a, b) => b.days_in_stage - a.days_in_stage);
}

// ── V4: person workload ────────────────────────────────────────────────────

/** One td_people row, keyed by actor_type + ':' + id like assignee_actors. */
export interface PersonLite {
  actor_type: string;
  id: number | string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** One assignee's row on the workload view (V4). */
export interface WorkloadRow {
  /** An actor string like 'Employee:12', or 'unassigned'. */
  person: string;
  name: string;
  active_jobs: number;
  firm_jobs: number;
  client_jobs: number;
  stuck: number;
  critical: number;
  past_internal_deadline: number;
}

/**
 * The display name for an actor string: td_people's display_name, else first
 * and last name, else the actor string itself.
 */
export function displayName(actor: string, people: PersonLite[]): string {
  const person = people.find((p) => `${p.actor_type}:${String(p.id)}` === actor);
  if (!person) return actor;
  if (person.display_name) return person.display_name;
  const full = [person.first_name, person.last_name].filter(Boolean).join(' ');
  return full || actor;
}

/**
 * The workload per assignee (V4): a job counts for each of its assignees, and
 * under 'unassigned' when it has none. Sorted by stuck desc, active_jobs
 * desc, then name.
 */
export function personWorkload(rows: EnrichedRow[], people: PersonLite[]): WorkloadRow[] {
  const byPerson = new Map<string, WorkloadRow>();
  const bucket = (actor: string): WorkloadRow => {
    let agg = byPerson.get(actor);
    if (!agg) {
      agg = {
        person: actor,
        name: displayName(actor, people),
        active_jobs: 0,
        firm_jobs: 0,
        client_jobs: 0,
        stuck: 0,
        critical: 0,
        past_internal_deadline: 0,
      };
      byPerson.set(actor, agg);
    }
    return agg;
  };
  for (const row of rows) {
    for (const actor of row.assignee_actors.length ? row.assignee_actors : ['unassigned']) {
      const agg = bucket(actor);
      agg.active_jobs++;
      if (row.ball_with === 'firm') agg.firm_jobs++;
      if (row.ball_with === 'client') agg.client_jobs++;
      if (row.rag === 'amber' || row.rag === 'red') agg.stuck++;
      if (row.rag === 'red') agg.critical++;
      if (row.past_internal_deadline) agg.past_internal_deadline++;
    }
  }
  return [...byPerson.values()].sort(
    (a, b) =>
      b.stuck - a.stuck ||
      b.active_jobs - a.active_jobs ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

// ── V6: aging chart ────────────────────────────────────────────────────────

/** One point on a stage's aging scatter (V6). */
export interface AgingPoint {
  job_id: number | string;
  job_name: string | null;
  days_in_stage: number;
  rag: Rag;
}

/** One stage's aging chart series (V6): its thresholds and its points. */
export interface AgingStage {
  stage_id: number | string;
  stage_title: string;
  stuck: number;
  critical: number;
  points: AgingPoint[];
}

/**
 * The aging chart data (V6, for the board page): one series per stage in
 * stage_order, thresholds from the first row in the stage (they are the same
 * for every row of a stage) or from effectiveThresholds({ stage_limit_days })
 * when the stage has no rows.
 */
export function agingPoints(rows: EnrichedRow[], stages: StageLite[]): AgingStage[] {
  return [...stages].sort(stageOrder).map((stage) => {
    const inStage = rows.filter((row) => String(row.stage_id) === String(stage.id));
    const first = inStage[0];
    const thresholds = first
      ? { stuck: first.stuck, critical: first.critical }
      : effectiveThresholds({ stage_limit_days: stage.stage_limit_days });
    return {
      stage_id: stage.id,
      stage_title: stage.title,
      stuck: thresholds.stuck,
      critical: thresholds.critical,
      points: inStage.map((row) => ({
        job_id: row.job_id,
        job_name: row.job_name,
        days_in_stage: row.days_in_stage,
        rag: row.rag,
      })),
    };
  });
}

// ── V1 / V7: weekly flow ───────────────────────────────────────────────────

/** One job_events row, reduced to what the weekly flow counts. */
export interface EventLite {
  event_type: string;
  /** ISO timestamp; only the UTC date part is read. */
  at: string;
}

/** One week of the arrivals / completions chart (V1 and V7). */
export interface WeekRow {
  /** The week's Monday, YYYY-MM-DD. */
  week_start: string;
  arrivals: number;
  completions: number;
}

/** The Monday (UTC) of the week a YYYY-MM-DD date falls in. */
function weekStart(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`) - ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The weekly arrivals and completions (V1's sparkline and V7's flow chart):
 * exactly `weeks` buckets of Monday-starting weeks (UTC), ending with the
 * week containing today, oldest first; weeks with no events are zero rows;
 * events outside the window and other event types are ignored. Completions
 * count both 'completed' and 'archived' events: which of the two is the
 * throughput measure is plan open question M5, so both are kept until it is
 * settled.
 */
export function weeklyFlow(events: EventLite[], today: string, weeks = 13): WeekRow[] {
  const rows: WeekRow[] = [];
  const endMs = Date.parse(`${weekStart(today)}T00:00:00Z`);
  for (let i = weeks - 1; i >= 0; i--) {
    rows.push({
      week_start: new Date(endMs - i * 7 * 86_400_000).toISOString().slice(0, 10),
      arrivals: 0,
      completions: 0,
    });
  }
  const index = new Map(rows.map((row, i) => [row.week_start, i]));
  for (const event of events) {
    const i = index.get(weekStart(String(event.at).slice(0, 10)));
    if (i === undefined) continue;
    if (event.event_type === 'new') rows[i].arrivals++;
    else if (event.event_type === 'completed' || event.event_type === 'archived') rows[i].completions++;
  }
  return rows;
}

// ── V7: cumulative flow ────────────────────────────────────────────────────

/** One job_snapshots-per-stage-and-date count, as loadCumulativeFlow returns. */
export interface CfdRow {
  snapshot_date: string;
  stage_title: string;
  stage_order: number | null;
  n: number;
}

/** The cumulative flow diagram's data (V7): dates, stages, one series per stage. */
export function cumulativeFlow(rows: CfdRow[]): { dates: string[]; stages: string[]; series: Record<string, number[]> } {
  const dates = [...new Set(rows.map((row) => row.snapshot_date))].sort();
  const stages = [...new Map(rows.map((row) => [row.stage_title, row] as [string, CfdRow])).values()]
    .sort(byStageOrder<CfdRow>((row) => row.stage_title))
    .map((row) => row.stage_title);
  const series: Record<string, number[]> = {};
  for (const stage of stages) series[stage] = dates.map(() => 0);
  for (const row of rows) {
    const i = dates.indexOf(row.snapshot_date);
    if (i >= 0) series[row.stage_title][i] = row.n;
  }
  return { dates, stages, series };
}

// ── V8: cycle time ─────────────────────────────────────────────────────────

/** One 7-day bucket of the cycle-time histogram (V8). */
export interface CycleBucket {
  from: number;
  to: number;
  n: number;
}

/** The cycle-time summary (V8): count, median, 85th percentile, histogram. */
export interface CycleStats {
  count: number;
  median: number | null;
  p85: number | null;
  histogram: CycleBucket[];
}

/**
 * Cycle-time statistics (V8) over completed jobs' intake-to-completion days.
 * Median and p85 use the nearest-rank method on the sorted values; the
 * histogram buckets 7 days at a time from 0 up to the max. With no values,
 * median and p85 are null and the histogram is empty.
 */
export function cycleStats(days: number[]): CycleStats {
  const count = days.length;
  if (count === 0) return { count: 0, median: null, p85: null, histogram: [] };
  const sorted = [...days].sort((a, b) => a - b);
  const nearestRank = (pct: number): number => sorted[Math.ceil((pct / 100) * count) - 1];
  const max = sorted[count - 1];
  const histogram: CycleBucket[] = [];
  for (let from = 0; from <= max; from += 7) {
    const to = from + 6;
    histogram.push({ from, to, n: days.filter((d) => d >= from && d <= to).length });
  }
  return { count, median: nearestRank(50), p85: nearestRank(85), histogram };
}

/** One stage's average dwell, as loadStageDwell returns. */
export interface StageDwellRow {
  stage_title: string;
  stage_order: number | null;
  avg_days: number;
  n: number;
}

/** The stage dwell table (V6/V8 context): rows sorted by stage_order, nulls last, then title. */
export function stageDwell(rows: StageDwellRow[]): StageDwellRow[] {
  return [...rows].sort(byStageOrder<StageDwellRow>((row) => row.stage_title));
}

// ── Loaders ────────────────────────────────────────────────────────────────

/** One td_pipelines row as the overview's pipeline picker needs it. */
export interface PipelineLite {
  id: number | string;
  title: string;
}

/** The pipeline picker's list (V1): id and title, ordered by title. */
export async function loadPipelines(db: Db): Promise<PipelineLite[]> {
  return (await db.query('select id, title from td_pipelines order by title')) as PipelineLite[];
}

/** One pipeline's stages (V2, V6): ordered by stage_order, nulls last, then title. */
export async function loadStages(db: Db, pipelineId: number | string): Promise<StageLite[]> {
  return (await db.query(
    'select id, pipeline_id, title, stage_order, stage_limit_days from td_pipeline_stages where pipeline_id = $1::bigint order by stage_order asc nulls last, title',
    [pipelineId]
  )) as StageLite[];
}

/** td_people as the workload view needs it (V4, and digests elsewhere). */
export async function loadPeople(db: Db): Promise<PersonLite[]> {
  return (await db.query(
    'select actor_type, id, first_name, last_name, display_name from td_people'
  )) as PersonLite[];
}

/** The events the weekly flow counts (V1, V7) from sinceDate on. */
export async function loadWeeklyEvents(db: Db, sinceDate: string): Promise<EventLite[]> {
  return (await db.query(
    "select event_type, at::text as at from job_events where event_type in ('new', 'completed', 'archived') and at >= $1::date",
    [sinceDate]
  )) as EventLite[];
}

/** Snapshot counts per date and stage (V7) from sinceDate on. */
export async function loadCumulativeFlow(db: Db, sinceDate: string): Promise<CfdRow[]> {
  return (await db.query(
    `select s.snapshot_date::text, ps.title as stage_title, ps.stage_order, count(*)::int as n
     from job_snapshots s
     join td_pipeline_stages ps on ps.id = s.stage_id
     where s.snapshot_date >= $1::date
     group by 1, 2, 3
     order by 1`,
    [sinceDate]
  )) as CfdRow[];
}

/** One completed job's cycle: days from intake to completion (V8). */
export interface CycleRow {
  job_id: number | string;
  pipeline_id: number | string;
  cycle_days: number;
}

/** Completed jobs' intake-to-completion days, latest snapshot per job (V8). */
export async function loadCycleRows(db: Db): Promise<CycleRow[]> {
  return (await db.query(
    `with latest as (select distinct on (job_id) * from job_snapshots order by job_id, captured_at desc)
     select l.job_id, l.pipeline_id, (l.completed_at::date - l.intake_date) as cycle_days
     from latest l
     where l.completed_at is not null and l.intake_date is not null`
  )) as CycleRow[];
}

/** Average dwell per stage over closed intervals (V6's context table). */
export async function loadStageDwell(db: Db): Promise<StageDwellRow[]> {
  return (await db.query(
    `select ps.title as stage_title, ps.stage_order, round(avg(si.days))::int as avg_days, count(*)::int as n
     from stage_intervals si
     join td_pipeline_stages ps on ps.id = si.stage_id
     where si.exited_at is not null
     group by 1, 2`
  )) as StageDwellRow[];
}

// ── Job detail ─────────────────────────────────────────────────────────────

/** One history row of the job detail's timeline. */
export interface JobHistoryRow {
  snapshot_date: string;
  stage_title: string;
  days_in_stage: number;
  source: string;
}

/** One job_events row with stage titles in place of ids. */
export interface JobEventRow {
  id: number;
  event_type: string;
  at: string;
  from_stage: string | null;
  to_stage: string | null;
  detail: Record<string, unknown> | null;
}

/** One stage_intervals row with the stage's title. */
export interface JobIntervalRow {
  stage_title: string;
  entered_at: string;
  exited_at: string | null;
  days: number | null;
}

/** One alerts_log row for the job, as the detail page lists them. */
export interface JobAlertRow {
  id: number;
  alert_type: string;
  level: string;
  status: string;
  opened_at: string;
  snoozed_until: string | null;
  snooze_reason: string | null;
  resolved_at: string | null;
}

/** Everything the job detail view shows. */
export interface JobDetail {
  latest: ViewRow;
  history: JobHistoryRow[];
  events: JobEventRow[];
  intervals: JobIntervalRow[];
  alerts: JobAlertRow[];
}

/**
 * One job's full detail: the latest snapshot (via the same CTE and joins as
 * loadViewRows, activeOnly false), its snapshot history, its events, its
 * stage intervals and its alerts. Null when the job has no snapshot at all.
 */
export async function loadJobDetail(db: Db, jobId: number | string): Promise<JobDetail | null> {
  const { text, params } = viewRowsSql({ activeOnly: false, jobId });
  const [latest] = (await db.query(text, params)) as ViewRow[];
  if (!latest) return null;
  const [history, events, intervals, alerts] = await Promise.all([
    db.query(
      `select s.snapshot_date::text, ps.title as stage_title, s.days_in_stage, s.source::text as source
       from job_snapshots s
       join td_pipeline_stages ps on ps.id = s.stage_id
       where s.job_id = $1::bigint
       order by s.snapshot_date desc
       limit 90`,
      [jobId]
    ),
    db.query(
      `select e.id, e.event_type, e.at::text, fps.title as from_stage, tps.title as to_stage, e.detail
       from job_events e
       left join td_pipeline_stages fps on fps.id = e.from_stage_id
       left join td_pipeline_stages tps on tps.id = e.to_stage_id
       where e.job_id = $1::bigint
       order by e.at desc`,
      [jobId]
    ),
    db.query(
      `select ps.title as stage_title, si.entered_at::text, si.exited_at::text, si.days
       from stage_intervals si
       join td_pipeline_stages ps on ps.id = si.stage_id
       where si.job_id = $1::bigint
       order by si.entered_at`,
      [jobId]
    ),
    db.query(
      `select id, alert_type, level, status, opened_at::text, snoozed_until::text, snooze_reason, resolved_at::text
       from alerts_log
       where job_id = $1::bigint
       order by opened_at desc`,
      [jobId]
    ),
  ]);
  return {
    latest,
    history: history as JobHistoryRow[],
    events: events as JobEventRow[],
    intervals: intervals as JobIntervalRow[],
    alerts: alerts as JobAlertRow[],
  };
}
