import type { APIRoute } from 'astro';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { isUuid, json, readBody, requireAuth, requireUuid } from '../../../../lib/api';
import { normalizePeople, sanitizeRoles, validateReparent } from '../../../../lib/accountability';
import { many, one, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

// PATCH /api/accountability/seats/[id] — any of title, parent_id (checked by
// validateReparent: no self-parent, no loop, one root, same chart), roles,
// notes, sort_order, plus `people` (';'-joined text or array), which replaces
// the seat's people. Everything goes in one transaction. The update is
// hand-rolled with an explicit ::text[] cast (the people route's pattern,
// src/pages/api/people/[id].ts) because buildUpdate cannot cast array params.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  const body = await readBody(request);
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim()))
    return json({ error: 'Title required' }, 400);
  if (
    'parent_id' in body &&
    body.parent_id !== null &&
    body.parent_id !== '' &&
    !isUuid(body.parent_id)
  )
    return json({ error: 'Invalid parent' }, 400);
  if (
    'sort_order' in body &&
    (typeof body.sort_order !== 'number' || !Number.isInteger(body.sort_order))
  )
    return json({ error: 'Invalid sort_order' }, 400);

  const db = sql();
  const seat = await one<{ id: string; chart_id: string }>(
    db`select id, chart_id from accountability_seats where id = ${params.id}`
  );
  if (!seat) return json({ error: 'Not found' }, 404);

  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown, cast = '') => {
    values.push(val);
    sets.push(`${col} = $${values.length}${cast}`);
  };
  if ('title' in body) set('title', (body.title as string).trim());
  if ('parent_id' in body)
    set('parent_id', body.parent_id === null || body.parent_id === '' ? null : body.parent_id);
  if ('roles' in body) set('roles', sanitizeRoles(body.roles), '::text[]');
  if ('notes' in body)
    set('notes', typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null);
  if ('sort_order' in body) set('sort_order', body.sort_order);

  if ('parent_id' in body) {
    const seats = await many<{ id: string; parent_id: string | null }>(
      db`select id, parent_id from accountability_seats where chart_id = ${seat.chart_id}`
    );
    const newParentId =
      body.parent_id === null || body.parent_id === '' ? null : (body.parent_id as string);
    const check = validateReparent(seats, seat.id, newParentId);
    if ('error' in check) return json({ error: check.error }, 400);
  }

  let peopleQueries: NeonQueryPromise<false, false>[] | null = null;
  if ('people' in body) {
    const names = normalizePeople(body.people);
    const resolved: Array<{ owner_id: string | null; owner: string | null }> = [];
    for (const name of names) {
      const hit = await resolveOwner({ owner: name });
      if ('error' in hit) return json({ error: hit.error }, 400);
      resolved.push({ owner_id: hit.owner_id, owner: hit.owner });
    }
    peopleQueries = [
      db`delete from accountability_seat_people where seat_id = ${seat.id}`,
      ...resolved.map(
        (p, i) => db`
          insert into accountability_seat_people (seat_id, person_id, person, sort_order)
          values (${seat.id}, ${p.owner_id}, ${p.owner}, ${i})
        `
      ),
    ];
  }

  const queries: NeonQueryPromise<false, false>[] = [];
  if (sets.length) {
    sets.push('updated_at = now()');
    values.push(seat.id);
    queries.push(
      db.query(
        `update accountability_seats set ${sets.join(', ')} where id = $${values.length} returning *`,
        values
      )
    );
  }
  if (peopleQueries) queries.push(...peopleQueries);
  if (!queries.length) return json({ error: 'Nothing to update' }, 400);
  await db.transaction(queries);

  const fresh = await one<Record<string, unknown>>(db`select * from accountability_seats where id = ${seat.id}`);
  const people = await many(
    db`select * from accountability_seat_people where seat_id = ${seat.id} order by sort_order, created_at`
  );
  return json({ seat: { ...fresh, people } });
};

// DELETE /api/accountability/seats/[id] — the seat and everything below it
// (parent_id cascades), with its people.
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from accountability_seats where id = ${params.id!}`;
  return json({ ok: true });
};
