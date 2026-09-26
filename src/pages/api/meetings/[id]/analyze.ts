import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { many, sql } from '../../../../lib/db';
import { analyzeTranscript } from '../../../../lib/claude';
import { streamJSON } from '../../../../lib/stream-json';
import type { Attendee } from '../../../../types';

// Polled by the client if the streamed POST response was cut off
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting(params.id, 'analysis, analysis_status, analyzed_at');
  if (!meeting) return notFound();
  return json(meeting);
};

export const POST: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{
    id: string;
    title: string;
    date: string;
    attendees: Attendee[];
    transcript: string | null;
  }>(params.id, 'id, title, date::text as date, attendees, transcript');
  if (!meeting) return notFound();
  if (!meeting.transcript) return json({ error: 'Upload a transcript before analyzing' }, 400);

  const db = sql();
  // Context so the model can match misheard names to real rocks/to-dos/issues
  const [rocks, openTodos, openIssues] = await Promise.all([
    many<{ title: string; owner: string | null; status: string }>(
      db`select title, owner, status from rocks where status in ('on_track', 'off_track')`
    ),
    many<{ title: string; owner: string | null }>(db`select title, owner from todos where status = 'open'`),
    many<{ title: string }>(db`select title from issues where status = 'open'`),
  ]);

  return streamJSON(async () => {
    const analysis = await analyzeTranscript(meeting.transcript!, {
      title: meeting.title,
      date: String(meeting.date),
      attendees: (meeting.attendees ?? []).map((a) => a.name),
      rocks,
      openTodos,
      openIssues,
    });

    await db`
      update meetings
      set analysis = ${JSON.stringify(analysis)}::jsonb, analysis_status = 'ready', analyzed_at = now(), updated_at = now()
      where id = ${meeting.id}
    `;
    return { analysis };
  });
};
