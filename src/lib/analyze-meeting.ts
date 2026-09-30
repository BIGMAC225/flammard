import { createHmac, timingSafeEqual } from 'node:crypto';
import { many, one, sql } from './db';
import { analyzeTranscript } from './claude';
import { env } from './env';
import { activateDueRocks } from './roadmap';
import type { Attendee, MeetingAnalysis } from '../types';

// Transcript → EOS analysis, saved on the meeting. Runs in the Netlify
// background function (netlify/functions/analyze-meeting-background.mts),
// which may take several minutes, not in the page request (60s limit).

/** Loads context, calls the model and stores the result or the error. */
export async function runMeetingAnalysis(meetingId: string): Promise<MeetingAnalysis> {
  const db = sql();
  const meeting = await one<{
    id: string;
    title: string;
    date: string;
    attendees: Attendee[];
    transcript: string | null;
    team: string;
  }>(db`select id, title, date::text as date, attendees, transcript, team from meetings where id = ${meetingId}`);
  if (!meeting) throw new Error('Meeting not found');
  if (!meeting.transcript) throw new Error('Upload a transcript before analyzing');

  try {
    await activateDueRocks(meeting.team as 'leadership' | 'management');
    // Context so the model can match misheard names to real rocks/to-dos/issues
    const [rocks, openTodos, openIssues] = await Promise.all([
      many<{ title: string; owner: string | null; status: string }>(
        db`select title, owner, status from rocks where team = ${meeting.team} and status in ('on_track', 'off_track')`
      ),
      many<{ title: string; owner: string | null }>(db`
        select title, owner from todos where team = ${meeting.team} and status = 'open'
      `),
      many<{ title: string }>(db`
        select title from issues where team = ${meeting.team} and status = 'open'
        order by horizon desc, rank nulls last
      `),
    ]);

    const analysis = await analyzeTranscript(meeting.transcript, {
      title: meeting.title,
      date: String(meeting.date),
      attendees: (meeting.attendees ?? []).map((a) => a.name),
      rocks,
      openTodos,
      openIssues,
    });

    await db`
      update meetings
      set analysis = ${JSON.stringify(analysis)}::jsonb, analysis_status = 'ready', analyzed_at = now(),
          analysis_error = null, updated_at = now()
      where id = ${meeting.id}
    `;
    return analysis;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    await db`update meetings set analysis_error = ${message.slice(0, 1000)}, updated_at = now() where id = ${meeting.id}`;
    throw err;
  }
}

// ── Page → background job authentication ──────────────────────────────────
// The job endpoint is public on the internet, so the page signs each request
// with a key derived from SESSION_SECRET (both sides have it).

function jobKey(): string {
  const s = env('SESSION_SECRET');
  if (!s) throw new Error('SESSION_SECRET is not configured');
  return createHmac('sha256', s).update('flammard:background-job').digest('hex');
}

export function signJob(meetingId: string): string {
  return createHmac('sha256', jobKey()).update(meetingId).digest('hex');
}

export function verifyJob(meetingId: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signJob(meetingId));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
