import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server';

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await request.json();
  const { email, password, next } = body as { email: string; password: string; next?: string };

  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Email and password are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createSupabaseServerClient(request, cookies);
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const redirectTo = next && next.startsWith('/') ? next : '/dashboard';

  return new Response(JSON.stringify({ next: redirectTo }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
