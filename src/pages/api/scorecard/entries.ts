import type { APIRoute } from 'astro';
import { json, requireUser } from '../../../lib/api';

// Manual scorecard entry for a period (upserts on metric + period).
export const POST: APIRoute = async ({ request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const body = await request.json();
  const { metric_id, period_date, value, on_track, notes } = body as {
    metric_id?: string;
    period_date?: string;
    value?: string;
    on_track?: boolean | null;
    notes?: string;
  };
  if (!metric_id || !period_date) return json({ error: 'Metric and period are required' }, 400);

  const { data: entry, error } = await supabase
    .from('scorecard_entries')
    .upsert(
      {
        metric_id,
        period_date,
        value: value?.trim() || null,
        on_track: on_track ?? null,
        notes: notes?.trim() || null,
        source: 'manual',
        created_by: user.id,
      },
      { onConflict: 'metric_id,period_date' }
    )
    .select('*')
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ entry });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const { supabase, response } = await requireUser(request, cookies);
  if (response) return response;

  const { id } = (await request.json()) as { id?: string };
  if (!id) return json({ error: 'Entry id required' }, 400);

  const { data, error } = await supabase.from('scorecard_entries').delete().eq('id', id).select('id');
  if (error) return json({ error: error.message }, 500);
  if (!data?.length) return json({ error: 'Entry not found' }, 404);
  return json({ ok: true });
};
