import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, owner } = await readBody(request);
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const todo = await one(sql()`
    insert into todos (meeting_id, team, title, owner, status)
    values (${meeting.id}, ${meeting.team}, ${title.trim().slice(0, 500)}, ${typeof owner === 'string' && owner.trim() ? owner.trim() : null}, 'open')
    returning *
  `);
  return json({ todo });
};
