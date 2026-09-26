import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';

const STATUSES = ['open', 'done', 'not_done', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;

  const update = buildUpdate('todos', params.id!, body, ['status', 'title', 'owner'], { updated_at: new Date() });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const rows = await sql().query(update.text, update.params);
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from todos where id = ${params.id!}`;
  return json({ ok: true });
};
