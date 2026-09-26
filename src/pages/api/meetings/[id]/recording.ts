import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { chunkKey, recordings, streamChunks } from '../../../../lib/blobs';

// Finalises a chunked upload (see ./recording/chunk.ts): verifies every part
// is in the blob store, then records the recording on the meeting.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const { upload, parts, mime } = (await request.json()) as { upload?: string; parts?: number; mime?: string };
  if (!upload || !/^[0-9]{10,16}$/.test(upload) || !parts || parts < 1) {
    return json({ error: 'Invalid upload' }, 400);
  }

  const prefix = `${meeting.id}/${upload}`;
  const store = recordings();
  for (let i = 0; i < parts; i++) {
    const meta = await store.getMetadata(chunkKey(prefix, i));
    if (!meta) return json({ error: `Chunk ${i} is missing — upload again` }, 409);
  }

  await sql()`
    update meetings
    set recording_path = ${prefix}, recording_parts = ${parts}, recording_mime = ${mime ?? 'audio/webm'},
        input_type = 'recording', updated_at = now()
    where id = ${meeting.id}
  `;
  return json({ ok: true });
};

// Downloads the recording (for Vibe) as one streamed file.
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{
    id: string;
    title: string;
    date: string;
    recording_path: string | null;
    recording_parts: number | null;
    recording_mime: string | null;
  }>(params.id, 'id, title, date, recording_path, recording_parts, recording_mime');
  if (!meeting) return notFound();
  if (!meeting.recording_path || !meeting.recording_parts) return json({ error: 'No recording for this meeting' }, 404);

  const mime = meeting.recording_mime ?? 'audio/webm';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const fileName = `${meeting.date}-${meeting.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.${ext}`;

  return new Response(streamChunks(meeting.recording_path, meeting.recording_parts), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
