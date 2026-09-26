import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly'];

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await request.json();
  const title = (body.title ?? '').trim();
  if (!title) return json({ error: 'Title required' }, 400);

  const team = currentTeam(cookies);
  const metric = await one(sql()`
    insert into scorecard_metrics (team, title, owner, goal, unit, description, frequency, sort_order)
    values (
      ${team}, ${title}, ${body.owner?.trim() || null}, ${body.goal?.trim() || null}, ${body.unit?.trim() || null},
      ${body.description?.trim() || null}, ${FREQUENCIES.includes(body.frequency) ? body.frequency : 'weekly'},
      (select count(*) from scorecard_metrics where team = ${team})
    )
    returning *
  `);
  return json({ metric });
};
