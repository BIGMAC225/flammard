/**
 * Runs `work` and returns its JSON result as a streaming response.
 *
 * Netlify kills a synchronous function after 60s (its documented,
 * non-configurable limit), and streaming the response does not extend that:
 * a function still running at the limit is cut off and the client receives
 * only the heartbeats. Work that can take longer belongs in a background
 * function (see netlify/functions/analyze-meeting-background.mts); work kept
 * here should enforce its own deadline below the limit. Streaming keeps the
 * connection busy and lets the client tell "server ran out of time"
 * (heartbeats, no JSON) apart from an error. We open the response
 * immediately, send a newline heartbeat every few seconds, then write the
 * JSON. Leading whitespace is valid JSON, so the whole body still parses with
 * a single JSON.parse on the client (and in Zapier).
 *
 * The status is always 200 because it has to be sent before the work runs;
 * failures come back as `{ "error": "..." }` in the body.
 *
 * `work` should persist its own result: if the client goes away we keep
 * running, but nobody will read the return value.
 */
export function streamJSON(work: () => Promise<unknown>, heartbeatMs = 3000): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true; // client disconnected
        }
      };
      const heartbeat = setInterval(() => send('\n'), heartbeatMs);
      try {
        const result = await work();
        send(JSON.stringify(result));
      } catch (err) {
        // The status is already 200, so this is the only trace in the function logs
        console.error('streamJSON work failed:', err);
        const message = err instanceof Error ? err.message : 'Unexpected error';
        send(JSON.stringify({ error: message }));
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      closed = true;
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

/**
 * Client-side counterpart: reads a streamJSON response body. A body that was
 * cut off before the JSON arrived (only heartbeats) comes back as
 * `{ truncated: true }` so the caller can fall back to polling.
 */
export async function readStreamedJSON<T = unknown>(
  res: Response
): Promise<Partial<T> & { error?: string; truncated?: boolean }> {
  type Result = Partial<T> & { error?: string; truncated?: boolean };
  const text = (await res.text()).trim();
  if (!text) return { truncated: true } as Result;
  try {
    return JSON.parse(text) as Result;
  } catch {
    return { truncated: true } as Result;
  }
}
