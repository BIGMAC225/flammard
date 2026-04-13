import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';
import type { Decision, ActionItem, DiscussionPoint } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const { data: { user } } = await supabase.auth.getUser();

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

  const { data: meeting } = await supabase
    .from('meetings')
    .select('created_by, status')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Upsert — creates on first save, updates on subsequent saves
  const { error } = await supabase
    .from('minutes')
    .upsert(
      { meeting_id: id, summary, decisions, actions, discussion },
      { onConflict: 'meeting_id' }
    );

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Advance status to minutes_draft if still in draft
  if (meeting.status === 'draft') {
    await supabase.from('meetings').update({ status: 'minutes_draft' }).eq('id', id);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
