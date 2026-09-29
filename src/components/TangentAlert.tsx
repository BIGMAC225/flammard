import { useCallback, useEffect, useRef, useState } from 'react';

// "Tangent Alert": a big red button that takes over the whole screen (and
// goes full screen, for the meeting-room TV) when the discussion drifts off
// the agenda. Click anywhere, press Esc, or wait 10 seconds to dismiss.
// Press T (outside a text field) to fire it from the keyboard.

const SHOW_MS = 10_000;

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Two-tone "whoop" repeated three times
    [0, 0.45, 0.9].forEach((start) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(660, ctx.currentTime + start);
      osc.frequency.linearRampToValueAtTime(990, ctx.currentTime + start + 0.3);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.4);
    });
    setTimeout(() => ctx.close().catch(() => {}), 2000);
  } catch {
    /* sound is a nice-to-have */
  }
}

export default function TangentAlert({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  const overlay = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    setOn(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const fire = useCallback(() => {
    setOn(true);
    beep();
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(dismiss, SHOW_MS);
  }, [dismiss]);

  // Full screen once the overlay is in the page (needs the click's user gesture)
  useEffect(() => {
    if (on && overlay.current && !document.fullscreenElement) {
      overlay.current.requestFullscreen?.().catch(() => {});
    }
  }, [on]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (on && (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        dismiss();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!on && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 't' || e.key === 'T')) fire();
    };
    // Leaving full screen with the browser's own Esc also dismisses
    const onFs = () => {
      if (!document.fullscreenElement && on) dismiss();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [on, fire, dismiss]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={fire}
        title="Tangent Alert (press T)"
        className={
          compact
            ? 'inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400'
            : 'inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-base font-bold tracking-wide text-white shadow-md hover:bg-red-700 active:scale-[0.98] transition focus:outline-none focus-visible:ring-4 focus-visible:ring-red-300'
        }
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        Tangent
      </button>

      {on && (
        <div
          ref={overlay}
          role="alertdialog"
          aria-live="assertive"
          aria-label="Tangent alert"
          onClick={dismiss}
          className="fixed inset-0 z-[1000] flex cursor-pointer select-none flex-col items-center justify-center bg-red-700 px-6 text-center text-white"
          style={{ animation: 'tangent-flash 0.9s ease-in-out infinite alternate' }}
        >
          <style>{`
            @keyframes tangent-flash { from { background-color: #b91c1c; } to { background-color: #ef4444; } }
            @keyframes tangent-pop { 0% { transform: scale(0.6); opacity: 0; } 60% { transform: scale(1.06); opacity: 1; } 100% { transform: scale(1); } }
            @media (prefers-reduced-motion: reduce) { [aria-label="Tangent alert"], [aria-label="Tangent alert"] * { animation: none !important; } }
          `}</style>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mb-6 h-28 w-28 sm:h-40 sm:w-40" style={{ animation: 'tangent-pop 0.5s ease-out both' }}>
            <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p
            className="font-display font-black uppercase leading-none tracking-tight"
            style={{ fontSize: 'clamp(3rem, 13vw, 12rem)', animation: 'tangent-pop 0.5s ease-out both' }}
          >
            Tangent Alert
          </p>
          <p className="mt-6 font-semibold" style={{ fontSize: 'clamp(1.1rem, 3vw, 2.5rem)' }}>
            We're off topic. Back to the agenda, or drop it to the Issues List.
          </p>
          <p className="mt-10 text-sm opacity-80 sm:text-base">Click anywhere or press Esc to dismiss</p>
        </div>
      )}
    </>
  );
}
