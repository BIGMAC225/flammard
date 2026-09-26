import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { many, one, sql } from '../../../../lib/db';
import { minutesPdf } from '../../../../lib/blobs';
import { TEAM_LABEL } from '../../../../lib/auth';
import { hashMinutes } from '../../../../lib/crypto';
import { generateMinutesPDF } from '../../../../lib/pdf';
import type { PDFScorecardRow } from '../../../../lib/pdf';
import type {
  Attendee,
  Headline,
  Issue,
  MeetingRock,
  Minutes,
  ScorecardEntry,
  ScorecardMetric,
  Todo,
} from '../../../../types';

export const POST: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{
    id: string;
    title: string;
    date: string;
    location: string | null;
    attendees: Attendee[];
    meeting_rating: number | null;
    conclude_notes: string | null;
    team: string;
  }>(params.id, 'id, title, date::text as date, location, attendees, meeting_rating, conclude_notes, team');
  if (!meeting) return notFound();

  const db = sql();
  const id = meeting.id;

  const minutes = await one<Minutes>(db`select * from minutes where meeting_id = ${id}`);
  if (!minutes) return json({ error: 'No minutes to approve' }, 400);

  const approvedAt = new Date().toISOString();

  const hash = await hashMinutes({
    summary: minutes.summary,
    decisions: minutes.decisions,
    actions: minutes.actions,
    discussion: minutes.discussion,
  });

  // EOS sections for this meeting, plus the latest scorecard value per
  // metric as of the meeting date
  const [headlines, rocks, todos, issues, metrics, entries] = await Promise.all([
    many<Headline>(db`select * from headlines where meeting_id = ${id} order by created_at`),
    many<MeetingRock>(db`select * from meeting_rocks where meeting_id = ${id} order by created_at`),
    many<Todo>(db`select * from todos where meeting_id = ${id} order by created_at`),
    many<Issue>(db`select * from issues where meeting_id = ${id} order by created_at`),
    many<ScorecardMetric>(db`select * from scorecard_metrics where active and team = ${meeting.team} order by sort_order`),
    many<ScorecardEntry>(db`
      select distinct on (e.metric_id) e.*, e.period_date::text as period_date
      from scorecard_entries e where e.period_date <= ${meeting.date}::date
      order by e.metric_id, e.period_date desc
    `),
  ]);

  const scorecard: PDFScorecardRow[] = metrics.flatMap((m) => {
    const latest = entries.find((e) => e.metric_id === m.id);
    if (!latest) return [];
    return [{ title: m.title, goal: m.goal, value: latest.value, on_track: latest.on_track, period_date: latest.period_date }];
  });

  const pdfBuffer = await generateMinutesPDF({
    title: meeting.title,
    date: meeting.date,
    location: meeting.location,
    attendees: meeting.attendees ?? [],
    summary: minutes.summary,
    decisions: minutes.decisions,
    actions: minutes.actions,
    discussion: minutes.discussion,
    hash,
    approvedBy: TEAM_LABEL,
    approvedAt,
    appName: import.meta.env.PUBLIC_APP_NAME || 'Flammard',
    eos: {
      headlines,
      scorecard,
      rocks,
      todos,
      issues,
      meetingRating: meeting.meeting_rating,
      concludeNotes: meeting.conclude_notes,
    },
  });

  const pdfPath = `minutes/${id}/${hash.slice(0, 8)}.pdf`;
  await minutesPdf().set(pdfPath, new Blob([new Uint8Array(pdfBuffer)]), { metadata: { contentType: 'application/pdf' } });

  await db`
    update minutes set content_hash = ${hash}, sealed_at = ${approvedAt}, pdf_path = ${pdfPath}, updated_at = now()
    where id = ${minutes.id}
  `;
  await db`insert into approvals (minutes_id, approved_by, hash_at_approval) values (${minutes.id}, ${TEAM_LABEL}, ${hash})`;
  await db`update meetings set status = 'approved', updated_at = now() where id = ${id}`;

  return json({ hash, approvedAt });
};
