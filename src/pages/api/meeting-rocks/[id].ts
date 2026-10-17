import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['on_track', 'off_track', 'complete', 'dropped'];

// Updates a meeting's rock snapshot: its status and/or its owner. The status
// is the weekly review, so it is written through to the team rock it points
// at (by id) — next week's meeting then carries the rock over as on/off
// track, and a rock marked complete or dropped leaves the active list.
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
  const snapshot = rows[0];
  if (body.status && snapshot.rock_id) {
    await sql()`
      update rocks set status = ${body.status},
        completed_at = case when ${body.status}::text = 'complete' then coalesce(completed_at, now()) else null end,
        updated_at = now()
      where id = ${snapshot.rock_id} and status <> ${body.status}
    `;
  }
  return json({ ok: true, rock: snapshot });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from meeting_rocks where id = ${params.id!}`;
  return json({ ok: true });
};
