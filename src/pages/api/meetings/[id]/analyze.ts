import type { APIRoute } from 'astro';
import { json, requireUser, requireMeeting } from '../../../../lib/api';
import { analyzeTranscript } from '../../../../lib/claude';
import { streamJSON } from '../../../../lib/stream-json';
import type { Attendee } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const { meeting, response: forbidden } = await requireMeeting(
    supabase,
    user.id,
    params.id,
    'id, title, date, attendees, transcript'
  );
  if (forbidden) return forbidden;
  if (!meeting.transcript) return json({ error: 'Upload a transcript before analyzing' }, 400);

  // Context so the model can match misheard names to real rocks/to-dos/issues
  const [{ data: rocks }, { data: openTodos }, { data: openIssues }] = await Promise.all([
    supabase.from('rocks').select('title, owner, status').in('status', ['on_track', 'off_track']),
    supabase.from('todos').select('title, owner').eq('status', 'open'),
    supabase.from('issues').select('title').eq('status', 'open'),
  ]);

  return streamJSON(async () => {
    const analysis = await analyzeTranscript(meeting.transcript, {
      title: meeting.title,
      date: meeting.date,
      attendees: ((meeting.attendees as Attendee[]) ?? []).map((a) => a.name),
      rocks: rocks ?? [],
      openTodos: openTodos ?? [],
      openIssues: openIssues ?? [],
    });

    const { error } = await supabase
      .from('meetings')
      .update({ analysis, analysis_status: 'ready', analyzed_at: new Date().toISOString() })
      .eq('id', meeting.id);
    if (error) throw new Error(error.message);

    return { analysis };
  });
};
