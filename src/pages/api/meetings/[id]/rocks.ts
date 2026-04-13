import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const { id } = params;
  const { title, owner, status } = await request.json();
  if (!title?.trim()) return new Response(JSON.stringify({ error: 'Title required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  // Ensure the meeting belongs to the user
  const { data: meeting } = await supabase.from('meetings').select('id').eq('id', id).eq('created_by', user.id).single();
  if (!meeting) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

  // Create or find top-level rock
  const { data: existingRock } = await supabase
    .from('rocks')
    .select('id')
    .eq('title', title.trim())
    .eq('created_by', user.id)
    .maybeSingle();

  let rockId = existingRock?.id;
  if (!rockId) {
    const { data: newRock } = await supabase
      .from('rocks')
      .insert({ title: title.trim(), owner: owner ?? null, status: status ?? 'on_track', created_by: user.id })
      .select('id')
      .single();
    rockId = newRock?.id;
  }

  const { data: rock, error } = await supabase
    .from('meeting_rocks')
    .insert({
      meeting_id: id,
      rock_id: rockId ?? null,
      title: title.trim(),
      owner: owner ?? null,
      status: status ?? 'on_track',
      created_by: user.id,
    })
    .select('*')
    .single();

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ rock }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
