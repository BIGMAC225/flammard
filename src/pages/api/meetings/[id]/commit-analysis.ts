import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { isIsoDate } from '../../../../lib/dates';
import { nameKey, resolveOwnerNames } from '../../../../lib/people';
import { plusDays } from '../../../../lib/todos';
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
//
// Existing rocks, to-dos and issues are matched by the id the analysis
// carries (the model sees ids in its context); a title match is only the
// fallback for an analysis from before ids existed.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; team: string; status: string; date: string }>(params.id, 'id, team, status, date::text as date');
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

  // AI owner and presenter names → people (one query). A matched name gets
  // the person's id and canonical name; anything else stays as text.
  const people = await resolveOwnerNames(
    [...a.rocks.map((r) => r.owner), ...a.todos_new.map((t) => t.owner), ...a.actions.map((x) => x.owner), ...a.headlines.map((h) => h.presenter)].filter(
      (n): n is string => typeof n === 'string'
    )
  );
  const who = (name: unknown): { owner: string | null; owner_id: string | null } => {
    const text = typeof name === 'string' ? name.trim() : '';
    if (!text) return { owner: null, owner_id: null };
    const hit = people.get(nameKey(text));
    return hit ? { owner: hit.name, owner_id: hit.id } : { owner: text, owner_id: null };
  };

  const queries = [
    // ── Refuse inside the transaction too (an approval could land between
    //    the check above and here): division by zero aborts the whole batch
    db`select 1 / (case when status in ('approved', 'distributed') then 0 else 1 end) from meetings where id = ${id}`,

    // ── Undo the previous commit of this meeting ────────────────────────
    db`update todos set status = 'open', resolved_meeting_id = null, completed_at = null, updated_at = now()
       where resolved_meeting_id = ${id} and meeting_id is distinct from ${id}`,
    db`update issues set status = 'open', resolution = null, resolved_in_meeting_id = null, solved_at = null, updated_at = now()
       where resolved_in_meeting_id = ${id} and meeting_id is distinct from ${id}`,
    db`delete from steps where parent_type = 'todo' and parent_id in (select id from todos where meeting_id = ${id} and source = 'analysis')`,
    db`delete from steps where parent_type = 'issue' and parent_id in (select id from issues where meeting_id = ${id} and source = 'analysis')`,
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
    ...a.headlines.map((h) => {
      const p = who(h.presenter);
      return db`insert into headlines (meeting_id, team, type, text, presenter, presenter_id, source)
                values (${id}, ${team}, ${h.type}, ${h.text}, ${p.owner}, ${p.owner_id}, 'analysis')`;
    }),

    // ── Rocks: update the team's rock (by id, else by title, else create it),
    //    then the meeting's snapshot — the row carried over at creation is
    //    updated in place; a rock not on the list yet gets a new row
    ...a.rocks.map((r) => {
      // A named owner replaces both columns; no name keeps the rock's owner
      const o = who(r.owner);
      const rockId = isUuid(r.rock_id) ? r.rock_id : null;
      return db`
        with found as (
          select id from rocks where team = ${team}
            and (id = ${rockId}::uuid or (${rockId}::uuid is null and lower(title) = lower(${r.title})))
          limit 1
        ), updated as (
          update rocks set status = ${r.status}, owner = coalesce(${o.owner}::text, owner),
            owner_id = case when ${o.owner}::text is null then owner_id else ${o.owner_id}::uuid end,
            completed_at = case when ${r.status}::text = 'complete' then coalesce(completed_at, now()) else null end,
            updated_at = now()
          where id in (select id from found) returning id, title, owner, owner_id
        ), created as (
          insert into rocks (team, title, owner, owner_id, status, notes)
          select ${team}, ${r.title}, ${o.owner}, ${o.owner_id}::uuid, ${r.status}, ${r.notes}
          where not exists (select 1 from found) returning id, title, owner, owner_id
        ), master as (
          select * from updated union all select * from created
        ), reviewed as (
          update meeting_rocks mr set status = ${r.status}, notes = coalesce(${r.notes}::text, mr.notes),
            owner = m.owner, owner_id = m.owner_id
          from master m
          where mr.meeting_id = ${id} and mr.rock_id = m.id returning mr.id
        )
        insert into meeting_rocks (meeting_id, rock_id, title, owner, owner_id, status, notes, source)
        select ${id}, m.id, m.title, m.owner, m.owner_id, ${r.status}, ${r.notes}, 'analysis'
        from master m
        where not exists (select 1 from reviewed)`;
    }),

    // ── To-dos (one list: minutes "actions" land here too, with their date) ─
    ...a.todos_new.map((t) => {
      const o = who(t.owner);
      return db`insert into todos (meeting_id, team, title, owner, owner_id, status, source, due_date)
                values (${id}, ${team}, ${t.title}, ${o.owner}, ${o.owner_id}, 'open', 'analysis', ${plusDays(meeting.date, 7)})`;
    }),
    ...a.actions
      .filter((x) => typeof x.text === 'string' && x.text.trim())
      .map((x) => {
        const o = who(x.owner);
        const due = isIsoDate(x.due_date) ? x.due_date : plusDays(meeting.date, 7);
        return db`insert into todos (meeting_id, team, title, owner, owner_id, status, source, due_date, completed_at)
                  values (${id}, ${team}, ${x.text.trim().slice(0, 500)}, ${o.owner}, ${o.owner_id},
                          ${x.status === 'completed' ? 'done' : 'open'}, 'analysis', ${due},
                          ${x.status === 'completed' ? new Date() : null})`;
      }),
    ...a.todos_reviewed
      .filter((t) => t.status !== 'open')
      .map((t) => {
        const todoId = isUuid(t.todo_id) ? t.todo_id : null;
        return db`
          update todos set status = ${t.status}, resolved_meeting_id = ${id}, updated_at = now(),
            completed_at = case when ${t.status}::text = 'done' then now() else null end
          where id = (
            select id from todos
            where team = ${team} and meeting_id is distinct from ${id} and status = 'open'
              and (id = ${todoId}::uuid or (${todoId}::uuid is null and lower(title) = lower(${t.title})))
            limit 1
          )`;
      }),

    // ── Issues (new ones go to the bottom of the short-term list) ────────
    ...a.issues_new.map(
      (i) => db`
        insert into issues (meeting_id, team, title, description, priority, status, source, horizon, rank)
        values (${id}, ${team}, ${i.title}, ${i.description}, ${i.priority}, 'open', 'analysis', 'short',
          (select coalesce(max(rank), 0) + 1 from issues where team = ${team} and horizon = 'short'))`
    ),
    // The same rule as PATCH /api/issues/[id]: solved needs a resolution note
    // or a to-do linked to the issue. A blank resolution can only close an
    // existing issue that already has a linked to-do; it never creates one.
    ...a.issues_solved.map((i) => {
      const issueId = isUuid(i.issue_id) ? i.issue_id : null;
      const resolution = typeof i.resolution === 'string' && i.resolution.trim() ? i.resolution.trim() : null;
      return db`
        with solved as (
          update issues set status = 'solved', resolution = coalesce(${resolution}::text, resolution), resolved_in_meeting_id = ${id},
            solved_at = now(), updated_at = now()
          where id = (
            select x.id from issues x
            where x.team = ${team} and x.meeting_id is distinct from ${id} and x.status = 'open'
              and (x.id = ${issueId}::uuid or (${issueId}::uuid is null and lower(x.title) = lower(${i.title})))
              and (${resolution}::text is not null or nullif(btrim(x.resolution), '') is not null
                   or exists (select 1 from todos t where t.issue_id = x.id))
            limit 1
          ) returning id
        )
        insert into issues (meeting_id, team, title, resolution, status, resolved_in_meeting_id, solved_at, priority, source)
        select ${id}, ${team}, ${i.title}, ${resolution}, 'solved', ${id}, now(), 'medium', 'analysis'
        where ${resolution}::text is not null and not exists (select 1 from solved)`;
    }),

    // ── Meeting metadata ────────────────────────────────────────────────
    // Rating and notes prefill Conclude; what was typed there (per-person
    // ratings) wins over the analysis
    db`update meetings
       set meeting_rating = case when exists (select 1 from meeting_ratings where meeting_id = ${id}) then meeting_rating else ${a.meeting_rating} end,
           conclude_notes = coalesce(conclude_notes, ${a.conclude_notes}), eos_analyzed = true,
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
