import { many, one, sql } from './db';
import { teamLabel } from './teams';
import type { CascadingMessage, Issue, MeetingRating, MeetingRock, Todo } from '../types';

// The standing lists an L10 runs from (Rocks, To-dos, Issues) and the
// Conclude data (ratings, cascading messages). Shared by the meeting page,
// the meeting API routes and the five-line export so they all agree on what
// "this meeting's" rocks, to-dos and issues are:
//
//   rocks   — meeting_rocks rows for the meeting; copied from the team's
//             active rocks when the meeting is created (carryRocksIntoMeeting)
//   to-dos  — every open to-do of the team, plus the ones created or closed
//             in this meeting (done / not done review happens here)
//   issues  — the team's open short-term list in rank order, plus the ones
//             raised or solved in this meeting

export type TeamName = 'leadership' | 'management';

/**
 * Copies the team's active rocks (on/off track) into a meeting's rock list,
 * skipping any already there, so the review never starts blank. Company rocks
 * first, then by owner, then by title. Idempotent: safe to call again for a
 * meeting created before this existed. Returns how many were added.
 */
export async function carryRocksIntoMeeting(meetingId: string, team: string): Promise<number> {
  const rows = await sql()`
    insert into meeting_rocks (meeting_id, rock_id, title, owner, owner_id, status, source)
    select ${meetingId}, r.id, r.title, r.owner, r.owner_id, r.status, 'manual'
    from rocks r
    where r.team = ${team} and r.status in ('on_track', 'off_track')
      and not exists (select 1 from meeting_rocks mr where mr.meeting_id = ${meetingId} and mr.rock_id = r.id)
    order by (r.level = 'company') desc nulls last, lower(coalesce(r.owner, '~')), lower(r.title), r.created_at
    returning id
  `;
  return rows.length;
}

/** The meeting's rock list: company rocks first, then by owner, then by title. */
export function loadMeetingRocks(meetingId: string): Promise<MeetingRock[]> {
  return many<MeetingRock>(sql()`
    select mr.*, mr.created_at::text as created_at
    from meeting_rocks mr left join rocks r on r.id = mr.rock_id
    where mr.meeting_id = ${meetingId}
    order by (r.level = 'company') desc nulls last, lower(coalesce(mr.owner, '~')), lower(mr.title), mr.created_at
  `);
}

export type MeetingTodo = Todo & { meeting_title: string | null; meeting_date: string | null };

/**
 * To-dos for the meeting's To-do review: all open to-dos of the team (from
 * any meeting or the To-Dos page), plus to-dos created or closed in this
 * meeting. Oldest first, so the ones at risk of passing 14 days are on top.
 */
export function loadMeetingTodos(meetingId: string, team: string): Promise<MeetingTodo[]> {
  return many<MeetingTodo>(sql()`
    select t.*, t.created_at::text as created_at, t.updated_at::text as updated_at, t.due_date::text as due_date,
           m.title as meeting_title, m.date::text as meeting_date
    from todos t left join meetings m on m.id = t.meeting_id
    where t.team = ${team}
      and (t.status = 'open' or t.meeting_id = ${meetingId} or t.resolved_meeting_id = ${meetingId})
    order by t.created_at, t.id
  `);
}

export type MeetingIssue = Issue & { meeting_title: string | null; meeting_date: string | null };

/**
 * Issues for the meeting's IDS: the team's open short-term list in rank
 * order, plus issues raised or solved/dropped in this meeting.
 */
export function loadMeetingIssues(meetingId: string, team: string): Promise<MeetingIssue[]> {
  return many<MeetingIssue>(sql()`
    select i.*, i.created_at::text as created_at, i.updated_at::text as updated_at,
           m.title as meeting_title, m.date::text as meeting_date
    from issues i left join meetings m on m.id = i.meeting_id
    where i.team = ${team}
      and ((i.status = 'open' and i.horizon = 'short') or i.meeting_id = ${meetingId} or i.resolved_in_meeting_id = ${meetingId})
    order by i.status = 'open' desc, i.horizon, i.rank nulls last, i.created_at
  `);
}

// ── Conclude ──────────────────────────────────────────────────────────────

export interface ConcludeData {
  ratings: MeetingRating[];
  average: number | null;
  messages: CascadingMessage[];
  /** To-dos created in this meeting (the recap), oldest first. */
  todos: Todo[];
  conclude_notes: string | null;
  /** meetings.meeting_rating: the average, or the one number the analysis heard. */
  meeting_rating: number | null;
}

