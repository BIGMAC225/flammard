// Browser-side client for bridge/vibe-bridge.mjs — the small script that
// exposes the Vibe desktop app's local transcription server to this site.

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:47111';
const STORAGE_KEY = 'flammard.vibeBridgeUrl';

export interface BridgeInfo {
  ok: boolean;
  base: string | null;
  model: string | null;
  diarizeModel: string | null;
  error: string | null;
}

export function bridgeUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

export function setBridgeUrl(url: string): void {
  try {
    if (url && url !== DEFAULT_BRIDGE_URL) localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ''));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

/** Resolves to the bridge's status, or null if nothing answers on this machine. */
export async function detectBridge(timeoutMs = 1500): Promise<BridgeInfo | null> {
  try {
    const res = await fetch(`${bridgeUrl()}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as BridgeInfo;
  } catch {
    return null;
  }
}

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: number;
}

/**
 * Streams the audio through Vibe and resolves to plain transcript text
 * (with "Speaker N:" prefixes when diarization is on).
 */
export async function transcribeWithBridge(
  audio: Blob,
  info: BridgeInfo,
  onProgress: (pct: number, segments: number) => void
): Promise<string> {
  const form = new FormData();
  form.append('file', audio, 'meeting.webm');
  form.append('stream', 'true');
  form.append('language', 'en');
  if (info.diarizeModel) form.append('diarize_model', info.diarizeModel);

  const res = await fetch(`${bridgeUrl()}/v1/audio/transcriptions`, { method: 'POST', body: form });
  if (res.status === 429) throw new Error('Vibe is busy with another transcription — wait for it to finish');
  if (!res.ok || !res.body) {
    let message = `Vibe returned ${res.status}`;
    try {
      const j = await res.json();
      message = j.error?.message ?? j.error ?? message;
    } catch {
      /* keep */
    }
    throw new Error(message);
  }

  // NDJSON: {type:"progress",progress} | {type:"segment",...} | {type:"result",text} | {type:"error",...}
  const segments: Segment[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText: string | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'progress') onProgress(Math.round(event.progress), segments.length);
      else if (event.type === 'segment') {
        segments.push(event);
        onProgress(-1, segments.length);
      } else if (event.type === 'result') finalText = event.text;
      else if (event.type === 'error') throw new Error(event.message ?? 'Transcription failed');
    }
  }

  if (segments.length) {
    return segments
      .map((s) => {
        const text = s.text.trim();
        if (!text) return '';
        return s.speaker != null ? `Speaker ${s.speaker + 1}: ${text}` : text;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (finalText?.trim()) return finalText.trim();
  throw new Error('Vibe returned an empty transcript');
}
