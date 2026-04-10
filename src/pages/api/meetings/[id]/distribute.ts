import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import { sendAcknowledgementEmail } from '../../../../lib/email';
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
  // Optional: override attendees for distribution (e.g., only select some)
  const { recipients } = body as { recipients?: Array<{ name: string; email: string }> };

  const { data: meeting } = await supabase
    .from('meetings')
    .select('id, title, date, attendees, created_by, status')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (meeting.status !== 'approved') {
    return new Response(JSON.stringify({ error: 'Minutes must be approved before distribution' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data: minutes } = await supabase
    .from('minutes')
    .select('id')
    .eq('meeting_id', id)
    .single();

  if (!minutes) {
    return new Response(JSON.stringify({ error: 'Minutes not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const appUrl = import.meta.env.PUBLIC_APP_URL ?? '';
  const attendees = (recipients ?? (meeting.attendees as Attendee[])).filter((a) => a.email);

  const results: Array<{ email: string; ok: boolean; error?: string }> = [];

  for (const attendee of attendees) {
    if (!attendee.email) continue;

    // Create distribution record
    const { data: dist } = await supabase
      .from('distributions')
      .insert({
        minutes_id: minutes.id,
        meeting_id: id,
        recipient_email: attendee.email,
        recipient_name: attendee.name || null,
      })
      .select('token')
      .single();

    if (!dist) {
      results.push({ email: attendee.email, ok: false, error: 'Failed to create record' });
      continue;
    }

    try {
      await sendAcknowledgementEmail({
        to: attendee.email,
        recipientName: attendee.name,
        meetingTitle: meeting.title,
        meetingDate: meeting.date,
        token: dist.token,
        appUrl,
      });
      results.push({ email: attendee.email, ok: true });
    } catch (err) {
      results.push({ email: attendee.email, ok: false, error: String(err) });
    }
  }

  // Update meeting status
  await supabase.from('meetings').update({ status: 'distributed' }).eq('id', id);

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
