import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { json, readBody, requireAuth } from '../../../lib/api';
import type { ChartRow, SeatLink, SeatPersonRow, SeatRow } from '../../../lib/accountability';
import { many, one, sql } from '../../../lib/db';

// GET /api/accountability?status=current|proposal — that chart with its seats
// (each carrying its people) and its extra-parent links, or
// { chart: null, seats: [], links: [] } when none exists.
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const status = url.searchParams.get('status') === 'proposal' ? 'proposal' : 'current';
  const db = sql();
  const chart = await one<ChartRow>(
    db`select * from accountability_charts where status = ${status} order by created_at desc limit 1`
  );
  if (!chart) return json({ chart: null, seats: [], links: [] });
  const seats = await many<SeatRow>(
    db`select * from accountability_seats where chart_id = ${chart.id} order by sort_order, created_at`
  );
  const people = await many<SeatPersonRow>(db`
    select * from accountability_seat_people
    where seat_id in (select id from accountability_seats where chart_id = ${chart.id})
    order by sort_order, created_at
  `);
  const links = await many<SeatLink>(db`
    select l.seat_id, l.parent_id from accountability_seat_links l
    join accountability_seats s on s.id = l.seat_id
    where s.chart_id = ${chart.id}
    order by l.created_at, l.id
  `);
  const bySeat = new Map<string, SeatPersonRow[]>();
  for (const person of people) {
    const list = bySeat.get(person.seat_id) ?? [];
    list.push(person);
    bySeat.set(person.seat_id, list);
  }
  return json({
    chart,
    seats: seats.map((s) => ({ ...s, people: bySeat.get(s.id) ?? [] })),
    links,
  });
};

// POST /api/accountability — a new proposal chart. `copy_from: 'current'`
// clones the current chart's seats, people and extra-parent links into it,
// remapping ids and parents; without it (or with no current chart) the
// proposal starts empty.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const body = await readBody(request);
  if (body.copy_from != null && body.copy_from !== 'current') {
    return json({ error: 'Invalid copy_from' }, 400);
  }
  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Accountability Chart';
  const db = sql();

  const source =
    body.copy_from === 'current'
      ? await one<ChartRow>(db`select * from accountability_charts where status = 'current'`)
      : null;
  const chartId = randomUUID();
  const seatIds = new Map<string, string>(); // source seat id -> new seat id
  const queries: NeonQueryPromise<false, false>[] = [
    db`insert into accountability_charts (id, title, status) values (${chartId}, ${title}, 'proposal')`,
  ];
  if (source) {
    const seats = await many<SeatRow>(
      db`select * from accountability_seats where chart_id = ${source.id} order by sort_order, created_at`
    );
    for (const seat of seats) seatIds.set(seat.id, randomUUID());
    for (const seat of seats) {
      queries.push(db`
        insert into accountability_seats (id, chart_id, parent_id, title, roles, notes, sort_order)
        values (${seatIds.get(seat.id)}, ${chartId}, ${seat.parent_id ? seatIds.get(seat.parent_id) ?? null : null},
                ${seat.title}, ${seat.roles}::text[], ${seat.notes}, ${seat.sort_order})
      `);
    }
    const people = await many<SeatPersonRow>(db`
      select * from accountability_seat_people
      where seat_id in (select id from accountability_seats where chart_id = ${source.id})
      order by sort_order, created_at
    `);
    for (const person of people) {
      queries.push(db`
        insert into accountability_seat_people (seat_id, person_id, person, sort_order)
        values (${seatIds.get(person.seat_id)}, ${person.person_id}, ${person.person}, ${person.sort_order})
      `);
    }
    const links = await many<SeatLink>(db`
      select l.seat_id, l.parent_id from accountability_seat_links l
      join accountability_seats s on s.id = l.seat_id
      where s.chart_id = ${source.id}
      order by l.created_at, l.id
    `);
    for (const link of links) {
      if (!seatIds.has(link.parent_id)) continue; // stale cross-chart row: skip, not crash
      queries.push(db`
        insert into accountability_seat_links (seat_id, parent_id)
        values (${seatIds.get(link.seat_id)}, ${seatIds.get(link.parent_id)})
      `);
    }
  }
  await db.transaction(queries);
  const chart = await one<ChartRow>(db`select * from accountability_charts where id = ${chartId}`);
  return json({ chart });
};
