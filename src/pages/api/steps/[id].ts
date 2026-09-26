import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireUuid } from '../../../lib/api';
import { buildUpdate, sql } from '../../../lib/db';

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  if ('done' in body && typeof body.done !== 'boolean') return json({ error: 'Invalid done' }, 400);
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);
  if (typeof body.title === 'string') body.title = body.title.trim().slice(0, 500);

  const update = buildUpdate('steps', params.id!, body, ['done', 'title'], { updated_at: new Date() });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const [step] = await sql().query(update.text, update.params);
  if (!step) return json({ error: 'Not found' }, 404);

  // Ticking a step ticks its sub-steps; un-ticking a sub-step un-ticks the step
  if (typeof body.done === 'boolean') {
    if (body.done) await sql()`update steps set done = true, updated_at = now() where parent_step_id = ${params.id!}`;
    else if (step.parent_step_id) await sql()`update steps set done = false, updated_at = now() where id = ${step.parent_step_id}`;
  }
  return json({ step });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from steps where id = ${params.id!}`; // sub-steps cascade
  return json({ ok: true });
};
