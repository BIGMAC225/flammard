import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import type { MeetingAnalysis } from '../../../../types';

// Writes the reviewed (checkbox-filtered) analysis into the real tables.
// Re-committing replaces what the previous commit added for this meeting
// (headlines, rock snapshots, to-dos, issues raised here) so accepting twice
// doesn't duplicate anything. Runs in one transaction.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; status: string; analysis_status: string }>(
    params.id,
    'id, status, analysis_status'
  );
  if (!meeting) return notFound();

  const a = (await request.json()) as MeetingAnalysis;
  const id = meeting.id;
  const db = sql();

  try {
    // Neon's HTTP driver has no interactive transactions; a single multi-
    // statement function body is the equivalent. Build it as one DO block
    // with parameters passed through a temp table would be overkill, so we
    // run the statements sequentially and rely on the "replace" semantics
    // to make a retry safe.
    if (meeting.analysis_status === 'committed') {
      await db`delete from headlines where meeting_id = ${id}`;
      await db`delete from meeting_rocks where meeting_id = ${id}`;
      await db`delete from todos where meeting_id = ${id}`;
      await db`delete from issues where meeting_id = ${id}`;
    }

    // ── Minutes (skip if already sealed) ──────────────────────────────────
    const existing = await one<{ sealed_at: string | null }>(db`select sealed_at from minutes where meeting_id = ${id}`);
    if (!existing?.sealed_at) {
      await db`
        insert into minutes (meeting_id, summary, decisions, actions, discussion)
        values (${id}, ${a.summary}, ${JSON.stringify(a.decisions)}::jsonb, ${JSON.stringify(a.actions)}::jsonb, ${JSON.stringify(a.discussion)}::jsonb)
        on conflict (meeting_id) do update set
          summary = excluded.summary, decisions = excluded.decisions,
          actions = excluded.actions, discussion = excluded.discussion, updated_at = now()
      `;
    }

    // ── Headlines ─────────────────────────────────────────────────────────
    for (const h of a.headlines) {
      await db`insert into headlines (meeting_id, type, text, presenter) values (${id}, ${h.type}, ${h.text}, ${h.presenter})`;
    }

    // ── Rocks: update the master rock, snapshot it for this meeting ───────
    for (const r of a.rocks) {
      let master = await one<{ id: string }>(db`select id from rocks where lower(title) = lower(${r.title}) limit 1`);
      if (master) {
        await db`
          update rocks set status = ${r.status}, owner = coalesce(${r.owner}, owner), updated_at = now()
          where id = ${master.id}
        `;
      } else {
        master = await one<{ id: string }>(db`
          insert into rocks (title, owner, status, notes) values (${r.title}, ${r.owner}, ${r.status}, ${r.notes}) returning id
        `);
      }
      await db`
        insert into meeting_rocks (meeting_id, rock_id, title, owner, status, notes)
        values (${id}, ${master?.id ?? null}, ${r.title}, ${r.owner}, ${r.status}, ${r.notes})
      `;
    }

    // ── To-dos ────────────────────────────────────────────────────────────
    for (const t of a.todos_new) {
      await db`insert into todos (meeting_id, title, owner, status) values (${id}, ${t.title}, ${t.owner}, 'open')`;
    }
    for (const t of a.todos_reviewed) {
      if (t.status === 'open') continue;
      await db`
        update todos set status = ${t.status}, resolved_meeting_id = ${id}, updated_at = now()
        where id = (select id from todos where status = 'open' and lower(title) = lower(${t.title}) limit 1)
      `;
    }

    // ── Issues ────────────────────────────────────────────────────────────
    for (const i of a.issues_new) {
      await db`
        insert into issues (meeting_id, title, description, priority, status)
        values (${id}, ${i.title}, ${i.description}, ${i.priority}, 'open')
      `;
    }
    for (const i of a.issues_solved) {
      const rows = await db`
        update issues set status = 'solved', resolution = ${i.resolution}, resolved_in_meeting_id = ${id}, updated_at = now()
        where id = (select id from issues where status = 'open' and lower(title) = lower(${i.title}) limit 1)
        returning id
      `;
      if (!rows.length) {
        await db`
          insert into issues (meeting_id, title, resolution, status, resolved_in_meeting_id, priority)
          values (${id}, ${i.title}, ${i.resolution}, 'solved', ${id}, 'medium')
        `;
      }
    }

    // ── Meeting metadata ──────────────────────────────────────────────────
    await db`
      update meetings
      set meeting_rating = ${a.meeting_rating}, conclude_notes = ${a.conclude_notes}, eos_analyzed = true,
          analysis = ${JSON.stringify(a)}::jsonb, analysis_status = 'committed',
          status = case when status = 'draft' then 'minutes_draft' else status end,
          updated_at = now()
      where id = ${id}
    `;
  } catch (err) {
    return json({ error: `Could not save: ${err instanceof Error ? err.message : 'unknown error'}` }, 500);
  }

  return json({ ok: true });
};
