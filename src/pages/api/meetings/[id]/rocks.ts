import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth, requireEnum } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title, owner, status } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  const invalid = requireEnum(body, 'status', ['on_track', 'off_track', 'complete', 'dropped']);
  if (invalid) return invalid;

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const db = sql();
  const clean = title.trim();
  const rockStatus = status ?? 'on_track';

  // Create or find the team's top-level rock
  let master = await one<{ id: string }>(
    db`select id from rocks where team = ${meeting.team} and lower(title) = lower(${clean}) limit 1`
  );
  if (!master) {
    master = await one<{ id: string }>(db`
      insert into rocks (team, title, owner, status) values (${meeting.team}, ${clean}, ${owner ?? null}, ${rockStatus}) returning id
    `);
  } else {
    await db`update rocks set status = ${rockStatus}, updated_at = now() where id = ${master.id} and status = 'planned'`;
  }

  const rock = await one(db`
    insert into meeting_rocks (meeting_id, rock_id, title, owner, status)
    values (${meeting.id}, ${master?.id ?? null}, ${clean}, ${owner ?? null}, ${rockStatus})
    returning *
  `);
  return json({ rock });
};
