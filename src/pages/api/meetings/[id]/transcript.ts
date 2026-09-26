import type { APIRoute } from 'astro';
import { json, requireUser, requireMeeting } from '../../../../lib/api';
import { transcriptToText } from '../../../../lib/transcript';

// Accepts either a multipart upload (`file`: Vibe's .txt/.srt/.vtt/.json
// export) or JSON `{ transcript }` for pasted text.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const { supabase, user, response } = await requireUser(request, cookies);
  if (response) return response;

  const { meeting, response: forbidden } = await requireMeeting(supabase, user.id, params.id, 'id');
  if (forbidden) return forbidden;

  let text = '';
  let fileName: string | null = null;

  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'No file uploaded' }, 400);
    fileName = file.name;
    text = transcriptToText(file.name, await file.text());
  } else {
    const body = (await request.json()) as { transcript?: string };
    text = (body.transcript ?? '').trim();
  }

  if (text.length < 20) return json({ error: 'Transcript is empty' }, 400);

  const { error } = await supabase
    .from('meetings')
    .update({
      transcript: text,
      transcript_path: fileName,
      input_type: fileName ? 'transcript' : 'text',
      // A new transcript invalidates any earlier analysis
      analysis: null,
      analysis_status: 'none',
      analyzed_at: null,
    })
    .eq('id', meeting.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, length: text.length });
};
