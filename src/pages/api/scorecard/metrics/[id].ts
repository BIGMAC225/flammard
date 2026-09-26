import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../../lib/api';
import { buildUpdate, sql } from '../../../../lib/db';

const EDITABLE = ['title', 'owner', 'goal', 'unit', 'description', 'frequency', 'active', 'sort_order'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await request.json();
  const clean: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (key in body) clean[key] = typeof body[key] === 'string' ? body[key].trim() || null : body[key];
  }
  if ('title' in body && !clean.title) return json({ error: 'Title required' }, 400);

  const update = buildUpdate('scorecard_metrics', params.id!, clean, EDITABLE, { updated_at: new Date() });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const [metric] = await sql().query(update.text, update.params);
  if (!metric) return json({ error: 'Not found' }, 404);
  return json({ metric });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  await sql()`delete from scorecard_metrics where id = ${params.id!}`;
  return json({ ok: true });
};
