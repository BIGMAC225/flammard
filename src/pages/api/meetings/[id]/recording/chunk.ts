import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../../lib/api';
import { CHUNK_BYTES, chunkKey, recordings } from '../../../../../lib/blobs';

// One chunk of a browser recording. The client splits the audio into ≤3 MB
// pieces (a serverless request body is capped at 6 MB after base64) and
// finalises with POST /recording once every part is stored.
//   POST /api/meetings/:id/recording/chunk?upload=<upload id>&part=<n>
export const POST: APIRoute = async ({ params, request, cookies, url }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting(params.id, 'id');
  if (!meeting) return notFound();

  const upload = url.searchParams.get('upload') ?? '';
  const part = Number(url.searchParams.get('part'));
  if (!/^[0-9]{10,16}$/.test(upload) || !Number.isInteger(part) || part < 0 || part > 9999) {
    return json({ error: 'Invalid upload or part' }, 400);
  }

  const data = await request.arrayBuffer();
  if (!data.byteLength) return json({ error: 'Empty chunk' }, 400);
  if (data.byteLength > CHUNK_BYTES + 1024) return json({ error: 'Chunk too large' }, 413);

  await recordings().set(chunkKey(`${meeting.id}/${upload}`, part), data);
  return json({ ok: true, part });
};

// Reads one chunk back for the client-side download.
//   GET /api/meetings/:id/recording/chunk?part=<n>
export const GET: APIRoute = async ({ params, cookies, url }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; recording_path: string | null; recording_parts: number | null; recording_mime: string | null }>(
    params.id,
    'id, recording_path, recording_parts, recording_mime'
  );
  if (!meeting) return notFound();
  if (!meeting.recording_path || !meeting.recording_parts) return json({ error: 'No recording' }, 404);

  const part = Number(url.searchParams.get('part'));
  if (!Number.isInteger(part) || part < 0 || part >= meeting.recording_parts) return json({ error: 'Invalid part' }, 400);

  const data = await recordings().get(chunkKey(meeting.recording_path, part), { type: 'arrayBuffer' });
  if (!data) return json({ error: `Chunk ${part} is missing` }, 404);

  return new Response(data, {
    // no-store: the URL is the same across re-recordings, and audio shouldn't outlive a session
    headers: { 'Content-Type': meeting.recording_mime ?? 'audio/webm', 'Cache-Control': 'private, no-store' },
  });
};
