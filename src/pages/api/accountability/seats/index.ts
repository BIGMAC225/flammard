import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { isUuid, json, readBody, requireAuth } from '../../../../lib/api';
import { normalizePeople, sanitizeRoles, type SeatPersonRow } from '../../../../lib/accountability';
import { one, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

// POST /api/accountability/seats — one seat in a chart. `people` is the seed's
// ';'-joined text (or an array); each name resolves to a person id when it
// matches one and stays free text otherwise (resolveOwner). The seat and its
// people go in as one transaction.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const body = await readBody(request);
  if (!isUuid(body.chart_id)) return json({ error: 'Chart id required' }, 400);
  if (typeof body.title !== 'string' || !body.title.trim()) return json({ error: 'Title required' }, 400);
  const parentId =
    body.parent_id === undefined || body.parent_id === null || body.parent_id === ''
      ? null
      : body.parent_id;
  if (parentId !== null && !isUuid(parentId)) return json({ error: 'Invalid parent' }, 400);

  const db = sql();
  const chart = await one(db`select id from accountability_charts where id = ${body.chart_id}`);
  if (!chart) return json({ error: 'Chart not found' }, 404);
  if (parentId !== null) {
    const parent = await one(
      db`select id from accountability_seats where id = ${parentId} and chart_id = ${body.chart_id}`
    );
    if (!parent) return json({ error: 'Parent not in this chart' }, 400);
  } else {
    const root = await one(
      db`select id from accountability_seats where chart_id = ${body.chart_id} and parent_id is null`
    );
    if (root) return json({ error: 'A chart has one root' }, 400);
  }

  const names = normalizePeople(body.people);
  const people: Array<{ person_id: string | null; person: string | null }> = [];
  for (const name of names) {
    const hit = await resolveOwner({ owner: name });
    if ('error' in hit) return json({ error: hit.error }, 400);
    people.push({ person_id: hit.owner_id, person: hit.owner });
  }

  const seatId = randomUUID();
  const queries: NeonQueryPromise<false, false>[] = [
    db`
      insert into accountability_seats (id, chart_id, parent_id, title, roles, notes, sort_order)
      values (${seatId}, ${body.chart_id}, ${parentId}, ${body.title.trim()},
              ${sanitizeRoles(body.roles)}::text[],
              ${typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null},
              ${typeof body.sort_order === 'number' && Number.isInteger(body.sort_order) ? body.sort_order : 0})
    `,
    ...people.map(
      (p, i) => db`
        insert into accountability_seat_people (seat_id, person_id, person, sort_order)
        values (${seatId}, ${p.person_id}, ${p.person}, ${i})
      `
    ),
  ];
  await db.transaction(queries);
  const seat = await one<Record<string, unknown>>(db`select * from accountability_seats where id = ${seatId}`);
  const seatPeople: SeatPersonRow[] = people.map((p, i) => ({
    seat_id: seatId,
    person_id: p.person_id,
    person: p.person,
    sort_order: i,
  }));
  return json({ seat: { ...seat, people: seatPeople } });
};
