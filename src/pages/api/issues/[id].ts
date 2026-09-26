import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, one, sql } from '../../../lib/db';
import { HORIZONS, PRIORITIES } from '../../../lib/issues';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['open', 'solved', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid =
    requireEnum(body, 'status', STATUSES) ?? requireEnum(body, 'priority', PRIORITIES) ?? requireEnum(body, 'horizon', HORIZONS);
  if (invalid) return invalid;
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);

  // Owner: an id (or text from an old client, auto-matched) sets both columns
  if ('owner' in body || 'owner_id' in body) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    Object.assign(body, owner);
  }

  const before = await one<{ horizon: string }>(sql()`select horizon from issues where id = ${params.id!}`);
  if (!before) return json({ error: 'Not found' }, 404);

  // Solving stamps solved_at; reopening (or dropping) clears it
  const extra: Record<string, unknown> = { updated_at: new Date() };
  if ('status' in body) extra.solved_at = body.status === 'solved' ? new Date() : null;

  const update = buildUpdate(
    'issues',
    params.id!,
    body,
    ['status', 'resolution', 'priority', 'title', 'description', 'horizon', 'owner', 'owner_id'],
    extra
  );
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const rows = await sql().query(update.text, update.params);
  if (!rows.length) return json({ error: 'Not found' }, 404);

  // Moved to the other list: it joins that list at the bottom
  if (body.horizon && body.horizon !== before.horizon) {
    const moved = await one(sql()`
      update issues x set rank = (
        select coalesce(max(y.rank), 0) + 1 from issues y where y.team = x.team and y.horizon = x.horizon and y.id <> x.id
      )
      where x.id = ${params.id!}
      returning *
    `);
    return json({ ok: true, issue: moved });
  }
  return json({ ok: true, issue: rows[0] });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql().transaction([
    sql()`delete from steps where parent_type = 'issue' and parent_id = ${params.id!}`,
    sql()`delete from issues where id = ${params.id!}`,
  ]);
  return json({ ok: true });
};
