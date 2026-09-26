import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { chunkKey, deleteRecording, recordings } from '../../../../lib/blobs';

// Finalises a chunked upload (see ./recording/chunk.ts): verifies every part
// is in the blob store, then records the recording on the meeting.
export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; recording_path: string | null }>(params.id, 'id, recording_path');
  if (!meeting) return notFound();

  const { upload, parts, mime } = await readBody(request);
  if (
    typeof upload !== 'string' ||
    !/^[0-9]{10,16}$/.test(upload) ||
    !Number.isInteger(parts) ||
    parts < 1 ||
    parts > 10000
  ) {
    return json({ error: 'Invalid upload' }, 400);
  }

  const prefix = `${meeting.id}/${upload}`;
  const store = recordings();
  const present = await Promise.all(
    Array.from({ length: parts }, (_, i) => store.getMetadata(chunkKey(prefix, i)))
  );
  const missing = present.findIndex((m) => !m);
  if (missing !== -1) return json({ error: `Chunk ${missing} is missing — upload again` }, 409);

  await sql()`
    update meetings
    set recording_path = ${prefix}, recording_parts = ${parts}, recording_mime = ${typeof mime === 'string' ? mime : 'audio/webm'},
        input_type = 'recording', updated_at = now()
    where id = ${meeting.id}
  `;

  // Don't leave the previous take's chunks behind
  if (meeting.recording_path && meeting.recording_path !== prefix) {
    await deleteRecording(meeting.recording_path).catch(() => {});
  }
  return json({ ok: true });
};

// Manifest for the client-side download: the browser fetches each part from
// ./recording/chunk and joins them (a streamed response is capped at 20 MB,
// which a normal L10 exceeds).
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{
    id: string;
    title: string;
    date: string;
    recording_parts: number | null;
    recording_mime: string | null;
  }>(params.id, 'id, title, date::text as date, recording_parts, recording_mime');
  if (!meeting) return notFound();
  if (!meeting.recording_parts) return json({ error: 'No recording for this meeting' }, 404);

  const mime = meeting.recording_mime ?? 'audio/webm';
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const fileName = `${meeting.date}-${meeting.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.${ext}`;

  return json({ parts: meeting.recording_parts, mime, fileName });
};
