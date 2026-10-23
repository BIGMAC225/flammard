// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally —
// every relative import here carries its .ts extension, and db.ts (whose
// './env' import node cannot resolve) is only imported inside the DB
// functions at the bottom, which the tests never call.
//
// The fulfillment rules runner and alerts (implementation plan, section J
// step 9; the rules are plan section H). Two entry points share one
// evaluation: the daily scheduled function netlify/functions/fulfillment-
// rules.mts, and the guarded after-import call in src/lib/fulfillment-poll.ts
// and src/lib/fulfillment-csv-import.ts. The pure core — thresholds, per-job
// evaluation, data health, reconciliation, digest building — reads nothing
// and writes nothing, so every branch is testable without Postgres:
//   node --test tests/fulfillment-rules.test.mjs
// runFulfillmentRules is the thin DB wrapper: load the inputs, evaluate,
// apply the reconciliation plan in one transaction, build the digests and
// deliver them.

import type { NeonQueryFunction, NeonQueryInTransaction } from '@neondatabase/serverless';
import { env } from './env.ts';
import { firmDate } from './taxdome-date.ts';

const BATCH = 200;

export type Db = NeonQueryFunction<false, false>;

export type AlertType =
  | 'stuck'
  | 'critical'
  | 'past_internal_deadline'
  | 'due_soon'
  | 'no_snapshot'
  | 'row_count_drop'
  | 'unknown_stage';

export type AlertLevel = 'stuck' | 'critical' | 'escalated';

/** What the rules say one alerts_log row should be (job_id null = data health). */
export interface Desired {
  job_id: number | null;
  alert_type: AlertType;
  level: AlertLevel;
  detail: Record<string, unknown> | null;
}

// ── Pure core ─────────────────────────────────────────────────────────────

/** The stall-rule inputs one stage carries (nulls allowed: not configured). */
export interface StallThresholds {
  stage_limit_days?: number | null;
  stuck_days?: number | null;
  critical_days?: number | null;
}

/**
 * Plan section H: the TaxDome stage limit wins for the stuck threshold; with
 * no limit the mapped stage type's stall_rules row is used (its stuck_days,
 * or 7 for the 'unmapped' fallback); critical never falls at or below stuck.
 */
export function effectiveThresholds(rule: StallThresholds): { stuck: number; critical: number } {
  const stuck = rule.stage_limit_days ?? rule.stuck_days ?? 7;
  const critical = Math.max(rule.critical_days ?? stuck + 3, stuck + 1);
  return { stuck, critical };
}

/** One job's latest snapshot plus the stall rule its stage resolves to. */
export interface EvalRow {
  job_id: number;
  pipeline_id: number;
  stage_id: number;
  snapshot_date: string;
  days_in_stage: number;
  due_date: string | null;
  internal_deadline: string | null;
  kind: string;
  /** The mapped stage type, or 'unmapped' when stage_type_map has no row (it is empty today). */
  stage_type: string;
  ball_with: string;
  stage_limit_days: number | null;
  stuck_days: number | null;
  critical_days: number | null;
  assignee_actors: string[];
}

