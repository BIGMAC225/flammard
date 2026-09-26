import type { APIRoute } from 'astro';
import { json, requireUser } from '../../../lib/api';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly'];

export const POST: APIRoute = async ({ request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const body = await request.json();
  const title = (body.title ?? '').trim();
  if (!title) return json({ error: 'Title required' }, 400);

  const { count } = await supabase
    .from('scorecard_metrics')
    .select('id', { count: 'exact', head: true });

  const { data: metric, error } = await supabase
    .from('scorecard_metrics')
    .insert({
      title,
      owner: body.owner?.trim() || null,
      goal: body.goal?.trim() || null,
      unit: body.unit?.trim() || null,
      description: body.description?.trim() || null,
      frequency: FREQUENCIES.includes(body.frequency) ? body.frequency : 'weekly',
      sort_order: count ?? 0,
      created_by: user.id,
    })
    .select('*')
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ metric });
};
