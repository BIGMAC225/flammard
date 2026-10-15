import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth, requireEnum } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { carryRocksIntoMeeting, loadMeetingRocks } from '../../../../lib/l10';
import { resolveOwner } from '../../../../lib/people';

const REVIEW_STATUSES = ['on_track', 'off_track', 'complete', 'dropped'];

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

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
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

  // ── New rock from a title ─────────────────────────────────────────────
  const { title, status } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);
  const clean = title.trim();
  const rockStatus = status ?? 'on_track';

  const master = await one<{ id: string }>(db`
    insert into rocks (team, title, owner, owner_id, status)
    values (${meeting.team}, ${clean}, ${owner.owner}, ${owner.owner_id}, ${rockStatus}) returning id
  `);
  const rock = await one(db`
    insert into meeting_rocks (meeting_id, rock_id, title, owner, owner_id, status)
    values (${meeting.id}, ${master!.id}, ${clean}, ${owner.owner}, ${owner.owner_id}, ${rockStatus})
    returning *
  `);
  return json({ rock });
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
