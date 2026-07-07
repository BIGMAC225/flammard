import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server';

// Single shared account for the whole team. The login page only asks for a
// password; the email is fixed here and must match the user created in Supabase.
const SHARED_LOGIN_EMAIL = import.meta.env.SHARED_LOGIN_EMAIL || 'team@flammard.app';

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await request.json();
  const { password, next } = body as { password: string; next?: string };

  if (!password) {
    return new Response(JSON.stringify({ error: 'Password is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createSupabaseServerClient(request, cookies);
  const { error } = await supabase.auth.signInWithPassword({
    email: SHARED_LOGIN_EMAIL,
    password,
  });

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
