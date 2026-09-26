import type { AstroCookies } from 'astro';
import { createSupabaseServerClient } from './supabase-server';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Resolves the signed-in user, or a 401 response to return as-is. */
export async function requireUser(request: Request, cookies: AstroCookies) {
  const supabase = createSupabaseServerClient(request, cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, response: json({ error: 'Unauthorized' }, 401) };
  return { supabase, user, response: null };
}

/** Loads a meeting the user owns, or a 403 response. */
export async function requireMeeting(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  userId: string,
  meetingId: string | undefined,
  columns = '*'
) {
  const { data: meeting } = await supabase
    .from('meetings')
    .select(columns)
    .eq('id', meetingId ?? '')
    .eq('created_by', userId)
    .maybeSingle();
  if (!meeting) return { meeting: null, response: json({ error: 'Forbidden' }, 403) };
  // Columns are caller-chosen, so the row is typed loosely
  return { meeting: meeting as Record<string, any>, response: null };
}
