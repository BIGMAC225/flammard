import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const todo = await one(sql()`
    insert into todos (meeting_id, team, title, owner, owner_id, status)
    values (${meeting.id}, ${meeting.team}, ${title.trim().slice(0, 500)}, ${owner.owner}, ${owner.owner_id}, 'open')
    returning *
  `);
  return json({ todo });
};
