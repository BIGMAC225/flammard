import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';

// POST /api/accountability/promote — one transaction: the chosen proposal
// becomes the one current chart, the old current (if any) becomes a proposal.
// The middleware gates this route on structure.manage.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const body = await readBody(request);
  if (!isUuid(body.chart_id)) return json({ error: 'Chart id required' }, 400);
  const db = sql();
  const target = await one(db`select id from accountability_charts where id = ${body.chart_id}`);
  if (!target) return json({ error: 'Not found' }, 404);
  await db.transaction([
    db`update accountability_charts set status = 'proposal', updated_at = now() where status = 'current'`,
    db`update accountability_charts set status = 'current', updated_at = now() where id = ${body.chart_id}`,
  ]);
  return json({ ok: true });
};
