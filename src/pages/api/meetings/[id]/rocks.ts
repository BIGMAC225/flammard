import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth, requireEnum } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { carryRocksIntoMeeting, loadMeetingRocks } from '../../../../lib/l10';
import { isIsoDate } from '../../../../lib/dates';
import { resolveOwner } from '../../../../lib/people';
import { quarterEndFor, rockLoadWarning } from '../../../../lib/rocks';

const REVIEW_STATUSES = ['on_track', 'off_track', 'complete', 'dropped'];
const LEVELS = ['company', 'individual'];

/** The meeting's rock list (company rocks first, then by owner). */
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string }>(params.id, 'id');
  if (!meeting) return notFound();
  return json({ rocks: await loadMeetingRocks(meeting.id) });
};

/**
 * Adds a rock to the meeting's review list. With `rock_id` it is an existing
 * team rock (matched by id, never by title); without one a new team rock is
 * created from the title. A rock already on this meeting's list is returned
 * as is rather than duplicated.
 */
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'status', REVIEW_STATUSES);
  if (invalid) return invalid;
  if ('rock_id' in body && body.rock_id != null && !isUuid(body.rock_id)) return json({ error: 'Invalid rock_id' }, 400);

  const meeting = await getMeeting<{ id: string; team: string; date: string }>(params.id, 'id, team, date::text as date');
  if (!meeting) return notFound();

  const db = sql();

  // ── Existing rock by id ───────────────────────────────────────────────
  if (isUuid(body.rock_id)) {
    const master = await one<{ id: string; title: string; owner: string | null; owner_id: string | null; status: string }>(
      db`select id, title, owner, owner_id, status from rocks where id = ${body.rock_id} and team = ${meeting.team}`
    );
    if (!master) return json({ error: 'Rock not found on this team' }, 404);
    const existing = await one(db`select * from meeting_rocks where meeting_id = ${meeting.id} and rock_id = ${master.id} limit 1`);
    if (existing) return json({ rock: existing, existed: true });
    const status = body.status ?? (master.status === 'planned' ? 'on_track' : master.status);
    // Putting a planned rock up for review is the team choosing to work it now
    await db`update rocks set status = ${status}, updated_at = now() where id = ${master.id} and status = 'planned'`;
    const rock = await one(db`
      insert into meeting_rocks (meeting_id, rock_id, title, owner, owner_id, status)
      values (${meeting.id}, ${master.id}, ${master.title}, ${master.owner}, ${master.owner_id}, ${status})
      returning *
    `);
    return json({ rock });
  }

  // ── New rock from a title: one owner, a due date (this quarter's end by
  //    default) and an optional level ─────────────────────────────────────
  const { title, status } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  if (body.due_date != null && body.due_date !== '' && !isIsoDate(body.due_date)) return json({ error: 'Invalid due date' }, 400);
  if (body.level != null && !LEVELS.includes(body.level)) return json({ error: 'Invalid level' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);
  if (!owner.owner) return json({ error: 'Every rock needs one owner' }, 400);
  const clean = title.trim();
  const rockStatus = status ?? 'on_track';
  const dueDate: string = body.due_date || (await quarterEndFor(meeting.date));

  const master = await one<{ id: string }>(db`
    insert into rocks (team, title, owner, owner_id, status, due_date, level)
    values (${meeting.team}, ${clean}, ${owner.owner}, ${owner.owner_id}, ${rockStatus}, ${dueDate}, ${body.level ?? null}) returning id
  `);
  const rock = await one(db`
    insert into meeting_rocks (meeting_id, rock_id, title, owner, owner_id, status)
    values (${meeting.id}, ${master!.id}, ${clean}, ${owner.owner}, ${owner.owner_id}, ${rockStatus})
    returning *
  `);
  const warning = await rockLoadWarning(meeting.team, owner.owner_id, dueDate, master!.id);
  return json({ rock, warning });
};

/**
 * Carries the team's active rocks into this meeting (the ones not already
 * there). For meetings created before carry-over existed, and after a rock
 * is added on the Rocks page mid-week.
 */
export const PUT: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();
  const added = await carryRocksIntoMeeting(meeting.id, meeting.team);
  return json({ added, rocks: await loadMeetingRocks(meeting.id) });
};
