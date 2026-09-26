import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';

const STATUSES = ['planned', 'on_track', 'off_track', 'complete', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);
  if ('period_id' in body && body.period_id !== null && !isUuid(body.period_id)) return json({ error: 'Invalid period' }, 400);
  for (const k of ['title', 'owner', 'notes', 'quarter'] as const) {
    if (typeof body[k] === 'string') body[k] = body[k].trim() || null;
  }

  const update = buildUpdate('rocks', params.id!, body, ['title', 'owner', 'notes', 'status', 'period_id', 'quarter', 'due_date'], {
    updated_at: new Date(),
  });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const [rock] = await sql().query(update.text, update.params);
  if (!rock) return json({ error: 'Not found' }, 404);
  return json({ rock });
};

// Meeting snapshots keep their copy (rock_id becomes null); steps go with it.
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql().transaction([
    sql()`delete from steps where parent_type = 'rock' and parent_id = ${params.id!}`,
    sql()`delete from rocks where id = ${params.id!}`,
  ]);
  return json({ ok: true });
};
