import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import type { MeetingAnalysis } from '../../../../types';

// Writes the reviewed (checkbox-filtered) analysis into the real tables in
// one transaction. Committing again first undoes everything the previous
// commit did — items added under this meeting, and older to-dos/issues it
// closed — so accepting twice (or retrying after a failure) never duplicates.
//
// Neon's HTTP driver only runs non-interactive transactions (every statement
// is sent at once), so the find-or-create steps are single statements built
// from CTEs instead of read-then-write.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const a = (await request.json()) as MeetingAnalysis;
  const id = meeting.id;
  const team = meeting.team;
  const db = sql();

  const queries = [
    // ── Undo the previous commit of this meeting ────────────────────────
    db`update todos set status = 'open', resolved_meeting_id = null, updated_at = now()
       where resolved_meeting_id = ${id} and meeting_id <> ${id}`,
    db`update issues set status = 'open', resolution = null, resolved_in_meeting_id = null, updated_at = now()
       where resolved_in_meeting_id = ${id} and meeting_id <> ${id}`,
    db`delete from headlines where meeting_id = ${id}`,
    db`delete from meeting_rocks where meeting_id = ${id}`,
    db`delete from todos where meeting_id = ${id}`,
    db`delete from issues where meeting_id = ${id}`,

    // ── Minutes (left alone once sealed) ────────────────────────────────
    db`insert into minutes (meeting_id, summary, decisions, actions, discussion)
       values (${id}, ${a.summary}, ${JSON.stringify(a.decisions)}::jsonb, ${JSON.stringify(a.actions)}::jsonb, ${JSON.stringify(a.discussion)}::jsonb)
       on conflict (meeting_id) do update set
         summary = excluded.summary, decisions = excluded.decisions,
         actions = excluded.actions, discussion = excluded.discussion, updated_at = now()
       where minutes.sealed_at is null`,

    // ── Headlines ───────────────────────────────────────────────────────
    ...a.headlines.map(
      (h) => db`insert into headlines (meeting_id, type, text, presenter) values (${id}, ${h.type}, ${h.text}, ${h.presenter})`
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
        insert into meeting_rocks (meeting_id, rock_id, title, owner, status, notes)
        values (${id}, coalesce((select id from updated), (select id from created)), ${r.title}, ${r.owner}, ${r.status}, ${r.notes})`
    ),

    // ── To-dos ──────────────────────────────────────────────────────────
    ...a.todos_new.map(
      (t) => db`insert into todos (meeting_id, title, owner, status) values (${id}, ${t.title}, ${t.owner}, 'open')`
    ),
    ...a.todos_reviewed
      .filter((t) => t.status !== 'open')
      .map(
        (t) => db`
          update todos set status = ${t.status}, resolved_meeting_id = ${id}, updated_at = now()
          where id = (
            select t.id from todos t join meetings m on m.id = t.meeting_id
            where m.team = ${team} and t.status = 'open' and lower(t.title) = lower(${t.title}) limit 1
          )`
      ),

    // ── Issues ──────────────────────────────────────────────────────────
    ...a.issues_new.map(
      (i) => db`
        insert into issues (meeting_id, title, description, priority, status)
        values (${id}, ${i.title}, ${i.description}, ${i.priority}, 'open')`
    ),
    ...a.issues_solved.map(
      (i) => db`
        with solved as (
          update issues set status = 'solved', resolution = ${i.resolution}, resolved_in_meeting_id = ${id}, updated_at = now()
          where id = (
            select i.id from issues i join meetings m on m.id = i.meeting_id
            where m.team = ${team} and i.status = 'open' and lower(i.title) = lower(${i.title}) limit 1
          ) returning id
        )
        insert into issues (meeting_id, title, resolution, status, resolved_in_meeting_id, priority)
        select ${id}, ${i.title}, ${i.resolution}, 'solved', ${id}, 'medium'
        where not exists (select 1 from solved)`
    ),

    // ── Meeting metadata ────────────────────────────────────────────────
    db`update meetings
       set meeting_rating = ${a.meeting_rating}, conclude_notes = ${a.conclude_notes}, eos_analyzed = true,
           analysis = ${JSON.stringify(a)}::jsonb, analysis_status = 'committed',
           status = case when status = 'draft' then 'minutes_draft' else status end,
           updated_at = now()
       where id = ${id}`,
  ];

  try {
    await db.transaction(queries);
  } catch (err) {
    return json({ error: `Could not save: ${err instanceof Error ? err.message : 'unknown error'}` }, 500);
  }

  return json({ ok: true });
};
