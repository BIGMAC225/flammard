import type { APIRoute } from 'astro';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { isUuid, json, readBody, requireAuth, requireUuid } from '../../../../lib/api';
import {
  descendantIds,
  normalizePeople,
  sanitizeRoles,
  survivingExtraParent,
  validateReparent,
  type SeatLink,
} from '../../../../lib/accountability';
import { many, one, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

// PATCH /api/accountability/seats/[id] — any of title, parent_id (checked by
// validateReparent over primary and extra edges: no self-parent, no loop, one
// root, same chart), roles, notes, sort_order, extra_parent_ids (uuid[]; the
// full replacement set of extra parents, validated the same way, duplicates
// dropped, the primary parent excluded), plus `people` (';'-joined text or
// array), which replaces the seat's people. Moving the primary parent to a
// seat that is already an extra parent removes that link. Everything goes in
// one transaction. The update is hand-rolled with an explicit ::text[] cast
// (the people route's pattern, src/pages/api/people/[id].ts) because
// buildUpdate cannot cast array params.
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
  if ('extra_parent_ids' in body) {
    const extras = body.extra_parent_ids;
    if (!Array.isArray(extras) || extras.some((p) => typeof p !== 'string' || !isUuid(p)))
      return json({ error: 'Invalid extra parents' }, 400);
  }
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

  // The chart's seats and links, once, for every check that needs the graph.
  const wantsParent = 'parent_id' in body;
  const wantsExtras = 'extra_parent_ids' in body;
  let chartSeats: Array<{ id: string; parent_id: string | null }> | null = null;
  let chartLinks: SeatLink[] = [];
  if (wantsParent || wantsExtras) {
    chartSeats = await many<{ id: string; parent_id: string | null }>(
      db`select id, parent_id from accountability_seats where chart_id = ${seat.chart_id}`
    );
    chartLinks = await many<SeatLink>(db`
      select l.seat_id, l.parent_id from accountability_seat_links l
      join accountability_seats s on s.id = l.seat_id
      where s.chart_id = ${seat.chart_id}
      order by l.created_at, l.id
    `);
  }

  let newParentId: string | null = null;
  if (wantsParent) {
    newParentId =
      body.parent_id === null || body.parent_id === '' ? null : (body.parent_id as string);
    const check = validateReparent(chartSeats!, seat.id, newParentId, chartLinks);
    if ('error' in check) return json({ error: check.error }, 400);
  }

  let extraQueries: NeonQueryPromise<false, false>[] | null = null;
  if (wantsExtras) {
    const primaryNow = wantsParent
      ? newParentId
      : chartSeats!.find((s) => s.id === seat.id)?.parent_id ?? null;
    const extras = [...new Set(body.extra_parent_ids as string[])].filter((p) => p !== primaryNow);
    for (const p of extras) {
      const check = validateReparent(chartSeats!, seat.id, p, chartLinks);
      if ('error' in check) return json({ error: `Extra parent: ${check.error}` }, 400);
    }
    extraQueries = [
      db`delete from accountability_seat_links where seat_id = ${seat.id}`,
      ...extras.map(
        (p) => db`insert into accountability_seat_links (seat_id, parent_id) values (${seat.id}, ${p})`
      ),
    ];
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
  // The new primary parent stops being an extra parent (extra_parent_ids'
  // replacement already drops it when both were sent).
  if (wantsParent && newParentId && !wantsExtras) {
    queries.push(
      db`delete from accountability_seat_links where seat_id = ${seat.id} and parent_id = ${newParentId}`
    );
  }
  if (extraQueries) queries.push(...extraQueries);
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
// (parent_id cascades), with its people — except a child whose primary parent
// is the deleted seat and which has an extra parent that survives the delete:
// that extra parent is promoted to primary (first by created_at) and the link
// removed, so pooled seats are never lost. Children without a surviving extra
// parent go with the subtree as before.
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  const db = sql();
  const seat = await one<{ id: string; chart_id: string }>(
    db`select id, chart_id from accountability_seats where id = ${params.id!}`
  );
  if (!seat) return json({ error: 'Not found' }, 404);
  const seats = await many<{ id: string; parent_id: string | null }>(
    db`select id, parent_id from accountability_seats where chart_id = ${seat.chart_id}`
  );
  const links = await many<SeatLink>(db`
    select l.seat_id, l.parent_id from accountability_seat_links l
    join accountability_seats s on s.id = l.seat_id
    where s.chart_id = ${seat.chart_id}
    order by l.created_at, l.id
  `);
  const doomed = descendantIds(seats, seat.id); // primary edges only: what the cascade removes
  const queries: NeonQueryPromise<false, false>[] = [];
  for (const child of seats.filter((s) => s.parent_id === seat.id)) {
    const keep = survivingExtraParent(links, child.id, doomed);
    if (!keep) continue; // no surviving extra parent: the child goes with the subtree
    queries.push(
      db`delete from accountability_seat_links where seat_id = ${child.id} and parent_id = ${keep}`,
      db`update accountability_seats set parent_id = ${keep}, updated_at = now() where id = ${child.id}`
    );
  }
  queries.push(db`delete from accountability_seats where id = ${seat.id}`);
  await db.transaction(queries);
  return json({ ok: true });
};
