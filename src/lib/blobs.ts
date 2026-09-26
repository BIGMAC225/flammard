import { getStore } from '@netlify/blobs';

// Netlify Blobs replaces Supabase Storage. Two stores:
//   recordings  — browser audio, uploaded in ≤3 MB chunks (`<prefix>/<n>`)
//                 because a serverless request body is capped at 6 MB (and
//                 binary bodies are base64-encoded on the way in), and read
//                 back chunk by chunk because streamed responses cap at 20 MB
//   minutes-pdf — the sealed PDF per approval
//   auth        — login throttling counters

export const recordings = () => getStore({ name: 'recordings', consistency: 'strong' });
export const minutesPdf = () => getStore({ name: 'minutes-pdf', consistency: 'strong' });
export const authStore = () => getStore({ name: 'auth', consistency: 'strong' });

export const CHUNK_BYTES = 3 * 1024 * 1024;

export const chunkKey = (prefix: string, part: number) => `${prefix}/${String(part).padStart(4, '0')}`;

/** Removes every chunk under a recording prefix (used when re-recording). */
export async function deleteRecording(prefix: string): Promise<void> {
  const store = recordings();
  const { blobs } = await store.list({ prefix: `${prefix}/` });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
}