/** Whole days from one YYYY-MM-DD date to another (to minus from). */
function dayDiff(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * Plan section H's per-job rules. Returns nothing for non-active jobs and
 * for stages mapped to a stall_rules row with ball_with 'excluded'. A stall
 * alert is critical past the critical threshold, else stuck (escalated once
 * it has run stuck + 3 days) — critical replaces stuck, it never sits next
 * to it. Past-internal-deadline and due-soon are independent of the stall
 * clock and can stack on top of it. `today` is part of the runner's clock
 * (the stall age arrives precomputed in days_in_stage, the deadlines compare
 * against snapshot_date), kept in the signature for the calls that share it.
 */
export function evaluateJob(job: EvalRow, today: string): Desired[] {
  if (job.kind !== 'active' || job.ball_with === 'excluded') return [];
  const { stuck, critical } = effectiveThresholds(job);
  const days = job.days_in_stage;
  const detail = {
    days_in_stage: days,
    stuck,
    critical,
    ball_with: job.ball_with,
    stage_type: job.stage_type,
    due_date: job.due_date,
    internal_deadline: job.internal_deadline,
  };
  const alerts: Desired[] = [];
  if (days >= critical) {
    alerts.push({ job_id: job.job_id, alert_type: 'critical', level: 'critical', detail });
  } else if (days >= stuck) {
    alerts.push({
      job_id: job.job_id,
      alert_type: 'stuck',
      level: days >= stuck + 3 ? 'escalated' : 'stuck',
      detail,
    });
  }
  if (job.internal_deadline != null && job.internal_deadline < job.snapshot_date) {
    alerts.push({ job_id: job.job_id, alert_type: 'past_internal_deadline', level: 'critical', detail });
  }
  // The plan's SQL compared ball_with to 'client_review_sign', but that value
  // is a stage_type, not a ball_with: the due-soon override is "due within 14
  // days AND the stage type is not client_review_sign" (the client-review
  // stage chases by its own clock, so no firm-side due-soon nagging).
  if (job.due_date != null && dayDiff(job.snapshot_date, job.due_date) <= 14 && job.stage_type !== 'client_review_sign') {
    alerts.push({ job_id: job.job_id, alert_type: 'due_soon', level: 'critical', detail });
  }
  return alerts;
}

/** An import_runs row, reduced to what the data-health rules read. */
export interface ImportRunLite {
  snapshot_date: string | null;
  jobs_written: number | null;
  detail: Record<string, unknown> | null;
}

/** The data-health rules' inputs: today's and yesterday's ok runs, and the latest run of any status. */
export interface DataHealthInput {
  today: string;
  yesterday: string;
  todayOk: ImportRunLite | null;
  yesterdayOk: ImportRunLite | null;
  latestRun: ImportRunLite | null;
}

/**
 * Plan section H's data-health alerts (job_id null, always level critical):
 * no ok run for today, today's row count at least 20% below yesterday's, or
 * unknown stages in the latest run's detail (stage ids for API runs, stage
 * names for CSV runs).
 */
export function evaluateDataHealth(input: DataHealthInput): Desired[] {
  const alerts: Desired[] = [];
  if (!input.todayOk) {
    alerts.push({ job_id: null, alert_type: 'no_snapshot', level: 'critical', detail: { today: input.today } });
  }
  const todayRows = input.todayOk?.jobs_written;
  const yesterdayRows = input.yesterdayOk?.jobs_written;
  if (
    todayRows != null && yesterdayRows != null &&
    todayRows < 0.8 * yesterdayRows
  ) {
    alerts.push({
      job_id: null,
      alert_type: 'row_count_drop',
      level: 'critical',
      detail: { today_jobs_written: todayRows, yesterday_jobs_written: yesterdayRows },
    });
  }
  const detail = input.latestRun?.detail ?? null;
  const unknownStageIds = Array.isArray(detail?.unknown_stage_ids) ? detail!.unknown_stage_ids as unknown[] : [];
  const unknownStages = Array.isArray(detail?.unknown_stages) ? detail!.unknown_stages as unknown[] : [];
  if (unknownStageIds.length || unknownStages.length) {
    alerts.push({
      job_id: null,
      alert_type: 'unknown_stage',
      level: 'critical',
      detail: { unknown_stage_ids: unknownStageIds, unknown_stages: unknownStages },
    });
  }
  return alerts;
}

/** One alerts_log row that is open or snoozed, as reconciliation sees it. */
export interface AlertRow {
  id: number;
  job_id: number | null;
  alert_type: AlertType;
  level: AlertLevel;
  status: 'open' | 'snoozed';
  snoozed_until: string | null;
}

/** What the wrapper must write to make alerts_log match the desired set. */
export interface ReconcilePlan {
  open: Desired[];
  resolve: number[];
  relevel: { id: number; level: AlertLevel }[];
  unsnooze: number[];
}

/** stuck < escalated < critical: relevels only ever move a row up. */
const LEVEL_RANK: Record<AlertLevel, number> = { stuck: 0, escalated: 1, critical: 2 };

const alertKey = (jobId: number | null, alertType: AlertType): string => `${jobId ?? 'none'}|${alertType}`;

/**
 * The desired set against the open-and-snoozed rows (plan section H): new
 * desired alerts open, existing ones no longer desired resolve (snoozed or
 * not), open rows whose desired level is higher relevel upward only — an
 * escalated row is never downgraded while the condition holds — and a
 * snoozed row whose snoozed_until is before today goes back to open when it
 * is still desired (the resolve rule already catches it when it is not).
 * `now` is applied by the wrapper as the opened_at / resolved_at stamp.
 */
export function reconcileAlerts(desired: Desired[], existing: AlertRow[], now: Date, today: string): ReconcilePlan {
  const desiredKeys = new Set(desired.map((d) => alertKey(d.job_id, d.alert_type)));
  const byKey = new Map(existing.map((row) => [alertKey(row.job_id, row.alert_type), row]));
  const plan: ReconcilePlan = { open: [], resolve: [], relevel: [], unsnooze: [] };
  for (const d of desired) {
    const row = byKey.get(alertKey(d.job_id, d.alert_type));
    if (!row) {
      plan.open.push(d);
      continue;
    }
    if (row.status === 'snoozed' && row.snoozed_until != null && row.snoozed_until < today) {
      plan.unsnooze.push(row.id);
    }
    if (row.status === 'open' && LEVEL_RANK[d.level] > LEVEL_RANK[row.level]) {
      plan.relevel.push({ id: row.id, level: d.level });
    }
  }
  for (const row of existing) {
    if (!desiredKeys.has(alertKey(row.job_id, row.alert_type))) plan.resolve.push(row.id);
  }
  return plan;
}

// ── Digests ───────────────────────────────────────────────────────────────

/** One open or snoozed alert, joined to the names the digest shows. */
export interface DigestAlert {
  id: number;
  job_id: number | null;
  job_name: string | null;
  account_name: string | null;
  pipeline_title: string | null;
  stage_title: string | null;
  alert_type: AlertType;
  level: AlertLevel;
  status: 'open' | 'snoozed';
  opened_at: string | Date;
  last_notified_at: string | Date | null;
  snoozed_until: string | null;
  days_in_stage: number | null;
  days_over: number | null;
  due_date: string | null;
  ball_with: string | null;
  assignee_actors: string[];
}

/** The firm-wide numbers every digest carries (snoozed alerts still count here). */
export interface DigestSummary {
  stuck_count: number;
  critical_count: number;
  wip_in_review: number;
  oldest_in_review_days: number | null;
}

/** One assignee's digest (or the 'unassigned' / 'leadership' buckets). */
export interface Digest {
  /** An actor key like 'Employee:12', or 'unassigned' / 'leadership'. */
  to: string;
  display_name: string | null;
  email: string | null;
  summary: DigestSummary;
  critical: DigestAlert[];
  newly_stuck: DigestAlert[];
  still_stuck: DigestAlert[];
  client_chases: DigestAlert[];
  data_health: DigestAlert[];
}

export interface DigestInput {
  today: string;
  alerts: DigestAlert[];
  people: Map<string, { display_name: string | null; email: string | null }>;
  summary: DigestSummary;
}

/** The calendar day of an instant (firm-local) or the date part of a date string. */
const dayOf = (value: string | Date): string => (value instanceof Date ? firmDate(value) : String(value).slice(0, 10));

/** The section that carries the alert: critical class, or a stuck escalation. */
export const isCriticalClass = (a: DigestAlert): boolean =>
  a.alert_type === 'critical' ||
  a.alert_type === 'past_internal_deadline' ||
  a.alert_type === 'due_soon' ||
  a.level === 'escalated';

/**
 * One digest per actor that has at least one non-empty section, plus
 * 'unassigned' for alerts whose job has no assignees (plan section H).
 * Snoozed alerts are left out of every section — they still count in the
 * summary, which every digest carries as-is. Data-health alerts (job_id
 * null) only ever reach the data_health array of the 'leadership' digest.
 */
export function buildDigests(input: DigestInput): Digest[] {
  const buckets = new Map<string, Digest>();
  const bucket = (to: string): Digest => {
    let digest = buckets.get(to);
    if (!digest) {
      const person = input.people.get(to);
      digest = {
        to,
        display_name: person?.display_name ?? null,
        email: person?.email ?? null,
        summary: input.summary,
        critical: [],
        newly_stuck: [],
        still_stuck: [],
        client_chases: [],
        data_health: [],
      };
      buckets.set(to, digest);
    }
    return digest;
  };
  for (const alert of input.alerts) {
    if (alert.status === 'snoozed') continue; // out of every section, still in the summary
    if (alert.job_id == null) {
      bucket('leadership').data_health.push(alert);
      continue;
    }
    // An unassigned job's alerts all land in the shared 'unassigned' digest
    for (const to of alert.assignee_actors.length ? alert.assignee_actors : ['unassigned']) {
      const digest = bucket(to);
      if (isCriticalClass(alert)) digest.critical.push(alert);
      if (alert.alert_type === 'stuck') {
        (dayOf(alert.opened_at) === input.today ? digest.newly_stuck : digest.still_stuck).push(alert);
      }
      if (alert.ball_with === 'client') digest.client_chases.push(alert);
    }
  }
  return [...buckets.values()];
}

// ── The DB runner ─────────────────────────────────────────────────────────

export type RulesMode = 'daily' | 'after-import';

export interface RulesOptions {
  mode: RulesMode;
  /** The import run to stamp alerts_opened on (after-import mode). */
  runId?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface RulesResult {
  opened: number;
  resolved: number;
  releveled: number;
  unsnoozed: number;
  digests: Digest[];
  instant: DigestAlert[];
  posted: boolean;
}

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

/** yesterday (+ n days) of a YYYY-MM-DD string, staying on the UTC calendar. */
function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The alert types the after-import instant delivery sends, most severe first. */
const INSTANT_ORDER: Partial<Record<AlertType, number>> = {
  critical: 0,
  past_internal_deadline: 1,
  due_soon: 2,
  no_snapshot: 3,
  row_count_drop: 4,
  unknown_stage: 5,
};

/**
 * One rules pass (plan section J step 9): evaluate the latest snapshot per
 * job and the data health, reconcile with alerts_log, apply the plan in one
 * transaction, then deliver — daily: one POST of every digest; after-import:
 * one POST of the critical-class alerts not yet notified today (skipped when
 * empty). A delivery failure is logged, never thrown: the alerts stay open
 * and unnotified, so the next pass retries.
 */
export async function runFulfillmentRules(options: RulesOptions): Promise<RulesResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const today = firmDate(now);
  const yesterday = shiftDay(today, -1);
  const { many, sql } = await import('./db.ts');
  const db = sql();

  // 1. The latest snapshot per active job, with the stall rule its stage
  // resolves to. stage_type_map is empty today, so coalesce gives every stage
  // the 'unmapped' stall_rules row (stuck 7, critical 10, ball_with firm)
  // until Russell fills it; stages mapped to 'on_hold' come back excluded.
  const rows = await many<EvalRow>(
    db.query(`
      with latest as (select distinct on (job_id) * from job_snapshots order by job_id, captured_at desc)
      select l.job_id, l.pipeline_id, l.stage_id, l.snapshot_date, l.days_in_stage, l.due_date,
        l.internal_deadline, l.assignee_actors, st.kind,
        coalesce(m.stage_type, 'unmapped') as stage_type,
        coalesce(sr.ball_with, 'firm') as ball_with,
        ps.stage_limit_days, sr.stuck_days, sr.critical_days
      from latest l
      join td_pipeline_stages ps on ps.id = l.stage_id
      left join td_job_statuses st on st.id = l.status_id
      left join stage_type_map m on m.stage_id = l.stage_id
      left join stall_rules sr on sr.stage_type = coalesce(m.stage_type, 'unmapped')
      where st.kind = 'active'`)
  );

  // 2. What the rules want open: one Desired per job alert, plus data health
  const desired = rows.flatMap((row) => evaluateJob(row, today));
  const okRun = (day: string) =>
    many<ImportRunLite>(
      db.query(
        'select snapshot_date, jobs_written, detail from import_runs where status = \'ok\' and snapshot_date = $1::date order by id desc limit 1',
        [day]
      )
    );
  const latestRun = await many<ImportRunLite>(
    db.query('select snapshot_date, jobs_written, detail from import_runs order by id desc limit 1')
  );
  desired.push(
    ...evaluateDataHealth({
      today,
      yesterday,
      todayOk: (await okRun(today))[0] ?? null,
      yesterdayOk: (await okRun(yesterday))[0] ?? null,
      latestRun: latestRun[0] ?? null,
    })
  );

  // 3. Reconcile with what is open or snoozed, and apply in one transaction
  const existing = await many<AlertRow>(
    db.query('select id, job_id, alert_type, level, status, snoozed_until from alerts_log where status in (\'open\', \'snoozed\')')
  );
  const plan = reconcileAlerts(desired, existing, now, today);

  const statements: Statement[] = [];
  for (const batch of chunk(plan.open)) {
    const { values, params } = valuesSql(
      batch.map((d) => [d.job_id, d.alert_type, d.level, 'open', now, d.detail == null ? null : JSON.stringify(d.detail)]),
      ['::bigint', '', '', '', '::timestamptz', '::jsonb']
    );
    statements.push({
      text: `insert into alerts_log (job_id, alert_type, level, status, opened_at, detail) values ${values}`,
      params,
    });
  }
  if (plan.resolve.length) {
    statements.push({
      text: 'update alerts_log set status = $1, resolved_at = $2::timestamptz where id = any($3::bigint[])',
      params: ['resolved', now, plan.resolve],
    });
  }
  for (const batch of chunk(plan.relevel)) {
    const { values, params } = valuesSql(batch.map((r) => [r.id, r.level]), ['::bigint', '']);
    statements.push({
      text: `update alerts_log as a set level = v.level from (values ${values}) as v(id, level) where a.id = v.id`,
      params,
    });
  }
  if (plan.unsnooze.length) {
    statements.push({
      text: 'update alerts_log set status = $1, snoozed_until = null, snooze_reason = null where id = any($2::bigint[])',
      params: ['open', plan.unsnooze],
    });
  }
  if (statements.length) {
    // The d.ts wants NeonQueryInTransaction[]; tx.query's promises carry the
    // query data at runtime and are all sent as one transaction
    await db.transaction((tx) =>
      statements.map(({ text, params }) => tx.query(text, params)) as unknown as NeonQueryInTransaction[]
    );
  }

  // 4. The digests: every open and snoozed alert (buildDigests leaves the
  // snoozed out of the sections; they still count in the summary) with the
  // names of the jobs they point at, and the people who get a digest
  const alertRows = await many<{
    id: number;
    job_id: number | null;
    alert_type: AlertType;
    level: AlertLevel;
    status: 'open' | 'snoozed';
    opened_at: Date;
    last_notified_at: Date | null;
    snoozed_until: string | null;
    detail: Record<string, unknown> | null;
  }>(
    db.query(
      'select id, job_id, alert_type, level, status, opened_at, last_notified_at, snoozed_until, detail from alerts_log where status in (\'open\', \'snoozed\')'
    )
  );
  const alertJobIds = [...new Set(alertRows.filter((r) => r.job_id != null).map((r) => r.job_id as number))];
  const displayRows = alertJobIds.length
    ? await many<{
        job_id: number;
        job_name: string | null;
        days_in_stage: number;
        due_date: string | null;
        assignee_actors: string[];
        account_name: string | null;
        pipeline_title: string;
        stage_title: string;
      }>(
        db.query(
          `with latest as (select distinct on (job_id) * from job_snapshots order by job_id, captured_at desc)
          select l.job_id, l.job_name, l.days_in_stage, l.due_date, l.assignee_actors,
            c.account_name, p.title as pipeline_title, ps.title as stage_title
          from latest l
          join td_pipeline_stages ps on ps.id = l.stage_id
          join td_pipelines p on p.id = l.pipeline_id
          left join td_clients c on c.id = l.client_id
          where l.job_id = any($1::bigint[])`,
          [alertJobIds]
        )
      )
    : [];
  const display = new Map(displayRows.map((row) => [row.job_id, row]));
  const alerts: DigestAlert[] = alertRows.map((row) => {
    const snap = row.job_id != null ? display.get(row.job_id) : undefined;
    const detail = row.detail ?? {};
    const daysInStage = typeof detail.days_in_stage === 'number' ? detail.days_in_stage : snap?.days_in_stage ?? null;
    const stuck = typeof detail.stuck === 'number' ? detail.stuck : null;
    return {
      id: row.id,
      job_id: row.job_id,
      job_name: snap?.job_name ?? null,
      account_name: snap?.account_name ?? null,
      pipeline_title: snap?.pipeline_title ?? null,
      stage_title: snap?.stage_title ?? null,
      alert_type: row.alert_type,
      level: row.level,
      status: row.status,
      opened_at: row.opened_at,
      last_notified_at: row.last_notified_at,
      snoozed_until: row.snoozed_until,
      days_in_stage: daysInStage,
      days_over: daysInStage != null && stuck != null ? Math.max(0, daysInStage - stuck) : null,
      due_date: snap?.due_date ?? null,
      ball_with: typeof detail.ball_with === 'string' ? detail.ball_with : null,
      assignee_actors: snap?.assignee_actors ?? [],
    };
  });
  const peopleRows = await many<{ actor_type: string; id: number; display_name: string | null; email: string | null }>(
    db.query('select actor_type, id, display_name, email from td_people')
  );
  const people = new Map(peopleRows.map((p) => [`${p.actor_type}:${p.id}`, { display_name: p.display_name, email: p.email }]));
  const reviewRows = rows.filter((row) => row.stage_type === 'review');
  const summary: DigestSummary = {
    stuck_count: alerts.filter((a) => a.alert_type === 'stuck').length,
    critical_count: alerts.filter((a) => isCriticalClass(a)).length,
    wip_in_review: reviewRows.length,
    oldest_in_review_days: reviewRows.length ? Math.max(...reviewRows.map((r) => r.days_in_stage)) : null,
  };
  const digests = buildDigests({ today, alerts, people, summary });

  // 5. Delivery. company_settings.alerts_webhook_url is deferred (it needs a
  // schema change); when it lands it is read here, falling back to the env var.
  const webhook = env('ALERTS_WEBHOOK_URL');
  const instant: DigestAlert[] = [];
  let posted = false;
  if (!webhook) {
    console.log(`[fulfillment-rules] no ALERTS_WEBHOOK_URL, ${digests.length} digests not sent`);
  } else if (options.mode === 'daily') {
    try {
      const res = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: today, digests }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        posted = true;
        const notified = alerts.filter((a) => a.status === 'open').map((a) => a.id);
        if (notified.length) {
          await db.query('update alerts_log set last_notified_at = $1::timestamptz where id = any($2::bigint[])', [now, notified]);
        }
      } else {
        console.log(`[fulfillment-rules] webhook answered HTTP ${res.status}; digests not marked as notified`);
      }
    } catch (err) {
      console.log(`[fulfillment-rules] could not post the digests: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  } else {
    // After-import: only the critical-class alerts (by alert_type, so a
    // stuck escalation is not re-sent), one per job per day, data health
    // once per type; nothing was sent today for an alert already notified.
    const candidates = alerts
      .filter(
        (a) =>
          a.status === 'open' &&
          INSTANT_ORDER[a.alert_type] != null &&
          (a.last_notified_at == null || dayOf(a.last_notified_at) < today)
      )
      .sort((x, y) => (INSTANT_ORDER[x.alert_type] ?? 9) - (INSTANT_ORDER[y.alert_type] ?? 9));
    const sentToday = new Set<string>();
    for (const alert of candidates) {
      const key = alert.job_id != null ? `job:${alert.job_id}` : `dh:${alert.alert_type}`;
      if (sentToday.has(key)) continue;
      sentToday.add(key);
      instant.push(alert);
    }
    if (instant.length) {
      try {
        const res = await fetchImpl(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: today, instant }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          posted = true;
          await db.query('update alerts_log set last_notified_at = $1::timestamptz where id = any($2::bigint[])', [now, instant.map((a) => a.id)]);
        } else {
          console.log(`[fulfillment-rules] webhook answered HTTP ${res.status}; instant alerts not marked as notified`);
        }
      } catch (err) {
        console.log(`[fulfillment-rules] could not post the instant alerts: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  // 6. The run's own outcome, for the imports view
  if (options.mode === 'after-import' && options.runId != null) {
    await db.query('update import_runs set alerts_opened = $1::int where id = $2::bigint', [plan.open.length, options.runId]);
  }

  // 7. What happened, for the scheduled function's one log line
  return {
    opened: plan.open.length,
    resolved: plan.resolve.length,
    releveled: plan.relevel.length,
    unsnoozed: plan.unsnooze.length,
    digests,
    instant,
    posted,
  };
}

// ── Snooze helpers (for the views step) ───────────────────────────────────

/** Snoozes an open alert until the given date, keeping the reason. */
export async function snoozeAlert(id: number, until: string, reason: string): Promise<void> {
  const { sql } = await import('./db.ts');
  await sql()`update alerts_log set status = 'snoozed', snoozed_until = ${until}::date, snooze_reason = ${reason} where id = ${id} and status = 'open'`;
}

/** Returns a snoozed alert to open (the reason and expiry are cleared). */
export async function unsnoozeAlert(id: number): Promise<void> {
  const { sql } = await import('./db.ts');
  await sql()`update alerts_log set status = 'open', snoozed_until = null, snooze_reason = null where id = ${id} and status = 'snoozed'`;
}