export const averageRating = (ratings: Array<{ rating: number }>): number | null =>
  ratings.length ? Math.round((ratings.reduce((n, r) => n + Number(r.rating), 0) / ratings.length) * 10) / 10 : null;

export async function loadConclude(meetingId: string): Promise<ConcludeData> {
  const db = sql();
  const [ratings, messages, todos, meeting] = await Promise.all([
    many<MeetingRating>(db`
      select id, meeting_id, person_id, name, rating from meeting_ratings
      where meeting_id = ${meetingId} order by sort_order, name
    `),
    many<CascadingMessage>(db`
      select id, meeting_id, message, to_whom, by_whom, by_whom_id, how, sort_order from cascading_messages
      where meeting_id = ${meetingId} order by sort_order, created_at
    `),
    many<Todo>(db`
      select *, created_at::text as created_at, updated_at::text as updated_at, due_date::text as due_date
      from todos where meeting_id = ${meetingId} order by todos.created_at, todos.id
    `),
    one<{ conclude_notes: string | null; meeting_rating: string | number | null }>(
      db`select conclude_notes, meeting_rating from meetings where id = ${meetingId}`
    ),
  ]);
  return {
    ratings,
    average: averageRating(ratings),
    messages,
    todos,
    conclude_notes: meeting?.conclude_notes ?? null,
    meeting_rating: meeting?.meeting_rating == null ? null : Number(meeting.meeting_rating),
  };
}

// ── Five-line export ──────────────────────────────────────────────────────

const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86400000));

const withOwner = (title: string, owner: string | null) => (owner ? `${title} (${owner})` : title);
const list = (items: string[]) => (items.length ? items.join('; ') : 'none');

/**
 * The meeting as five lines of markdown (plus a heading), for pasting into
 * chat or email:
 *
 *   # L10 2026-10-20 (Leadership team)
 *   Rating: 8.3 (Jude: 8, Jennifer: 9, Russell: 8)
 *   Rocks: 4 on track, 1 off track (…)
 *   To-dos: 6 done, 1 not done (…)
 *   Issues: solved (…); new (…)
 *   Cascading messages: (…)
 */
export async function buildFiveLines(meeting: { id: string; team: string; date: string }): Promise<string> {
  const [rocks, todos, issues, conclude] = await Promise.all([
    loadMeetingRocks(meeting.id),
    loadMeetingTodos(meeting.id, meeting.team),
    loadMeetingIssues(meeting.id, meeting.team),
    loadConclude(meeting.id),
  ]);

  const onTrack = rocks.filter((r) => r.status === 'on_track');
  const offTrack = rocks.filter((r) => r.status === 'off_track');
  const done = todos.filter((t) => t.status === 'done' && t.resolved_meeting_id === meeting.id);
  const notDone = todos.filter((t) => t.status === 'not_done' && t.resolved_meeting_id === meeting.id);
  const solved = issues.filter((i) => i.status === 'solved' && i.resolved_in_meeting_id === meeting.id);
  const raised = issues.filter((i) => i.meeting_id === meeting.id);

  // Per-attendee ratings when Conclude was filled in; else the meeting's
  // stored rating (e.g. the one number the analysis heard); else not rated
  const rating =
    conclude.average != null
      ? `${conclude.average.toFixed(1)} (${conclude.ratings.map((r) => `${r.name}: ${r.rating}`).join(', ')})`
      : conclude.meeting_rating != null
        ? conclude.meeting_rating.toFixed(1)
        : 'not rated';
  const messages = conclude.messages.map((m) =>
    [m.message, m.to_whom && `to ${m.to_whom}`, m.by_whom && `by ${m.by_whom}`, m.how && `via ${m.how}`].filter(Boolean).join(', ')
  );

  return [
    `# L10 ${meeting.date.slice(0, 10)} (${teamLabel(meeting.team)})`,
    `Rating: ${rating}`,
    `Rocks: ${onTrack.length} on track, ${offTrack.length} off track (${list(offTrack.map((r) => withOwner(r.title, r.owner)))})`,
    `To-dos: ${done.length} done, ${notDone.length} not done (${list(
      notDone.map((t) => `${withOwner(t.title, t.owner)}, ${daysBetween(t.created_at, meeting.date)}d`)
    )})`,
    `Issues: solved (${list(solved.map((i) => (i.resolution ? `${i.title}: ${i.resolution}` : i.title)))}); new (${list(
      raised.map((i) => i.title)
    )})`,
    `Cascading messages: (${list(messages)})`,
    '',
  ].join('\n');
}
