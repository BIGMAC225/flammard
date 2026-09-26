import type { APIRoute } from 'astro';
import { json, requireUser, requireMeeting } from '../../../../lib/api';
import type { MeetingAnalysis } from '../../../../types';

// Writes the reviewed (checkbox-filtered) analysis into the real tables.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const { meeting, response: forbidden } = await requireMeeting(
    supabase,
    user.id,
    params.id,
    'id, status, analysis_status'
  );
  if (forbidden) return forbidden;

  const a = (await request.json()) as MeetingAnalysis;
  const id = meeting.id as string;
  const by = user.id;

  // ── Minutes (skip if already sealed) ────────────────────────────────────
  const { data: existingMinutes } = await supabase
    .from('minutes')
    .select('sealed_at')
    .eq('meeting_id', id)
    .maybeSingle();
  if (!existingMinutes?.sealed_at) {
    const { error } = await supabase.from('minutes').upsert(
      {
        meeting_id: id,
        summary: a.summary,
        decisions: a.decisions,
        actions: a.actions,
        discussion: a.discussion,
      },
      { onConflict: 'meeting_id' }
    );
    if (error) return json({ error: `Minutes: ${error.message}` }, 500);
  }

  // ── Headlines ───────────────────────────────────────────────────────────
  if (a.headlines.length) {
    await supabase.from('headlines').insert(
      a.headlines.map((h) => ({
        meeting_id: id,
        type: h.type,
        text: h.text,
        presenter: h.presenter,
        created_by: by,
      }))
    );
  }

  // ── Rocks: update the master rock, snapshot it for this meeting ─────────
  for (const r of a.rocks) {
    const { data: existing } = await supabase
      .from('rocks')
      .select('id')
      .ilike('title', r.title)
      .limit(1)
      .maybeSingle();

    let rockId = existing?.id as string | undefined;
    if (rockId) {
      await supabase
        .from('rocks')
        .update({ status: r.status, ...(r.owner ? { owner: r.owner } : {}) })
        .eq('id', rockId);
    } else {
      const { data: created } = await supabase
        .from('rocks')
        .insert({ title: r.title, owner: r.owner, status: r.status, notes: r.notes, created_by: by })
        .select('id')
        .single();
      rockId = created?.id;
    }

    await supabase.from('meeting_rocks').insert({
      meeting_id: id,
      rock_id: rockId ?? null,
      title: r.title,
      owner: r.owner,
      status: r.status,
      notes: r.notes,
      created_by: by,
    });
  }

  // ── To-dos ──────────────────────────────────────────────────────────────
  if (a.todos_new.length) {
    await supabase.from('todos').insert(
      a.todos_new.map((t) => ({ meeting_id: id, title: t.title, owner: t.owner, status: 'open', created_by: by }))
    );
  }
  for (const t of a.todos_reviewed) {
    if (t.status === 'open') continue;
    const { data: open } = await supabase
      .from('todos')
      .select('id')
      .eq('status', 'open')
      .ilike('title', t.title)
      .limit(1)
      .maybeSingle();
    if (open) {
      await supabase
        .from('todos')
        .update({ status: t.status, resolved_meeting_id: id })
        .eq('id', open.id);
    }
  }

  // ── Issues ──────────────────────────────────────────────────────────────
  if (a.issues_new.length) {
    await supabase.from('issues').insert(
      a.issues_new.map((i) => ({
        meeting_id: id,
        title: i.title,
        description: i.description,
        priority: i.priority,
        status: 'open',
        created_by: by,
      }))
    );
  }
  for (const i of a.issues_solved) {
    const { data: open } = await supabase
      .from('issues')
      .select('id')
      .eq('status', 'open')
      .ilike('title', i.title)
      .limit(1)
      .maybeSingle();
    if (open) {
      await supabase
        .from('issues')
        .update({ status: 'solved', resolution: i.resolution, resolved_in_meeting_id: id })
        .eq('id', open.id);
    } else {
      await supabase.from('issues').insert({
        meeting_id: id,
        title: i.title,
        resolution: i.resolution,
        status: 'solved',
        resolved_in_meeting_id: id,
        priority: 'medium',
        created_by: by,
      });
    }
  }

  // ── Meeting metadata ────────────────────────────────────────────────────
  const { error } = await supabase
    .from('meetings')
    .update({
      meeting_rating: a.meeting_rating,
      conclude_notes: a.conclude_notes,
      eos_analyzed: true,
      analysis: a,
      analysis_status: 'committed',
      ...(meeting.status === 'draft' ? { status: 'minutes_draft' } : {}),
    })
    .eq('id', id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
};
