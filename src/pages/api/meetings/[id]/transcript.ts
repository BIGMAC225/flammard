import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { transcriptToText } from '../../../../lib/transcript';

// Accepts either a multipart upload (`file`: Vibe's .txt/.srt/.vtt/.json
// export) or JSON `{ transcript }` for pasted text.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  let text = '';
  let fileName: string | null = null;

  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'No file uploaded' }, 400);
    fileName = file.name;
    text = transcriptToText(file.name, await file.text());
  } else {
    const body = (await request.json()) as { transcript?: string; source?: string };
    text = (body.transcript ?? '').trim();
    if (body.source === 'vibe') fileName = 'Transcribed in Vibe';
  }

  if (text.length < 20) return json({ error: 'Transcript is empty' }, 400);

  // A new transcript invalidates any earlier analysis
  await sql()`
    update meetings
    set transcript = ${text}, transcript_path = ${fileName}, input_type = ${fileName ? 'transcript' : 'text'},
        analysis = null, analysis_status = 'none', analyzed_at = null, updated_at = now()
    where id = ${meeting.id}
  `;
  return json({ ok: true, length: text.length });
};
