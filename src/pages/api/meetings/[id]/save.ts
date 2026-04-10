import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import type { Decision, ActionItem, DiscussionPoint } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = params;
  const body = await request.json();
  const { summary, decisions, actions, discussion } = body as {
    summary: string;
    decisions: Decision[];
    actions: ActionItem[];
    discussion: DiscussionPoint[];
  };

  // Verify meeting ownership
  const { data: meeting } = await supabase
    .from('meetings')
    .select('created_by')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { error } = await supabase
    .from('minutes')
    .update({ summary, decisions, actions, discussion })
    .eq('meeting_id', id);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
