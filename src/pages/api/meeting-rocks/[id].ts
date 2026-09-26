import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { sql } from '../../../lib/db';

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const { status } = await request.json();
  if (!status) return json({ error: 'Status required' }, 400);
  const rows = await sql()`update meeting_rocks set status = ${status} where id = ${params.id!} returning id`;
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  await sql()`delete from meeting_rocks where id = ${params.id!}`;
  return json({ ok: true });
};
