import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server';

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await request.json();
  const { name, email, password } = body as { name: string; email: string; password: string };

  if (!name || !email || !password) {
    return new Response(JSON.stringify({ error: 'All fields are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const appUrl = import.meta.env.PUBLIC_APP_URL ?? '';
  const supabase = createSupabaseServerClient(request, cookies);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: `${appUrl}/dashboard`,
    },
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // If email confirmation is required, session will be null
  const needsConfirmation = !data.session;

  return new Response(JSON.stringify({ needsConfirmation }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
