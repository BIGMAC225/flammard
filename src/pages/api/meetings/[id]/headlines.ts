import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const { id } = params;
  const { text, presenter, type } = await request.json();
  if (!text?.trim()) return new Response(JSON.stringify({ error: 'Text required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const { data: meeting } = await supabase.from('meetings').select('id').eq('id', id).eq('created_by', user.id).single();
  if (!meeting) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

  const { data: headline, error } = await supabase
    .from('headlines')
    .insert({
      meeting_id: id,
      text: text.trim(),
      presenter: presenter ?? null,
      type: type ?? 'general',
      created_by: user.id,
    })
    .select('*')
    .single();

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ headline }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
