import type { APIRoute } from 'astro';
import { json, requireUser } from '../../../../lib/api';

const EDITABLE = ['title', 'owner', 'goal', 'unit', 'description', 'frequency', 'active', 'sort_order'];

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, response } = await requireUser(request, cookies);
  if (response) return response;

  const body = await request.json();
  const update: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (key in body) update[key] = typeof body[key] === 'string' ? body[key].trim() || null : body[key];
  }
  if ('title' in body && !update.title) return json({ error: 'Title required' }, 400);

  const { data: metric, error } = await supabase
    .from('scorecard_metrics')
    .update(update)
    .eq('id', params.id)
    .select('*')
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ metric });
};

export const DELETE: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, response } = await requireUser(request, cookies);
  if (response) return response;

  const { error } = await supabase.from('scorecard_metrics').delete().eq('id', params.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};
