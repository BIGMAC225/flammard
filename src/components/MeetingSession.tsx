import { useEffect, useRef, useState } from 'react';
import { readStreamedJSON } from '../lib/stream-json';
import AnalysisReview from './AnalysisReview';
import type { AnalysisStatus, MeetingAnalysis } from '../types';

interface Props {
  meetingId: string;
  hasRecording: boolean;
  hasTranscript: boolean;
  transcriptChars: number;
  transcriptFileName: string | null;
  analysis: MeetingAnalysis | null;
  analysisStatus: AnalysisStatus;
}

// Pick a container the browser can record and Vibe can read.
const MIME_CANDIDATES: Array<[string, string]> = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/mp4', 'm4a'],
];

// Serverless request bodies are capped at 6 MB, so the audio goes up in pieces
const CHUNK_BYTES = 4 * 1024 * 1024;

const formatTime = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function MeetingSession(props: Props) {
  const { meetingId } = props;

  const [hasRecording, setHasRecording] = useState(props.hasRecording);
  const [hasTranscript, setHasTranscript] = useState(props.hasTranscript);
  const [transcriptInfo, setTranscriptInfo] = useState(
    props.hasTranscript
      ? `${props.transcriptFileName ?? 'Pasted transcript'} · ${props.transcriptChars.toLocaleString()} characters`
      : ''
  );
  const [analysis, setAnalysis] = useState<MeetingAnalysis | null>(props.analysis);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>(props.analysisStatus);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState('');
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const extRef = useRef('webm');
  const fileRef = useRef<HTMLInputElement>(null);

  // Release the mic and timer if the component goes away mid-recording
  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  // Don't let a tab close silently throw away an hour of audio
  useEffect(() => {
    if (!recording && !uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [recording, uploading]);

  // ── 1. Record ──────────────────────────────────────────
  const startMeeting = async () => {
    setError('');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone access was denied. Allow the microphone for this site and try again.');
      return;
    }
    try {
      streamRef.current = stream;
      const candidate = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m));
      const mr = candidate
        ? new MediaRecorder(stream, { mimeType: candidate[0], audioBitsPerSecond: 48_000 })
        : new MediaRecorder(stream);
      extRef.current = candidate?.[1] ?? 'webm';
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream!.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void uploadRecording(new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' }));
      };

      mr.start(5000);
      mediaRef.current = mr;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError(`Could not start the recorder: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const stopMeeting = () => {
    mediaRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  };

  // Uploads the audio in ≤4 MB chunks, then finalises so the server can
  // verify every piece landed before recording it on the meeting.
  const uploadRecording = async (blob: Blob) => {
    setUploading(true);
    setUploadPct(0);
    setError('');
    try {
      const upload = String(Date.now());
      const parts = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
      for (let part = 0; part < parts; part++) {
        const piece = blob.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES);
        let attempt = 0;
        for (;;) {
          const res = await fetch(`/api/meetings/${meetingId}/recording/chunk?upload=${upload}&part=${part}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: piece,
          }).catch(() => null);
          if (res?.ok) break;
          if (++attempt >= 3) throw new Error(`Upload failed on part ${part + 1} of ${parts}`);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        setUploadPct(Math.round(((part + 1) / parts) * 100));
      }

      const res = await fetch(`/api/meetings/${meetingId}/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload, parts, mime: blob.type || 'audio/webm' }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not save recording');
      setHasRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      // Keep the audio recoverable in the browser
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meeting-${meetingId}.${extRef.current}`;
      a.click();
    } finally {
      setUploading(false);
      setUploadPct(null);
    }
  };

  // ── 2. Transcript ──────────────────────────────────────
  const uploadTranscriptFile = async (file: File) => {
    setSavingTranscript(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/meetings/${meetingId}/transcript`, { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save transcript');
      setHasTranscript(true);
      setTranscriptInfo(`${file.name} · ${json.length.toLocaleString()} characters`);
      setAnalysis(null);
      setAnalysisStatus('none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save transcript');
    } finally {
      setSavingTranscript(false);
      if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
    }
  };

  const onDropTranscript = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadTranscriptFile(file);
  };

  const saveTranscriptText = async () => {
    setSavingTranscript(true);
    setError('');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: pasted }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save transcript');
      setHasTranscript(true);
      setTranscriptInfo(`Pasted transcript · ${json.length.toLocaleString()} characters`);
      setPasteMode(false);
      setAnalysis(null);
      setAnalysisStatus('none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save transcript');
    } finally {
      setSavingTranscript(false);
    }
  };

  // ── 3. Analyze ─────────────────────────────────────────
  // If the host cuts the streamed response off, the server may still finish
  // and save the analysis; poll for it before giving up.
  const pollForAnalysis = async (startedAt: string): Promise<MeetingAnalysis | null> => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await fetch(`/api/meetings/${meetingId}/analyze`);
      if (!res.ok) continue;
      const m = (await res.json()) as { analysis: MeetingAnalysis | null; analysis_status: AnalysisStatus; analyzed_at: string | null };
      if (m.analysis && m.analyzed_at && m.analyzed_at > startedAt) return m.analysis;
    }
    return null;
  };

  const analyze = async () => {
    setAnalyzing(true);
    setError('');
    const startedAt = new Date().toISOString();
    try {
      let result: MeetingAnalysis | null = null;
      try {
        const res = await fetch(`/api/meetings/${meetingId}/analyze`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Analysis failed');
        const json = await readStreamedJSON<{ analysis?: MeetingAnalysis }>(res);
        if (json.error) throw new Error(json.error);
        result = json.analysis ?? null;
      } catch (err) {
        // A network drop or truncated stream isn't necessarily a failure
        if (err instanceof Error && !/^(Failed to fetch|Load failed|NetworkError)/.test(err.message) && err.message !== 'Analysis failed') throw err;
      }
      if (!result) result = await pollForAnalysis(startedAt);
      if (!result) throw new Error('Analysis did not finish. Try again, or paste a shorter transcript.');
      setAnalysis(result);
      setAnalysisStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  // ── 4. Commit ──────────────────────────────────────────
  const commit = async (selected: MeetingAnalysis) => {
    setCommitting(true);
    setError('');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/commit-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save');
      window.location.href = `/dashboard/meetings/${meetingId}?tab=eos`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setCommitting(false);
    }
  };

  const step = (n: number, label: string, done: boolean) => (
    <div className="flex items-center gap-2.5">
      <span
        className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center flex-shrink-0 ${
          done ? 'bg-mint-100 text-mint-800' : 'bg-bg-elevated text-ink-muted border border-line'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <h2 className="section-title">{label}</h2>
    </div>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ── Step 1: record ─────────────────────────────── */}
      <section className="card">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            {step(1, 'Record the meeting', hasRecording)}
            <p className="text-sm text-ink-secondary mt-1 ml-[34px]">
              Records from this device's microphone and saves the audio to the meeting.
            </p>
          </div>
          {hasRecording && !recording && (
            <a href={`/api/meetings/${meetingId}/recording`} className="btn-secondary text-xs py-1.5 flex-shrink-0">
              Download audio for Vibe
            </a>
          )}
        </div>

        <div className="bg-bg-elevated border border-line rounded-xl p-6 flex flex-col items-center gap-4">
          {!recording && !uploading && (
            <button onClick={startMeeting} className="btn-primary px-8 py-3 text-base">
              <span className="w-3 h-3 rounded-full bg-state-danger mr-2 animate-pulse" />
              {hasRecording ? 'Record again' : 'Start meeting'}
            </button>
          )}
          {recording && (
            <div className="text-center space-y-3">
              <div className="flex items-center gap-2 text-state-danger justify-center">
                <span className="w-3 h-3 rounded-full bg-state-danger animate-pulse" />
                <span className="font-mono text-3xl font-semibold">{formatTime(elapsed)}</span>
              </div>
              <p className="text-xs text-ink-muted">Keep this tab open while the meeting runs.</p>
              <button onClick={stopMeeting} className="btn-danger px-6 py-2.5">
                End meeting
              </button>
            </div>
          )}
          {uploading && (
            <div className="w-full max-w-xs text-center">
              <p className="text-sm text-ink-secondary mb-2">Saving recording… {uploadPct ?? 0}%</p>
              <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${uploadPct ?? 0}%` }} />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Step 2: transcript ─────────────────────────── */}
      <section className="card">
        {step(2, 'Add the Vibe transcript', hasTranscript)}
        <p className="text-sm text-ink-secondary mt-1 mb-4 ml-[34px]">
          Open the downloaded audio in Vibe, transcribe it, export as text (.txt, .srt, .vtt or .json) and drop it here.
        </p>

        {transcriptInfo && (
          <p className="text-xs text-ink-muted mb-3 ml-[34px]">
            Current: <span className="text-ink-secondary">{transcriptInfo}</span>
          </p>
        )}

        {!pasteMode ? (
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex-1 min-w-[240px] border-2 border-dashed border-line rounded-xl p-6 text-center cursor-pointer hover:border-line-strong hover:bg-bg-elevated/50 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropTranscript}
            >
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept=".txt,.srt,.vtt,.json,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadTranscriptFile(file);
                }}
              />
              <p className="text-sm font-medium text-ink-primary">
                {savingTranscript ? 'Saving…' : hasTranscript ? 'Replace transcript' : 'Drop the transcript file or click to browse'}
              </p>
              <p className="text-xs text-ink-secondary mt-1">.txt · .srt · .vtt · .json</p>
            </div>
            <button onClick={() => setPasteMode(true)} className="btn-secondary text-sm">
              Paste text instead
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              className="input min-h-[200px] resize-y font-mono text-xs leading-relaxed"
              placeholder="Paste the transcript here"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <div className="flex gap-2">
              <button onClick={saveTranscriptText} disabled={savingTranscript || pasted.trim().length < 20} className="btn-primary text-sm">
                {savingTranscript ? 'Saving…' : 'Save transcript'}
              </button>
              <button onClick={() => setPasteMode(false)} className="btn-secondary text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Step 3: analyze + review ───────────────────── */}
      <section className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            {step(3, 'Extract the EOS sections', analysisStatus === 'committed')}
            <p className="text-sm text-ink-secondary mt-1 ml-[34px]">
              Claude reads the transcript and drafts the summary, headlines, rock updates, to-dos and issues. Nothing is saved until you review and accept it.
            </p>
          </div>
          {hasTranscript && analysisStatus !== 'committed' && (
            <button onClick={analyze} disabled={analyzing} className="btn-primary text-sm flex-shrink-0">
              {analyzing ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40" />
                  </svg>
                  Analyzing…
                </>
              ) : analysis ? (
                'Re-analyze'
              ) : (
                'Analyze transcript'
              )}
            </button>
          )}
        </div>

        {!hasTranscript && (
          <p className="text-sm text-ink-muted mt-4 ml-[34px]">Add a transcript first.</p>
        )}

        {analyzing && (
          <p className="text-sm text-ink-muted mt-4 ml-[34px]">
            This usually takes 30–90 seconds for a full L10. You can leave this tab open.
          </p>
        )}

        {analysis && analysisStatus === 'ready' && !analyzing && (
          <div className="mt-6">
            {props.analysisStatus === 'committed' && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
                This meeting was already populated from an earlier analysis. Accepting again replaces the headlines, rock reviews, to-dos and issues that analysis added.
              </p>
            )}
            <AnalysisReview analysis={analysis} committing={committing} onCommit={commit} />
          </div>
        )}

        {analysisStatus === 'committed' && (
          <p className="text-sm text-ink-secondary mt-4 ml-[34px]">
            Saved to the EOS sections and minutes.{' '}
            <a href={`/dashboard/meetings/${meetingId}?tab=eos`} className="text-accent hover:text-accent-dim">
              Open EOS sections →
            </a>
            {hasTranscript && (
              <>
                {' '}
                <button onClick={analyze} className="text-ink-muted hover:text-ink-primary ml-2 underline-offset-2 hover:underline">
                  Run again
                </button>
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
