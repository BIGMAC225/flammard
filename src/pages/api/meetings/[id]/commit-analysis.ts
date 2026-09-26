import type { APIRoute } from 'astro';
import { json, requireUser, requireMeeting } from '../../../../lib/api';
import type { MeetingAnalysis } from '../../../../types';

// `ilike` treats % and _ as wildcards; model-written titles can contain them
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Writes the reviewed (checkbox-filtered) analysis into the real tables.
// Re-committing replaces what the previous commit added for this meeting
// (headlines, rock snapshots, to-dos, issues raised here) so accepting twice
// doesn't duplicate anything.
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
  const errors: string[] = [];
  const track = (label: string, res: { error: { message: string } | null }) => {
    if (res.error) errors.push(`${label}: ${res.error.message}`);
  };

  // ── Clear what an earlier commit of this meeting created ────────────────
  if (meeting.analysis_status === 'committed') {
    track('clear headlines', await supabase.from('headlines').delete().eq('meeting_id', id));
    track('clear rocks', await supabase.from('meeting_rocks').delete().eq('meeting_id', id));
    track('clear to-dos', await supabase.from('todos').delete().eq('meeting_id', id));
    track('clear issues', await supabase.from('issues').delete().eq('meeting_id', id));
    if (errors.length) return json({ error: errors.join('; ') }, 500);
  }

  // ── Minutes (skip if already sealed) ────────────────────────────────────
  const { data: existingMinutes } = await supabase
    .from('minutes')
    .select('sealed_at')
    .eq('meeting_id', id)
    .maybeSingle();
  if (!existingMinutes?.sealed_at) {
    track(
      'minutes',
      await supabase.from('minutes').upsert(
        {
          meeting_id: id,
          summary: a.summary,
          decisions: a.decisions,
          actions: a.actions,
          discussion: a.discussion,
        },
        { onConflict: 'meeting_id' }
      )
    );
  }

  // ── Headlines ───────────────────────────────────────────────────────────
  if (a.headlines.length) {
    track(
      'headlines',
      await supabase.from('headlines').insert(
        a.headlines.map((h) => ({
          meeting_id: id,
          type: h.type,
          text: h.text,
          presenter: h.presenter,
          created_by: by,
        }))
      )
    );
  }

  // ── Rocks: update the master rock, snapshot it for this meeting ─────────
  for (const r of a.rocks) {
    const { data: existing } = await supabase
      .from('rocks')
      .select('id')
      .ilike('title', escapeLike(r.title))
      .limit(1)
      .maybeSingle();

    let rockId = existing?.id as string | undefined;
    if (rockId) {
      track(
        `rock "${r.title}"`,
        await supabase
          .from('rocks')
          .update({ status: r.status, ...(r.owner ? { owner: r.owner } : {}) })
          .eq('id', rockId)
      );
    } else {
      const { data: created, error } = await supabase
        .from('rocks')
        .insert({ title: r.title, owner: r.owner, status: r.status, notes: r.notes, created_by: by })
        .select('id')
        .single();
      if (error) errors.push(`rock "${r.title}": ${error.message}`);
      rockId = created?.id;
    }

    track(
      `rock review "${r.title}"`,
      await supabase.from('meeting_rocks').insert({
        meeting_id: id,
        rock_id: rockId ?? null,
        title: r.title,
        owner: r.owner,
        status: r.status,
        notes: r.notes,
        created_by: by,
      })
    );
  }

  // ── To-dos ──────────────────────────────────────────────────────────────
  if (a.todos_new.length) {
    track(
      'to-dos',
      await supabase.from('todos').insert(
        a.todos_new.map((t) => ({ meeting_id: id, title: t.title, owner: t.owner, status: 'open', created_by: by }))
      )
    );
  }
  for (const t of a.todos_reviewed) {
    if (t.status === 'open') continue;
    const { data: open } = await supabase
      .from('todos')
      .select('id')
      .eq('status', 'open')
      .ilike('title', escapeLike(t.title))
      .limit(1)
      .maybeSingle();
    if (open) {
      track(
        `to-do "${t.title}"`,
        await supabase.from('todos').update({ status: t.status, resolved_meeting_id: id }).eq('id', open.id)
      );
    }
  }

  // ── Issues ──────────────────────────────────────────────────────────────
  if (a.issues_new.length) {
    track(
      'issues',
      await supabase.from('issues').insert(
        a.issues_new.map((i) => ({
          meeting_id: id,
          title: i.title,
          description: i.description,
          priority: i.priority,
          status: 'open',
          created_by: by,
        }))
      )
    );
  }
  for (const i of a.issues_solved) {
    const { data: open } = await supabase
      .from('issues')
      .select('id')
      .eq('status', 'open')
      .ilike('title', escapeLike(i.title))
      .limit(1)
      .maybeSingle();
    if (open) {
      track(
        `issue "${i.title}"`,
        await supabase
          .from('issues')
          .update({ status: 'solved', resolution: i.resolution, resolved_in_meeting_id: id })
          .eq('id', open.id)
      );
    } else {
      track(
        `issue "${i.title}"`,
        await supabase.from('issues').insert({
          meeting_id: id,
          title: i.title,
          resolution: i.resolution,
          status: 'solved',
          resolved_in_meeting_id: id,
          priority: 'medium',
          created_by: by,
        })
      );
    }
  }

  if (errors.length) {
    return json({ error: `Some items could not be saved — ${errors.join('; ')}` }, 500);
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
