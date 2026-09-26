import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, owner } = await request.json();
  if (!title?.trim()) return json({ error: 'Title required' }, 400);

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const todo = await one(sql()`
    insert into todos (meeting_id, title, owner, status)
    values (${meeting.id}, ${title.trim()}, ${owner ?? null}, 'open')
    returning *
  `);
  return json({ todo });
};
