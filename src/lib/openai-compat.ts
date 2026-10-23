/**
 * The provider-agnostic half of the OpenAI-compatible providers (Z.ai GLM,
 * NVIDIA). No imports at all: Node runs this file directly in the tests
 * via type stripping.
 */

export type AiProvider = 'zai' | 'nvidia' | 'anthropic';

/**
 * Which provider will run: AI_PROVIDER (lower-cased, trimmed) picks one
 * explicitly when that provider's key exists; otherwise prefer zai, then
 * nvidia, then anthropic. Null when no key is configured.
 */
export function selectProvider(get: (name: string) => string | undefined): AiProvider | null {
  const zai = Boolean(get('ZAI_API_KEY'));
  const nvidia = Boolean(get('NVIDIA_API_KEY'));
  const anthropic = Boolean(get('ANTHROPIC_API_KEY'));
  const pick = (get('AI_PROVIDER') ?? '').trim().toLowerCase();
  if (pick === 'zai' && zai) return 'zai';
  if (pick === 'nvidia' && nvidia) return 'nvidia';
  if (pick === 'anthropic' && anthropic) return 'anthropic';
  return zai ? 'zai' : nvidia ? 'nvidia' : anthropic ? 'anthropic' : null;
}

/**
 * Pulls the first complete JSON object out of a chat reply. Tolerates
 * reasoning blocks, code fences and prose before or after the object.
 */
export function extractJson(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  let start = body.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          break; // not valid JSON from here; try the next "{"
        }
      }
    }
    start = body.indexOf('{', start + 1);
  }
  throw new Error('no JSON object in the reply');
}

export interface ChatEndpoint {
  /** Provider name shown in errors, e.g. "Z.ai" / "NVIDIA". */
  name: string;
  url: string;
  key: string;
  model: string;
  requestTimeoutMs: number;
  /** Sent on every request (e.g. Z.ai's `thinking` switch). */
  extraBody?: Record<string, unknown>;
  /** Sent only on the guided first try. */
  guidedBody: Record<string, unknown>;
}

/**
 * The max_tokens to send with a call. Z.ai counts reasoning tokens against
 * max_tokens, so a thinking run gets the whole ZAI_MAX_TOKENS budget —
 * default 65536, clamped at 131072 (GLM-5.3's documented max output is
 * 128K) — and callMax does not apply. Everything else takes the smaller of
 * callMax and the provider's env cap (Z.ai default 16000, NVIDIA 8192).
 */
export function replyBudget(callMax: number, envMax: string | undefined, opts: { zai: boolean; thinking: boolean }): number {
  if (opts.zai && opts.thinking) return Math.min(Number(envMax) || 65536, 131072);
  return Math.min(callMax, Number(envMax) || (opts.zai ? 16000 : 8192));
}

/**
 * Reads a chat-completions reply: `choices[0].message.content` when
 * non-blank, else `reasoning_content`, else `reasoning` (reasoning models
 * sometimes leave `content` empty and put the whole answer, JSON included,
 * in `reasoning_content`).
 */
export function chatReplyText(data: unknown): { text: string; finishReason: string | undefined } {
  const choice = (
    data as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
        finish_reason?: string;
      }>;
    }
  ).choices?.[0];
  if (!choice) return { text: '', finishReason: undefined };
  const content = choice.message?.content ?? '';
  return {
    text: content.trim() ? content : (choice.message?.reasoning_content ?? choice.message?.reasoning ?? ''),
    finishReason: choice.finish_reason,
  };
}

/**
 * Accumulates a `text/event-stream` chat-completions reply. Feed it the
 * decoded chunks as they arrive; lines may be split anywhere between chunks.
 * Streams the `delta.content`, `delta.reasoning_content` and `delta.reasoning`
 * pieces into three strings and remembers the last non-null `finish_reason`.
 */
export function createSseAccumulator(
  name: string
): { push(chunk: string): void; end(): { text: string; finishReason: string | undefined } } {
  let buffer = ''; // partial line carried across chunks
  let raw = ''; // everything received, kept only until the first data line
  let sawData = false;
  let done = false;
  let content = '';
  let reasoningContent = '';
  let reasoning = '';
  let finishReason: string | undefined;

  const line = (l: string) => {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (!l || l.startsWith(':') || l.startsWith('event:') || l.startsWith('id:')) return;
    if (!l.startsWith('data:')) return;
    sawData = true;
    let data = l.slice(5);
    if (data.startsWith(' ')) data = data.slice(1);
    if (data.trim() === '[DONE]') {
      done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // a malformed line (mid-stream disconnect, proxy noise) must not kill the stream
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const obj = parsed as { error?: unknown; choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }> };
    if ('error' in obj && obj.error != null)
      throw new Error(`${name} API error: ${JSON.stringify(obj.error).slice(0, 300)}`);
    const choice = obj.choices?.[0];
    if (choice?.delta) {
      content += choice.delta.content ?? '';
      reasoningContent += choice.delta.reasoning_content ?? '';
      reasoning += choice.delta.reasoning ?? '';
    }
    if (choice && choice.finish_reason != null) finishReason = choice.finish_reason;
  };

  return {
    push(chunk: string): void {
      if (done) return;
      if (!sawData) raw += chunk;
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (done) {
          buffer = '';
          return;
        }
        nl = buffer.indexOf('\n');
      }
    },
    end(): { text: string; finishReason: string | undefined } {
      if (buffer) {
        line(buffer);
        buffer = '';
      }
      // Same reply rule as a non-streaming call, so chatReplyText stays the
      // single place that decides content vs reasoning. The reasoning fields
      // are omitted when empty so its `??` chain falls through to `reasoning`.
      return sawData
        ? chatReplyText({
            choices: [
              {
                message: { content, reasoning_content: reasoningContent || undefined, reasoning: reasoning || undefined },
                finish_reason: finishReason,
              },
            ],
          })
        : // A server that answered with a plain JSON body despite stream:true
          chatReplyText(JSON.parse(raw));
    },
  };
}

/**
 * Streams the reply: with GLM thinking enabled, Z.ai sends no response
 * headers until the whole answer is generated, and Node's fetch (undici)
 * gives up waiting for headers after its 300s headersTimeout — long before
 * the request timeout matters. `stream: true` makes the headers arrive at
 * once and the SSE frames keep the connection alive while tokens arrive.
 */
export async function chatCompletion(
  endpoint: ChatEndpoint,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  guided: boolean,
  signal?: AbortSignal
): Promise<{ text: string; finishReason: string | undefined }> {
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        max_tokens: maxTokens,
        stream: true,
        ...endpoint.extraBody,
        ...(guided ? endpoint.guidedBody : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(endpoint.requestTimeoutMs)])
        : AbortSignal.timeout(endpoint.requestTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`${endpoint.name} API ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    // res.body arrives as bytes that may split a UTF-8 character or an SSE
    // line anywhere; the decoder (stream: true) and the accumulator buffer
    // across chunks.
    const accumulator = createSseAccumulator(endpoint.name);
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      accumulator.push(decoder.decode(chunk, { stream: true }));
    }
    accumulator.push(decoder.decode());
    return accumulator.end();
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    if (err instanceof TypeError && cause) {
      throw new Error(`${endpoint.name} request failed: ${(cause as { code?: string; message?: string }).code || (cause as Error).message}`, { cause });
    }
    throw err;
  }
}
