import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, description, priority } = await request.json();
  if (!title?.trim()) return json({ error: 'Title required' }, 400);

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const issue = await one(sql()`
    insert into issues (meeting_id, title, description, priority, status)
    values (${meeting.id}, ${title.trim()}, ${description ?? null}, ${priority ?? 'medium'}, 'open')
    returning *
  `);
  return json({ issue });
};
