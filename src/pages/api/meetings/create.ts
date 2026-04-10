import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server';
import type { Attendee } from '../../../types';

export const POST: APIRoute = async ({ request, cookies }) => {
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

  const body = await request.json();
  const { title, date, location, attendees } = body as {
    title: string;
    date: string;
    location?: string;
    attendees: Attendee[];
  };

  if (!title || !date) {
    return new Response(JSON.stringify({ error: 'Title and date are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data, error } = await supabase
    .from('meetings')
    .insert({
      title: title.trim(),
      date,
      location: location?.trim() || null,
      attendees: attendees ?? [],
      status: 'draft',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ id: data.id }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
