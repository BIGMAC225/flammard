import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireUuid } from '../../../lib/api';
import { sql } from '../../../lib/db';

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  if ('done' in body && typeof body.done !== 'boolean') return json({ error: 'Invalid done' }, 400);
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);
  if (typeof body.title === 'string') body.title = body.title.trim().slice(0, 500);

  const id = params.id!;
  const db = sql();

  if (typeof body.title === 'string') {
    const [step] = await db`update steps set title = ${body.title}, updated_at = now() where id = ${id} returning *`;
    if (!step) return json({ error: 'Not found' }, 404);
    if (typeof body.done !== 'boolean') return json({ step });
  }

  // Ticking a step ticks its sub-steps; un-ticking a sub-step un-ticks its
  // step. One statement each, so the cascade can't half-apply.
  if (typeof body.done === 'boolean') {
    const rows = body.done
      ? await db`update steps set done = true, updated_at = now() where id = ${id} or parent_step_id = ${id} returning *`
      : await db`update steps set done = false, updated_at = now()
                 where id = ${id} or id = (select parent_step_id from steps where id = ${id}) returning *`;
    const step = rows.find((r) => r.id === id);
    if (!step) return json({ error: 'Not found' }, 404);
    return json({ step });
  }

  return json({ error: 'Nothing to update' }, 400);
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from steps where id = ${params.id!}`; // sub-steps cascade
  return json({ ok: true });
};
