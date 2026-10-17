import { useState } from 'react';

// "Copy five lines": fetches the meeting's markdown export and puts it on
// the clipboard, for pasting into chat or email after the L10.
export default function CopyFiveLines({ meetingId }: { meetingId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const copy = async () => {
    setState('busy');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/export`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('export failed');
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 2500);
  };

  const label = { idle: 'Copy five lines', busy: 'Copying…', done: 'Copied', error: 'Could not copy' }[state];
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={copy} disabled={state === 'busy'} className="btn-secondary text-sm" title="Copy the meeting recap as markdown">
        {label}
      </button>
      <a
        href={`/api/meetings/${meetingId}/export?download=1`}
        className="text-xs text-ink-muted hover:text-ink-primary"
        title="Download the recap as a .md file"
      >
        .md
      </a>
    </span>
  );
}
