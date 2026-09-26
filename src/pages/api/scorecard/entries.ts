import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth } from '../../../lib/api';
import { isIsoDate } from '../../../lib/dates';
import { one, sql } from '../../../lib/db';

// Manual scorecard entry for a period (upserts on metric + period).
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { metric_id, period_date, value, on_track, notes } = await readBody(request);
  if (!isUuid(metric_id) || !isIsoDate(period_date)) return json({ error: 'Metric and a valid period date are required' }, 400);

  const entry = await one(sql()`
    insert into scorecard_entries (metric_id, period_date, value, on_track, notes, source)
    values (${metric_id}, ${period_date}, ${value?.trim() || null}, ${on_track ?? null}, ${notes?.trim() || null}, 'manual')
    on conflict (metric_id, period_date) do update set
      value = excluded.value, on_track = excluded.on_track, notes = excluded.notes, source = 'manual'
    returning *
  `);
  return json({ entry });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { id } = await readBody(request);
  if (!isUuid(id)) return json({ error: 'Entry id required' }, 400);

  const rows = await sql()`delete from scorecard_entries where id = ${id} returning id`;
  if (!rows.length) return json({ error: 'Entry not found' }, 404);
  return json({ ok: true });
};
