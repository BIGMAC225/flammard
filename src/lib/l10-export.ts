import { timingSafeEqual } from 'node:crypto';
// .ts extensions: tests load this module under plain Node (type stripping),
// which resolves relative imports literally
import { json } from './api.ts';
import { todayLocal } from './dates.ts';
import { many, one, sql } from './db.ts';
import { env } from './env.ts';
import { averageRating } from './l10.ts';
import { quarterOf } from './quarters.ts';
import { getSettings } from './settings.ts';
import { isTeam } from './teams.ts';

// The read-only weekly L10 export (GET /api/export/l10?team=<slug>), for the
// scheduled prep worker on the desktop: one JSON document with the team's
// Scorecard, current-quarter Rocks, open Issues, open To-Dos and the last
// meeting. No session; the caller sends `Authorization: Bearer <L10_EXPORT_TOKEN>`
// (same pattern as the TaxDome webhook). See docs/L10_EXPORT.md.
//
// handleL10Export holds the request logic, loadL10Data the queries and
// buildL10Export the shaping, so tests can cover auth and the payload shape
// without a database.

export const L10_EXPORT_TOKEN_ENV = 'L10_EXPORT_TOKEN';

/** Timing-safe bearer-token check; an unset expected token never matches. */
export function tokenMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;

/** The first number in a scorecard value ("5,000" → 5000, "98%" → 98), or null. */
export function toNumber(value: string | null): number | null {
  if (value == null || !value.trim()) return null;
  const m = NUMBER.exec(value);
  const n = m ? Number(m[0].replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Splits a metric's free-text goal into a number and a direction: "≥ 50000"
 * → { goal: 50000, goal_type: '>=' }, "10" → { goal: 10, goal_type: '=' }.
 * No leading number → both null.
 */
export function parseGoal(goal: string | null): { goal: number | null; goal_type: '>=' | '<=' | '=' | null } {
  const text = goal?.trim() ?? '';
  if (!text) return { goal: null, goal_type: null };
  const m = /^(>=|≥|<=|≤|=)?\s*(-?\d[\d,]*(?:\.\d+)?)/.exec(text);
  if (!m) return { goal: null, goal_type: null };
  const goalNumber = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(goalNumber)) return { goal: null, goal_type: null };
  const goalType = !m[1] || m[1] === '=' ? '=' : m[1] === '>=' || m[1] === '≥' ? '>=' : '<=';
  return { goal: goalNumber, goal_type: goalType };
}

// ── Payload types (the route's contract; see docs/L10_EXPORT.md) ───────────

export interface L10ExportEntry {
  week: string;
  value: number | null;
  met: boolean | null;
}

export interface L10ExportMetric {
  measurable: string;
  owner: string | null;
  goal: number | null;
  goal_type: '>=' | '<=' | '=' | null;
  unit: string | null;
  entries: L10ExportEntry[];
}

export interface L10ExportRock {
  title: string;
  owner: string | null;
  status: string;
  due: string | null;
  quarter: string | null;
  updated_at: string;
}

export interface L10ExportIssue {
  title: string;
  owner: string | null;
  priority: string | null;
  status: string;
  created_at: string;
}

export interface L10ExportTodo {
  title: string;
  owner: string | null;
  due: string | null;
  status: string;
  created_at: string;
  meeting_date: string | null;
}

export interface L10Export {
  generated_at: string;
  team: string;
  scorecard: L10ExportMetric[];
  rocks: L10ExportRock[];
  issues: L10ExportIssue[];
  todos: L10ExportTodo[];
  last_meeting: { date: string; rating: number | null; cascading_messages: string[] } | null;
  truncated?: boolean;
}

// ── The queries' rows (loadL10Data) ────────────────────────────────────────

export interface L10ExportRows {
  /** The firm quarter "today" falls in; a rock belongs to it by due date, else created date. */
  quarter: { label: string; start_date: string; end_date: string };
  metrics: Array<{ id: string; title: string; owner: string | null; goal: string | null; unit: string | null }>;
  entries: Array<{ metric_id: string; period_date: string; value: string | null; on_track: boolean | null }>;
  rocks: Array<{
    title: string;
    owner: string | null;
    status: string;
    quarter: string | null;
    due_date: string | null;
    level: string | null;
    created_at: string;
    updated_at: string;
  }>;
  issues: Array<{ title: string; owner: string | null; priority: string | null; created_at: string }>;
  todos: Array<{ title: string; owner: string | null; due_date: string | null; created_at: string; meeting_date: string | null }>;
  last_meeting: {
    date: string;
    meeting_rating: string | number | null;
    ratings: Array<{ rating: number }>;
    messages: Array<{ message: string; to_whom: string | null; by_whom: string | null; how: string | null }>;
  } | null;
}

/** timestamptz text from Postgres ("2026-10-24 13:39:00+00") as ISO 8601 UTC. */
const iso = (ts: string | null): string | null => {
  if (!ts) return null;
  // Postgres prints whole-hour offsets without minutes ("+00"), which the ISO
  // parser rejects; add the minutes back before parsing
  const t = Date.parse(ts.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(t) ? ts : new Date(t).toISOString();
};

const MAX_ROWS = 500;
const MAX_WEEKS = 13;

/** Shapes the queried rows into the export payload (pure). */
export function buildL10Export(team: string, rows: L10ExportRows): L10Export {
  let truncated = false;
  const cap = <T>(list: T[]): T[] => {
    if (list.length > MAX_ROWS) {
      truncated = true;
      return list.slice(0, MAX_ROWS);
    }
    return list;
  };

  // Entries arrive newest first; keep the newest 13 weeks per metric.
  const entriesByMetric = new Map<string, L10ExportEntry[]>();
  for (const e of rows.entries) {
    const list = entriesByMetric.get(e.metric_id) ?? [];
    if (list.length < MAX_WEEKS) {
      list.push({ week: e.period_date, value: toNumber(e.value), met: e.on_track ?? null });
      entriesByMetric.set(e.metric_id, list);
    }
  }

  // A rock belongs to the firm quarter its due date falls in (created date
  // when it has none) — the same rule as the Rocks page's "Quarter end" view.
  const inQuarter = (d: string) => rows.quarter.start_date <= d && d <= rows.quarter.end_date;

  const scorecard: L10ExportMetric[] = cap(
    rows.metrics.map((m) => {
      const { goal, goal_type } = parseGoal(m.goal);
      return {
        measurable: m.title,
        owner: m.owner ?? null,
        goal,
        goal_type,
        unit: m.unit ?? null,
        entries: entriesByMetric.get(m.id) ?? [],
      };
    })
  );

  const rocks: L10ExportRock[] = cap(
    rows.rocks
      .filter((r) => inQuarter((r.due_date ?? r.created_at.slice(0, 10))))
      .map((r) => ({
        title: r.title,
        owner: r.owner ?? null,
        status: r.status,
        due: r.due_date ?? null,
        quarter: r.quarter ?? rows.quarter.label,
        updated_at: iso(r.updated_at) ?? r.updated_at,
      }))
  );

  const issues: L10ExportIssue[] = cap(
    rows.issues.map((i) => ({
      title: i.title,
      owner: i.owner ?? null,
      priority: i.priority ?? null,
      status: 'open',
      created_at: iso(i.created_at) ?? i.created_at,
    }))
  );

  const todos: L10ExportTodo[] = cap(
    rows.todos.map((t) => ({
      title: t.title,
      owner: t.owner ?? null,
      due: t.due_date ?? null,
      status: 'open',
      created_at: iso(t.created_at) ?? t.created_at,
      meeting_date: t.meeting_date ?? null,
    }))
  );

  const last = rows.last_meeting;
  const payload: L10Export = {
    generated_at: new Date().toISOString(),
    team,
    scorecard,
    rocks,
    issues,
    todos,
    last_meeting: last
      ? {
          date: last.date,
          rating:
            averageRating(last.ratings) ?? (last.meeting_rating == null ? null : Number(last.meeting_rating)),
          cascading_messages: last.messages.map((m) =>
            [m.message, m.to_whom && `to ${m.to_whom}`, m.by_whom && `by ${m.by_whom}`, m.how && `via ${m.how}`]
              .filter(Boolean)
              .join(', ')
          ),
        }
      : null,
  };
  if (truncated) payload.truncated = true;
  return payload;
}

/** Runs the export's queries (read-only) and returns their rows. */
export async function loadL10Data(db: ReturnType<typeof sql>, team: string): Promise<L10ExportRows> {
  const quarter = quarterOf(todayLocal(), await getSettings());
  const [metrics, entries, rocks, issues, todos, lastMeeting] = await Promise.all([
    many<L10ExportRows['metrics'][number]>(
      db`select id, title, owner, goal, unit from scorecard_metrics where active and team = ${team} order by sort_order, created_at`
    ),
    many<L10ExportRows['entries'][number]>(db`
      select metric_id, period_date::text as period_date, value, on_track
      from (
        select e.*, row_number() over (partition by e.metric_id order by e.period_date desc) as rn
        from scorecard_entries e
        join scorecard_metrics m on m.id = e.metric_id
        where m.active and m.team = ${team}
      ) ranked
      where rn <= ${MAX_WEEKS}
      order by period_date desc
    `),
    many<L10ExportRows['rocks'][number]>(db`
      select title, owner, status, quarter, due_date::text as due_date, level,
             created_at::text as created_at, updated_at::text as updated_at
      from rocks where team = ${team}
      order by (level = 'company') desc nulls last, lower(coalesce(owner, '~')), lower(title), created_at
    `),
    many<L10ExportRows['issues'][number]>(db`
      select title, owner, priority, created_at::text as created_at
      from issues where team = ${team} and status = 'open'
      order by horizon, rank nulls last, created_at
    `),
    many<L10ExportRows['todos'][number]>(db`
      select t.title, t.owner, t.due_date::text as due_date, t.created_at::text as created_at,
             m.date::text as meeting_date
      from todos t left join meetings m on m.id = t.meeting_id
      where t.team = ${team} and t.status = 'open'
      order by t.created_at, t.id
    `),
    one<{ id: string; date: string; meeting_rating: string | number | null }>(db`
      select id, date::text as date, meeting_rating from meetings
      where team = ${team}
      order by date desc, created_at desc limit 1
    `),
  ]);

  let last_meeting: L10ExportRows['last_meeting'] = null;
  if (lastMeeting) {
    const [ratings, messages] = await Promise.all([
      many<{ rating: number }>(db`select rating from meeting_ratings where meeting_id = ${lastMeeting.id} order by sort_order, name`),
      many<NonNullable<L10ExportRows['last_meeting']>['messages'][number]>(
        db`select message, to_whom, by_whom, how from cascading_messages where meeting_id = ${lastMeeting.id} order by sort_order, created_at`
      ),
    ]);
    last_meeting = { date: lastMeeting.date, meeting_rating: lastMeeting.meeting_rating, ratings, messages };
  }

  return { quarter, metrics, entries, rocks, issues, todos, last_meeting };
}

/** The export payload for a team: loadL10Data shaped by buildL10Export. */
export async function l10ExportData(team: string): Promise<L10Export> {
  return buildL10Export(team, await loadL10Data(sql(), team));
}

// ── Request handling (used by src/pages/api/export/l10.ts) ─────────────────

export type L10ExportContext = { request: Request; url: URL };

/**
 * GET /api/export/l10?team=<slug>: auth, team check, then the payload as
 * `Cache-Control: no-store` JSON. `data` is injectable so tests can cover the
 * route without a database. Never logs the token.
 */
export async function handleL10Export(
  ctx: L10ExportContext,
  data: (team: string) => Promise<L10Export> = l10ExportData
): Promise<Response> {
  const token = env(L10_EXPORT_TOKEN_ENV);
  const provided = (ctx.request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!tokenMatches(provided, token)) return json({ error: 'unauthorized' }, 401);
  const team = ctx.url.searchParams.get('team');
  if (!isTeam(team)) return json({ error: 'unknown team' }, 400);
  console.log(`[l10-export] team=${team}`); // no secrets, same convention as the taxdome webhook
  return new Response(JSON.stringify(await data(team)), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
