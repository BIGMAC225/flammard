import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { resolveOwner } from '../../../lib/people';
import { currentTeam } from '../../../lib/teams';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly'];

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const title = str(body.title);
  if (!title) return json({ error: 'Title required' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);

  const team = currentTeam(cookies);
  const metric = await one(sql()`
    insert into scorecard_metrics (team, title, owner, owner_id, goal, unit, description, frequency, sort_order)
    values (
      ${team}, ${title}, ${owner.owner}, ${owner.owner_id}, ${str(body.goal)}, ${str(body.unit)},
      ${str(body.description)}, ${FREQUENCIES.includes(body.frequency) ? body.frequency : 'weekly'},
      (select count(*) from scorecard_metrics where team = ${team})
    )
    returning *
  `);
  return json({ metric });
};
