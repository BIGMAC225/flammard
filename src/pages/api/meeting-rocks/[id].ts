import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['on_track', 'off_track', 'complete', 'dropped'];

// Updates a meeting's rock snapshot: its status and/or its owner.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  const body = await readBody(request);
  const ownerSent = 'owner' in body || 'owner_id' in body;
  if (!body.status && !ownerSent) return json({ error: 'Status required' }, 400);
  if ('status' in body && !body.status) return json({ error: 'Status required' }, 400);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;

  const fields: Record<string, unknown> = {};
  if (body.status) fields.status = body.status;
  if (ownerSent) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    Object.assign(fields, owner);
  }

  const update = buildUpdate('meeting_rocks', params.id!, fields, ['status', 'owner', 'owner_id']);
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const rows = await sql().query(update.text, update.params);
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true, rock: rows[0] });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from meeting_rocks where id = ${params.id!}`;
  return json({ ok: true });
};
