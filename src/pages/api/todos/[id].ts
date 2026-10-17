import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { isIsoDate } from '../../../lib/dates';
import { buildUpdate, sql } from '../../../lib/db';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['open', 'done', 'not_done', 'dropped'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;
  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim()) return json({ error: 'Title required' }, 400);
    body.title = body.title.trim().slice(0, 500);
  }
  if ('due_date' in body) {
    if (body.due_date === '') body.due_date = null;
    if (body.due_date !== null && !isIsoDate(body.due_date)) return json({ error: 'Invalid due date' }, 400);
  }
  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') return json({ error: 'Invalid description' }, 400);
    body.description = body.description?.trim() || null;
  }
  // Owner: an id (or text from an old client, auto-matched) sets both columns
  if ('owner' in body || 'owner_id' in body) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    Object.assign(body, owner);
  }
  // The meeting a review happened in (the meeting page sends it with the status)
  if ('resolved_meeting_id' in body && body.resolved_meeting_id !== null && !isUuid(body.resolved_meeting_id)) {
    return json({ error: 'Invalid resolved_meeting_id' }, 400);
  }
  // Done stamps completed_at; any other status clears it. Reopening forgets
  // which meeting closed it.
  const extra: Record<string, unknown> = { updated_at: new Date() };
  if ('status' in body) {
    extra.completed_at = body.status === 'done' ? new Date() : null;
    extra.closed_by_analysis = false; // a person decided; a re-run analysis leaves it alone
    if (body.status === 'open') body.resolved_meeting_id = null;
  }

  const update = buildUpdate(
    'todos',
    params.id!,
    body,
    ['status', 'title', 'owner', 'owner_id', 'due_date', 'description', 'resolved_meeting_id'],
    extra
  );
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const rows = await sql().query(`${update.text}, due_date::text as due_date, created_at::text as created_at`, update.params);
  if (!rows.length) return json({ error: 'Not found' }, 404);
  return json({ ok: true, todo: rows[0] });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql().transaction([
    sql()`delete from steps where parent_type = 'todo' and parent_id = ${params.id!}`,
    sql()`delete from todos where id = ${params.id!}`,
  ]);
  return json({ ok: true });
};
