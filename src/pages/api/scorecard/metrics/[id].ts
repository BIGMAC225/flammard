import type { APIRoute } from 'astro';
import { json, readBody, requireAuth, requireEnum, requireUuid } from '../../../../lib/api';
import { buildUpdate, sql } from '../../../../lib/db';
import { resolveOwner } from '../../../../lib/people';

const EDITABLE = ['title', 'owner', 'owner_id', 'goal', 'unit', 'description', 'frequency', 'active', 'sort_order'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  const invalid = requireEnum(body, 'frequency', ['weekly', 'monthly', 'quarterly']);
  if (invalid) return invalid;
  const clean: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (key === 'owner' || key === 'owner_id') continue;
    if (key in body) clean[key] = typeof body[key] === 'string' ? body[key].trim() || null : body[key];
  }
  // Owner: an id (or text from an old client, auto-matched) sets both columns
  if ('owner' in body || 'owner_id' in body) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    Object.assign(clean, owner);
  }
  if ('title' in body && !clean.title) return json({ error: 'Title required' }, 400);
  if ('active' in body && typeof clean.active !== 'boolean') return json({ error: 'Invalid active' }, 400);
  if ('sort_order' in body && !Number.isInteger(clean.sort_order)) return json({ error: 'Invalid sort_order' }, 400);

  const update = buildUpdate('scorecard_metrics', params.id!, clean, EDITABLE, { updated_at: new Date() });
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const [metric] = await sql().query(update.text, update.params);
  if (!metric) return json({ error: 'Not found' }, 404);
  return json({ metric });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql()`delete from scorecard_metrics where id = ${params.id!}`;
  return json({ ok: true });
};
