import type { APIRoute } from 'astro';
import { json, requireUser, requireMeeting } from '../../../../lib/api';
import { createServiceClient } from '../../../../lib/supabase-server';

// The audio itself is uploaded straight from the browser to the `recordings`
// bucket (it can be tens of MB, more than a serverless request allows). This
// route just records where it landed, and hands out a download link so the
// file can be run through Vibe.

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const { meeting, response: forbidden } = await requireMeeting(supabase, user.id, params.id, 'id');
  if (forbidden) return forbidden;

  const { path } = (await request.json()) as { path?: string };
  if (!path || !path.startsWith(`${meeting.id}/`)) {
    return json({ error: 'Invalid recording path' }, 400);
  }

  const { error } = await supabase
    .from('meetings')
    .update({ recording_path: path, input_type: 'recording' })
    .eq('id', meeting.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
};

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const { meeting, response: forbidden } = await requireMeeting(
    supabase,
    user.id,
    params.id,
    'id, title, date, recording_path'
  );
  if (forbidden) return forbidden;
  if (!meeting.recording_path) return json({ error: 'No recording for this meeting' }, 404);

  const ext = meeting.recording_path.split('.').pop() ?? 'webm';
  const fileName = `${meeting.date}-${meeting.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.${ext}`;

  const { data, error } = await createServiceClient()
    .storage.from('recordings')
    .createSignedUrl(meeting.recording_path, 60 * 10, { download: fileName });
  if (error || !data) return json({ error: 'Could not create download link' }, 500);

  return Response.redirect(data.signedUrl, 302);
};
