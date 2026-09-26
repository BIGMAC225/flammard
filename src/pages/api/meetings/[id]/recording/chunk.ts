import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../../lib/api';
import { CHUNK_BYTES, chunkKey, recordings } from '../../../../../lib/blobs';

// One chunk of a browser recording. The client splits the audio into ≤4 MB
// pieces (a serverless request body is capped at 6 MB) and finalises with
// POST /recording once every part is stored.
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
