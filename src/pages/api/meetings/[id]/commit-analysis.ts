import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import type { MeetingAnalysis } from '../../../../types';

// Writes the reviewed (checkbox-filtered) analysis into the real tables in
// one transaction. Committing again first undoes everything the previous
// commit did — rows it created (source = 'analysis') and older to-dos/issues
// it closed — so accepting twice (or retrying after a failure) never
// duplicates. Items added by hand on the EOS tab are left alone.
//
// Neon's HTTP driver only runs non-interactive transactions (every statement
// is sent at once), so the find-or-create steps are single statements built
// from CTEs instead of read-then-write.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; team: string; status: string }>(params.id, 'id, team, status');
  if (!meeting) return notFound();
  if (meeting.status === 'approved' || meeting.status === 'distributed') {
    return json({ error: 'This meeting is approved and sealed; its record can no longer be changed' }, 409);
  }

  const body = await readBody(request);
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const a: MeetingAnalysis = {
    summary: typeof body.summary === 'string' ? body.summary : '',
    decisions: list(body.decisions),
    actions: list(body.actions),
    discussion: list(body.discussion),
    headlines: list(body.headlines),
    rocks: list(body.rocks),
    todos_new: list(body.todos_new),
    todos_reviewed: list(body.todos_reviewed),
    issues_new: list(body.issues_new),
    issues_solved: list(body.issues_solved),
    meeting_rating: typeof body.meeting_rating === 'number' ? body.meeting_rating : null,
    conclude_notes: typeof body.conclude_notes === 'string' ? body.conclude_notes : null,
  };
  const id = meeting.id;
  const team = meeting.team;
  const db = sql();

  const queries = [
    // ── Refuse inside the transaction too (an approval could land between
    //    the check above and here): division by zero aborts the whole batch
    db`select 1 / (case when status in ('approved', 'distributed') then 0 else 1 end) from meetings where id = ${id}`,

    // ── Undo the previous commit of this meeting ────────────────────────
    db`update todos set status = 'open', resolved_meeting_id = null, updated_at = now()
       where resolved_meeting_id = ${id} and meeting_id <> ${id}`,
    db`update issues set status = 'open', resolution = null, resolved_in_meeting_id = null, updated_at = now()
       where resolved_in_meeting_id = ${id} and meeting_id <> ${id}`,
    db`delete from headlines where meeting_id = ${id} and source = 'analysis'`,
    db`delete from meeting_rocks where meeting_id = ${id} and source = 'analysis'`,
    db`delete from todos where meeting_id = ${id} and source = 'analysis'`,
    db`delete from issues where meeting_id = ${id} and source = 'analysis'`,

    // ── Minutes (left alone once sealed) ────────────────────────────────
    db`insert into minutes (meeting_id, summary, decisions, actions, discussion)
       values (${id}, ${a.summary}, ${JSON.stringify(a.decisions)}::jsonb, ${JSON.stringify(a.actions)}::jsonb, ${JSON.stringify(a.discussion)}::jsonb)
       on conflict (meeting_id) do update set
         summary = excluded.summary, decisions = excluded.decisions,
         actions = excluded.actions, discussion = excluded.discussion, updated_at = now()
       where minutes.sealed_at is null`,

    // ── Headlines ───────────────────────────────────────────────────────
    ...a.headlines.map(
      (h) => db`insert into headlines (meeting_id, type, text, presenter, source) values (${id}, ${h.type}, ${h.text}, ${h.presenter}, 'analysis')`
    ),

    // ── Rocks: update the team's master rock (or create it), then snapshot
    ...a.rocks.map(
      (r) => db`
        with found as (
          select id from rocks where team = ${team} and lower(title) = lower(${r.title}) limit 1
        ), updated as (
          update rocks set status = ${r.status}, owner = coalesce(${r.owner}, owner), updated_at = now()
          where id in (select id from found) returning id
        ), created as (
          insert into rocks (team, title, owner, status, notes)
          select ${team}, ${r.title}, ${r.owner}, ${r.status}, ${r.notes}
          where not exists (select 1 from found) returning id
        )
        insert into meeting_rocks (meeting_id, rock_id, title, owner, status, notes, source)
        values (${id}, coalesce((select id from updated), (select id from created)), ${r.title}, ${r.owner}, ${r.status}, ${r.notes}, 'analysis')`
    ),

    // ── To-dos ──────────────────────────────────────────────────────────
    ...a.todos_new.map(
      (t) => db`insert into todos (meeting_id, title, owner, status, source) values (${id}, ${t.title}, ${t.owner}, 'open', 'analysis')`
    ),
    ...a.todos_reviewed
      .filter((t) => t.status !== 'open')
      .map(
        (t) => db`
          update todos set status = ${t.status}, resolved_meeting_id = ${id}, updated_at = now()
          where id = (
            select t.id from todos t join meetings m on m.id = t.meeting_id
            where m.team = ${team} and t.meeting_id <> ${id} and t.status = 'open' and lower(t.title) = lower(${t.title}) limit 1
          )`
      ),

    // ── Issues ──────────────────────────────────────────────────────────
    ...a.issues_new.map(
      (i) => db`
        insert into issues (meeting_id, title, description, priority, status, source)
        values (${id}, ${i.title}, ${i.description}, ${i.priority}, 'open', 'analysis')`
    ),
    ...a.issues_solved.map(
      (i) => db`
        with solved as (
          update issues set status = 'solved', resolution = ${i.resolution}, resolved_in_meeting_id = ${id}, updated_at = now()
          where id = (
            select i.id from issues i join meetings m on m.id = i.meeting_id
            where m.team = ${team} and i.meeting_id <> ${id} and i.status = 'open' and lower(i.title) = lower(${i.title}) limit 1
          ) returning id
        )
        insert into issues (meeting_id, title, resolution, status, resolved_in_meeting_id, priority, source)
        select ${id}, ${i.title}, ${i.resolution}, 'solved', ${id}, 'medium', 'analysis'
        where not exists (select 1 from solved)`
    ),

    // ── Meeting metadata ────────────────────────────────────────────────
    db`update meetings
       set meeting_rating = ${a.meeting_rating}, conclude_notes = ${a.conclude_notes}, eos_analyzed = true,
           analysis = ${JSON.stringify(a)}::jsonb, analysis_status = 'committed',
           status = case when status = 'draft' then 'minutes_draft' else status end,
           updated_at = now()
       where id = ${id} and status not in ('approved', 'distributed')`,
  ];

  try {
    await db.transaction(queries);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (/division by zero/.test(message)) {
      return json({ error: 'This meeting was approved while you were reviewing; its record can no longer be changed' }, 409);
    }
    return json({ error: `Could not save: ${message}` }, 500);
  }

  return json({ ok: true });
};
