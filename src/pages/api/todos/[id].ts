import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const update = buildUpdate('todos', params.id!, await request.json(), ['status', 'title', 'owner'], { updated_at: new Date() });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const rows = await sql().query(update.text, update.params);
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  await sql()`delete from todos where id = ${params.id!}`;
  return json({ ok: true });
};
