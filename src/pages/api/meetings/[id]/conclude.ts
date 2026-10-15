import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { averageRating, loadConclude } from '../../../../lib/l10';
import { resolveOwnerNames, nameKey } from '../../../../lib/people';

// Conclude: each attendee's 1–10 rating, the cascading messages, and the
// closing notes. PUT replaces the whole set in one transaction (the panel
// saves its full state), and writes the average to meetings.meeting_rating
// so the PDF, the meeting header and the lists keep showing it.

export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string }>(params.id, 'id');
  if (!meeting) return notFound();
  return json(await loadConclude(meeting.id));
};

interface RatingInput {
  name: string;
  person_id: string | null;
  rating: number;
}
interface MessageInput {
  message: string;
  to_whom: string | null;
  by_whom: string | null;
  by_whom_id: string | null;
  how: string | null;
}

const text = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; status: string }>(params.id, 'id, status');
  if (!meeting) return notFound();
  if (meeting.status === 'approved' || meeting.status === 'distributed') {
    return json({ error: 'This meeting is approved and sealed; its record can no longer be changed' }, 409);
  }

  const body = await readBody(request);

  // Ratings: name required, 1–10 whole numbers; blanks are skipped (not rated yet)
  const ratings: RatingInput[] = [];
  for (const r of Array.isArray(body.ratings) ? body.ratings : []) {
    const name = text(r?.name, 120);
    if (!name) continue;
    if (r?.rating == null || r.rating === '') continue;
    const rating = Number(r.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) return json({ error: `Rating for ${name} must be a whole number from 1 to 10` }, 400);
    if (r.person_id != null && r.person_id !== '' && !isUuid(r.person_id)) return json({ error: 'Invalid person_id' }, 400);
    if (ratings.some((x) => nameKey(x.name) === nameKey(name))) continue; // one per person
    ratings.push({ name, person_id: isUuid(r.person_id) ? r.person_id : null, rating });
  }
  if (ratings.length > 50) return json({ error: 'Too many ratings' }, 400);

  // Cascading messages: message required, the rest optional
  const messages: MessageInput[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const message = text(m?.message, 1000);
    if (!message) continue;
    if (m.by_whom_id != null && m.by_whom_id !== '' && !isUuid(m.by_whom_id)) return json({ error: 'Invalid by_whom_id' }, 400);
    messages.push({
      message,
      to_whom: text(m?.to_whom, 200),
      by_whom: text(m?.by_whom, 120),
      by_whom_id: isUuid(m?.by_whom_id) ? m.by_whom_id : null,
      how: text(m?.how, 200),
    });
  }
  if (messages.length > 100) return json({ error: 'Too many messages' }, 400);

  if ('conclude_notes' in body && body.conclude_notes !== null && typeof body.conclude_notes !== 'string') {
    return json({ error: 'Invalid conclude_notes' }, 400);
  }
  const notesSent = 'conclude_notes' in body;
  const notes = text(body.conclude_notes, 5000);

  // Names without an id get matched to people the same way owners are
  const people = await resolveOwnerNames([
    ...ratings.filter((r) => !r.person_id).map((r) => r.name),
    ...messages.filter((m) => !m.by_whom_id && m.by_whom).map((m) => m.by_whom!),
  ]);
  for (const r of ratings) {
    if (!r.person_id) {
      const hit = people.get(nameKey(r.name));
      if (hit) r.person_id = hit.id;
    }
  }
  for (const m of messages) {
    if (!m.by_whom_id && m.by_whom) {
      const hit = people.get(nameKey(m.by_whom));
      if (hit) {
        m.by_whom_id = hit.id;
        m.by_whom = hit.name;
      }
    }
  }

  const db = sql();
  const id = meeting.id;
  const average = averageRating(ratings);
  await db.transaction([
    db`delete from meeting_ratings where meeting_id = ${id}`,
    ...ratings.map(
      (r, i) => db`insert into meeting_ratings (meeting_id, person_id, name, rating, sort_order) values (${id}, ${r.person_id}, ${r.name}, ${r.rating}, ${i})`
    ),
    db`delete from cascading_messages where meeting_id = ${id}`,
    ...messages.map(
      (m, i) => db`
        insert into cascading_messages (meeting_id, message, to_whom, by_whom, by_whom_id, how, sort_order)
        values (${id}, ${m.message}, ${m.to_whom}, ${m.by_whom}, ${m.by_whom_id}, ${m.how}, ${i})`
    ),
    notesSent
      ? db`update meetings set meeting_rating = ${average}, conclude_notes = ${notes}, updated_at = now() where id = ${id}`
      : db`update meetings set meeting_rating = ${average}, updated_at = now() where id = ${id}`,
  ]);

  return json(await loadConclude(id));
};
