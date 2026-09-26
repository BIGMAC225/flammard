import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { sql } from '../../../lib/db';

const STATUSES = ['on_track', 'off_track', 'complete', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  const body = await readBody(request);
  const { status } = body;
  if (!status) return json({ error: 'Status required' }, 400);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;
  const rows = await sql()`update meeting_rocks set status = ${status} where id = ${params.id!} returning id`;
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from meeting_rocks where id = ${params.id!}`;
  return json({ ok: true });
};
