import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import { draftMinutes } from '../../../../lib/claude';
import type { Attendee } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = params;
  const body = await request.json();
  const { transcript, input_type } = body as { transcript: string; input_type: string };

  if (!transcript?.trim()) {
    return new Response(JSON.stringify({ error: 'No content provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch meeting to verify ownership and get context
  const { data: meeting, error: meetingErr } = await supabase
    .from('meetings')
    .select('id, title, date, attendees, created_by')
    .eq('id', id)
    .single();

  if (meetingErr || !meeting) {
    return new Response(JSON.stringify({ error: 'Meeting not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Draft minutes with Claude
  const attendeeNames = (meeting.attendees as Attendee[]).map((a) => a.name);
  const drafted = await draftMinutes(transcript, {
    title: meeting.title,
    date: meeting.date,
    attendees: attendeeNames,
  });

  // Save transcript + update meeting status
  await supabase
    .from('meetings')
    .update({
      transcript,
      input_type,
      status: 'minutes_draft',
    })
    .eq('id', id);

  // Upsert minutes record
  const { data: minutesData, error: minutesErr } = await supabase
    .from('minutes')
    .upsert(
      {
        meeting_id: id,
        summary: drafted.summary,
        decisions: drafted.decisions,
        actions: drafted.actions,
        discussion: drafted.discussion,
        version: 1,
      },
      { onConflict: 'meeting_id' }
    )
    .select('id')
    .single();

  if (minutesErr) {
    return new Response(JSON.stringify({ error: minutesErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ minutes: drafted, minutes_id: minutesData.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
