import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum } from '../../../lib/api';
import { sql } from '../../../lib/db';
import { HORIZONS } from '../../../lib/issues';
import { currentTeam } from '../../../lib/teams';

// Saves the order of one issues list: `ids` top to bottom become rank 1..n.
// Only open issues of the active team in that list are touched, so a stale
// page can't pull issues across teams or lists.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'horizon', HORIZONS);
  if (invalid) return invalid;
  const horizon = body.horizon ?? 'short';
  const ids: unknown[] = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length || ids.length > 500 || !ids.every(isUuid)) return json({ error: 'ids must be a list of issue ids' }, 400);

  await sql()`
    update issues x set rank = o.n, updated_at = now()
    from unnest(${ids}::uuid[]) with ordinality as o(id, n)
    where x.id = o.id and x.team = ${currentTeam(cookies)} and x.horizon = ${horizon}
  `;
  return json({ ok: true });
};
