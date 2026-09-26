import { useEffect, useRef, useState } from 'react';
import { createClient } from '../lib/supabase';
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
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const extRef = useRef('webm');
  const fileRef = useRef<HTMLInputElement>(null);

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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        stream.getTracks().forEach((t) => t.stop());
        void uploadRecording(new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' }));
      };

      mr.start(5000);
      mediaRef.current = mr;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
    } catch {
      setError('Microphone access was denied. Allow the microphone for this site and try again.');
    }
  };

  const stopMeeting = () => {
    mediaRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  };

  // Uploads go straight to Supabase Storage — a long meeting is far larger
  // than a serverless request body allows.
  const uploadRecording = async (blob: Blob) => {
    setUploading(true);
    setUploadPct(0);
    setError('');
    try {
      const supabase = createClient();
      const path = `${meetingId}/${Date.now()}.${extRef.current}`;
      const { error: upErr } = await supabase.storage
        .from('recordings')
        .upload(path, blob, { contentType: blob.type || 'audio/webm', upsert: true });
      if (upErr) throw new Error(upErr.message);
      setUploadPct(100);

      const res = await fetch(`/api/meetings/${meetingId}/recording`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
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
  const uploadTranscriptFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSavingTranscript(true);
    setError('');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/meetings/${meetingId}/transcript`, { method: 'POST', body: form });
    const json = await res.json();
    setSavingTranscript(false);
    if (!res.ok) {
      setError(json.error ?? 'Could not save transcript');
      return;
    }
    setHasTranscript(true);
    setTranscriptInfo(`${file.name} · ${json.length.toLocaleString()} characters`);
    setAnalysis(null);
    setAnalysisStatus('none');
  };

  const saveTranscriptText = async () => {
    setSavingTranscript(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: pasted }),
    });
    const json = await res.json();
    setSavingTranscript(false);
    if (!res.ok) {
      setError(json.error ?? 'Could not save transcript');
      return;
    }
    setHasTranscript(true);
    setTranscriptInfo(`Pasted transcript · ${json.length.toLocaleString()} characters`);
    setPasteMode(false);
    setAnalysis(null);
    setAnalysisStatus('none');
  };

  // ── 3. Analyze ─────────────────────────────────────────
  const analyze = async () => {
    setAnalyzing(true);
    setError('');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/analyze`, { method: 'POST' });
      const json = await readStreamedJSON<{ analysis?: MeetingAnalysis }>(res);
      if (json.error || !json.analysis) throw new Error(json.error ?? 'Analysis failed');
      setAnalysis(json.analysis);
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
    const res = await fetch(`/api/meetings/${meetingId}/commit-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selected),
    });
    const json = await res.json();
    setCommitting(false);
    if (!res.ok) {
      setError(json.error ?? 'Could not save');
      return;
    }
    window.location.href = `/dashboard/meetings/${meetingId}?tab=eos`;
  };

  const step = (n: number, label: string, done: boolean) => (
    <div className="flex items-center gap-2.5">
      <span
        className={`w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center flex-shrink-0 ${
          done ? 'bg-state-success/15 text-state-success' : 'bg-bg-elevated text-ink-muted border border-line'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <h2 className="text-base font-semibold text-ink-primary">{label}</h2>
    </div>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
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
            <p className="text-sm text-ink-secondary">
              Saving recording{uploadPct === 100 ? '…' : ' — uploading audio…'}
            </p>
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
            >
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept=".txt,.srt,.vtt,.json,text/plain"
                onChange={uploadTranscriptFile}
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
