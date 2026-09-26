import { getStore } from '@netlify/blobs';

// Netlify Blobs replaces Supabase Storage. Two stores:
//   recordings  — browser audio, uploaded in ≤4 MB chunks (`<prefix>/<n>`)
//                 because a serverless request body is capped at 6 MB
//   minutes-pdf — the sealed PDF per approval

export const recordings = () => getStore({ name: 'recordings', consistency: 'strong' });
export const minutesPdf = () => getStore({ name: 'minutes-pdf', consistency: 'strong' });

export const CHUNK_BYTES = 4 * 1024 * 1024;

export const chunkKey = (prefix: string, part: number) => `${prefix}/${String(part).padStart(4, '0')}`;

/** Streams a chunked recording back as one body without loading it all at once. */
export function streamChunks(prefix: string, parts: number): ReadableStream<Uint8Array> {
  const store = recordings();
  let part = 0;
  return new ReadableStream({
    async pull(controller) {
      if (part >= parts) {
        controller.close();
        return;
      }
      const data = await store.get(chunkKey(prefix, part), { type: 'arrayBuffer' });
      part += 1;
      if (!data) {
        controller.error(new Error(`Missing recording chunk ${part - 1}`));
        return;
      }
      controller.enqueue(new Uint8Array(data));
    },
  });
}
