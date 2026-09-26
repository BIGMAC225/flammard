/**
 * Normalises transcript exports (Vibe writes .txt, .srt, .vtt or .json)
 * into plain text for analysis.
 */
export function transcriptToText(fileName: string, raw: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';

  if (ext === 'json') {
    try {
      const data = JSON.parse(raw);
      // Vibe / whisper JSON: { segments: [{ text, start, stop }] }
      const segments: unknown[] = Array.isArray(data) ? data : data?.segments ?? data?.transcription ?? [];
      const lines = segments
        .map((s) => {
          if (typeof s === 'string') return s.trim();
          const seg = s as { text?: string; speaker?: number };
          const text = (seg?.text ?? '').trim();
          if (!text) return '';
          return seg.speaker != null ? `Speaker ${seg.speaker + 1}: ${text}` : text;
        })
        .filter(Boolean);
      if (lines.length) return lines.join('\n');
    } catch {
      /* fall through and treat as text */
    }
  }

  if (ext === 'srt' || ext === 'vtt') {
    return raw
      .split(/\r?\n/)
      .filter((line) => {
        const l = line.trim();
        if (!l) return false;
        if (/^\d+$/.test(l)) return false; // srt cue index
        if (/^WEBVTT/.test(l) || /^NOTE\b/.test(l)) return false;
        if (/\d{1,2}:\d{2}(:\d{2})?[.,]\d{3}\s*-->/.test(l)) return false; // timestamps
        return true;
      })
      .map((line) => line.replace(/<[^>]+>/g, '').trim())
      .join('\n');
  }

  return raw.replace(/\r\n/g, '\n').trim();
}
