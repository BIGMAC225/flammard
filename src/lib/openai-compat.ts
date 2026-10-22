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

export async function chatCompletion(
  endpoint: ChatEndpoint,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  guided: boolean,
  signal?: AbortSignal
): Promise<{ text: string; finishReason: string | undefined }> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...endpoint.extraBody,
      ...(guided ? endpoint.guidedBody : {}),
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(endpoint.requestTimeoutMs)])
      : AbortSignal.timeout(endpoint.requestTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${endpoint.name} API ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return chatReplyText(JSON.parse(text));
}
