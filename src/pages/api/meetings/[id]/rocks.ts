import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, owner, status } = await request.json();
  if (!title?.trim()) return json({ error: 'Title required' }, 400);

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const db = sql();
  const clean = title.trim();
  const rockStatus = status ?? 'on_track';

  // Create or find the top-level rock
  let master = await one<{ id: string }>(db`select id from rocks where lower(title) = lower(${clean}) limit 1`);
  if (!master) {
    master = await one<{ id: string }>(db`
      insert into rocks (title, owner, status) values (${clean}, ${owner ?? null}, ${rockStatus}) returning id
    `);
  }

  const rock = await one(db`
    insert into meeting_rocks (meeting_id, rock_id, title, owner, status)
    values (${meeting.id}, ${master?.id ?? null}, ${clean}, ${owner ?? null}, ${rockStatus})
    returning *
  `);
  return json({ rock });
};
