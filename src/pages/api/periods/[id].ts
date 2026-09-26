import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';
import { isIsoDate } from '../../../lib/dates';

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) return json({ error: 'Name required' }, 400);
  if ('start_date' in body && !isIsoDate(body.start_date)) return json({ error: 'Invalid start date' }, 400);
  if ('end_date' in body && !isIsoDate(body.end_date)) return json({ error: 'Invalid end date' }, 400);
  if (typeof body.name === 'string') body.name = body.name.trim();

  const update = buildUpdate('periods', params.id!, body, ['name', 'start_date', 'end_date']);
  if (!update) return json({ error: 'Nothing to update' }, 400);
  try {
    const [period] = await sql().query(update.text, update.params);
    if (!period) return json({ error: 'Not found' }, 404);
    return json({ period });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/periods_team_name_key/.test(message)) return json({ error: 'A period with that name already exists' }, 409);
    if (/periods_check/.test(message)) return json({ error: 'The end date must be on or after the start date' }, 400);
    return json({ error: 'Could not update the period' }, 400);
  }
};

// Rocks in a deleted period become unplaced (FK on delete set null)
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from periods where id = ${params.id!}`;
  return json({ ok: true });
};
