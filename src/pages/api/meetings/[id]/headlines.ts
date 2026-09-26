import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth, requireEnum } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { text, type } = body;
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'Text required' }, 400);
  const invalid = requireEnum(body, 'type', ['customer', 'employee', 'general']);
  if (invalid) return invalid;
  // presenter_id, or presenter text (auto-matched), resolves like an owner
  const presenter = await resolveOwner({ owner_id: body.presenter_id, owner: body.presenter });
  if ('error' in presenter) return json({ error: presenter.error.replace('owner', 'presenter').replace('Owner', 'Presenter') }, 400);

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const headline = await one(sql()`
    insert into headlines (meeting_id, team, text, presenter, presenter_id, type)
    values (${meeting.id}, ${meeting.team}, ${text.trim()}, ${presenter.owner}, ${presenter.owner_id}, ${type ?? 'general'})
    returning *
  `);
  return json({ headline });
};
