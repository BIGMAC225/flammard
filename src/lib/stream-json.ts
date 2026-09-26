/**
 * Runs `work` and returns its JSON result as a streaming response.
 *
 * Netlify cuts synchronous functions off after ~10s, but streamed responses
 * are allowed to run much longer. Claude calls regularly take longer than
 * 10s, so we open the response immediately, send a newline heartbeat every
 * few seconds, then write the JSON. Leading whitespace is valid JSON, so the
 * whole body still parses with a single JSON.parse on the client (and in
 * Zapier).
 *
 * The status is always 200 because it has to be sent before the work runs;
 * failures come back as `{ "error": "..." }` in the body.
 */
export function streamJSON(work: () => Promise<unknown>, heartbeatMs = 3000): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode('\n')), heartbeatMs);
      try {
        const result = await work();
        controller.enqueue(encoder.encode(JSON.stringify(result)));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error';
        controller.enqueue(encoder.encode(JSON.stringify({ error: message })));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Client-side counterpart: reads a streamJSON response body. */
export async function readStreamedJSON<T = unknown>(res: Response): Promise<T & { error?: string }> {
  const text = await res.text();
  return JSON.parse(text.trim() || '{}');
}
