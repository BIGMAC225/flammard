import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../../lib/supabase-server';

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServerClient(request, cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = params;

  const { data: meeting } = await supabase
    .from('meetings')
    .select('created_by, title')
    .eq('id', id)
    .single();

  if (!meeting || meeting.created_by !== user.id) {
    return new Response('Forbidden', { status: 403 });
  }

  const { data: minutes } = await supabase
    .from('minutes')
    .select('pdf_path')
    .eq('meeting_id', id)
    .single();

  if (!minutes?.pdf_path) {
    return new Response('PDF not found', { status: 404 });
  }

  const { data: fileData, error } = await supabase.storage
    .from('minutes-pdf')
    .download(minutes.pdf_path);

  if (error || !fileData) {
    return new Response('Failed to retrieve PDF', { status: 500 });
  }

  const fileName = `${meeting.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-minutes.pdf`;

  return new Response(await fileData.arrayBuffer(), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
};
