import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { text, presenter, type } = await request.json();
  if (!text?.trim()) return json({ error: 'Text required' }, 400);

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const headline = await one(sql()`
    insert into headlines (meeting_id, text, presenter, type)
    values (${meeting.id}, ${text.trim()}, ${presenter ?? null}, ${type ?? 'general'})
    returning *
  `);
  return json({ headline });
};
