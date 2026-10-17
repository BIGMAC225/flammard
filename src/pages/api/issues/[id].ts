import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, one, sql } from '../../../lib/db';
import { HORIZONS, ISSUE_TYPES, PRIORITIES, solveRequirementMet } from '../../../lib/issues';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['open', 'solved', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid =
    requireEnum(body, 'status', STATUSES) ??
    requireEnum(body, 'priority', PRIORITIES) ??
    requireEnum(body, 'horizon', HORIZONS) ??
    (body.issue_type === null ? null : requireEnum(body, 'issue_type', ISSUE_TYPES));
  if (invalid) return invalid;
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);

  // Owner: an id (or text from an old client, auto-matched) sets both columns
  if ('owner' in body || 'owner_id' in body) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    Object.assign(body, owner);
  }

  const before = await one<{ horizon: string; resolution: string | null }>(sql()`select horizon, resolution from issues where id = ${params.id!}`);
  if (!before) return json({ error: 'Not found' }, 404);

  // EOS: solved means a resolution and usually a to-do. Needs one or the other.
  if (body.status === 'solved') {
    const resolution = 'resolution' in body ? body.resolution : before.resolution;
    if (!(await solveRequirementMet(params.id!, resolution))) {
      return json({ error: 'To mark an issue solved, write a resolution note or add a to-do for it' }, 400);
    }
  }

  // The meeting it was solved or dropped in (the meeting page sends it with the status)
  if ('resolved_in_meeting_id' in body && body.resolved_in_meeting_id !== null && !isUuid(body.resolved_in_meeting_id)) {
    return json({ error: 'Invalid resolved_in_meeting_id' }, 400);
  }
  // Solving stamps solved_at; reopening (or dropping) clears it. Reopening
  // also forgets which meeting closed it.
  const extra: Record<string, unknown> = { updated_at: new Date() };
  if ('status' in body) {
    extra.solved_at = body.status === 'solved' ? new Date() : null;
    extra.closed_by_analysis = false; // a person decided; a re-run analysis leaves it alone
    if (body.status === 'open') body.resolved_in_meeting_id = null;
  }
  if ('resolution' in body) extra.analysis_resolution = null; // typed by a person now

  const update = buildUpdate(
    'issues',
    params.id!,
    body,
    ['status', 'resolution', 'priority', 'title', 'description', 'horizon', 'owner', 'owner_id', 'resolved_in_meeting_id', 'issue_type'],
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
