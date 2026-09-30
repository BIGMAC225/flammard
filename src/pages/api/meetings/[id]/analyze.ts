import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { runMeetingAnalysis, signJob } from '../../../../lib/analyze-meeting';
import { streamJSON } from '../../../../lib/stream-json';

// The page polls this while the background job runs: it resolves when
// analyzed_at passes the run's start, or fails when analysis_error is set.
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting(
    params.id,
    'analysis, analysis_status, analyzed_at, analysis_started_at, analysis_error, now() as server_now'
  );
  if (!meeting) return notFound();
  return json(meeting);
};

// Starts an analysis. Normally hands off to the Netlify background function
// (up to 15 minutes); if that can't be reached (local dev), runs inline as a
// streamed response instead.
export const POST: APIRoute = async ({ params, cookies, url }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; transcript: string | null }>(params.id, 'id, transcript');
  if (!meeting) return notFound();
  if (!meeting.transcript) return json({ error: 'Upload a transcript before analyzing' }, 400);

  const [row] = await sql()`
    update meetings set analysis_started_at = now(), analysis_error = null
    where id = ${meeting.id} returning analysis_started_at
  `;
  const startedAt = row?.analysis_started_at;

  try {
    const res = await fetch(new URL('/.netlify/functions/analyze-meeting-background', url.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-flammard-job': signJob(meeting.id) },
      body: JSON.stringify({ meeting_id: meeting.id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 202 || res.ok) return json({ started: true, started_at: startedAt }, 202);
    console.log(`[analyze] background function answered ${res.status}; running inline`);
  } catch (err) {
    console.log(`[analyze] background function unreachable (${err instanceof Error ? err.message : err}); running inline`);
  }

  return streamJSON(async () => ({ analysis: await runMeetingAnalysis(meeting.id) }));
};
