import { useState, useRef } from 'react';

interface InputCaptureProps {
  meetingId: string;
  onDrafted?: () => void;
}

type Tab = 'record' | 'upload' | 'paste';

export default function InputCapture({ meetingId, onDrafted }: InputCaptureProps) {
  const [tab, setTab] = useState<Tab>('paste');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState('');

  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Recording ──────────────────────────────────────────
  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];

      mr.ondataavailable = (e) => chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };

      mr.start(1000);
      mediaRef.current = mr;
      setRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } catch (err) {
      setError('Microphone access denied. Please allow microphone access or use another input method.');
    }
  };

  const stopRecording = () => {
    mediaRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  };

  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── File upload ────────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileText('');

    if (file.type.startsWith('text/') || file.name.match(/\.(txt|srt|vtt|md)$/i)) {
      const text = await file.text();
      setFileText(text);
    } else if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
      // Audio/video — store the blob, note that transcription is external
      setFileText(`[Audio file: ${file.name}]\n\nTranscription required before drafting. Please paste the transcript in the "Paste" tab.`);
    } else {
      setFileText('');
      setError('Supported formats: .txt, .srt, .vtt, .md, or audio/video files');
    }
  };

  // ── Draft ──────────────────────────────────────────────
  const getActiveContent = (): { content: string; input_type: string } | null => {
    if (tab === 'paste') {
      if (!text.trim()) return null;
      return { content: text.trim(), input_type: 'text' };
    }
    if (tab === 'upload') {
      if (!fileText.trim()) return null;
      return { content: fileText.trim(), input_type: 'transcript' };
    }
    if (tab === 'record') {
      if (!text.trim()) return null; // transcript entered after recording
      return { content: text.trim(), input_type: 'recording' };
    }
    return null;
  };

  const handleDraft = async () => {
    setError('');
    const active = getActiveContent();
    if (!active) {
      setError('Please add some meeting content first.');
      return;
    }

    setDrafting(true);
    const res = await fetch(`/api/meetings/${meetingId}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: active.content, input_type: active.input_type }),
    });

    const json = await res.json();
    setDrafting(false);

    if (!res.ok) {
      setError(json.error ?? 'Failed to draft minutes');
      return;
    }

    if (onDrafted) onDrafted();
    else window.location.reload();
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-bg-elevated rounded-lg w-fit">
        {([
          { id: 'paste', label: 'Paste transcript' },
          { id: 'upload', label: 'Upload file' },
          { id: 'record', label: 'Record audio' },
        ] as const).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === id ? 'bg-bg-surface text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Paste tab */}
      {tab === 'paste' && (
        <div className="space-y-2">
          <label className="label">Meeting transcript or notes</label>
          <textarea
            className="input min-h-[240px] resize-y font-mono text-xs leading-relaxed"
            placeholder="Paste your meeting transcript, notes, or summary here. The AI will extract decisions, action items, and discussion points."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-xs text-ink-muted">
            Accepts any format — raw transcripts, structured notes, bullet points, or a high-level summary.
          </p>
        </div>
      )}

      {/* Upload tab */}
      {tab === 'upload' && (
        <div className="space-y-3">
          <label className="label">Upload a file</label>
          <div
            className="border-2 border-dashed border-line rounded-xl p-8 text-center cursor-pointer hover:border-line-strong hover:bg-bg-elevated/50 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" className="hidden" accept=".txt,.srt,.vtt,.md,audio/*,video/*" onChange={handleFile} />
            <div className="text-3xl mb-3">📄</div>
            {fileName ? (
              <>
                <p className="text-sm font-medium text-ink-primary">{fileName}</p>
                <p className="text-xs text-ink-muted mt-1">Click to change</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-ink-primary">Drop a file or click to browse</p>
                <p className="text-xs text-ink-secondary mt-1">Transcript (.txt, .srt, .vtt) or audio/video file</p>
              </>
            )}
          </div>

          {fileText && (
            <div className="space-y-2">
              <label className="label">Content preview / edit</label>
              <textarea
                className="input min-h-[160px] resize-y font-mono text-xs leading-relaxed"
                value={fileText}
                onChange={(e) => setFileText(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {/* Record tab */}
      {tab === 'record' && (
        <div className="space-y-4">
          <div className="bg-bg-elevated border border-line rounded-xl p-6 flex flex-col items-center gap-4">
            {!recording && !audioUrl && (
              <button onClick={startRecording} className="btn-primary px-8 py-3 text-base">
                <span className="w-3 h-3 rounded-full bg-state-danger mr-2 animate-pulse"></span>
                Start recording
              </button>
            )}

            {recording && (
              <div className="text-center space-y-3">
                <div className="flex items-center gap-2 text-state-danger">
                  <span className="w-3 h-3 rounded-full bg-state-danger animate-pulse"></span>
                  <span className="font-mono text-2xl font-semibold">{formatTime(recordingTime)}</span>
                </div>
                <button onClick={stopRecording} className="btn-danger px-6 py-2.5">
                  Stop recording
                </button>
              </div>
            )}

            {audioUrl && !recording && (
              <div className="w-full space-y-3">
                <audio src={audioUrl} controls className="w-full" />
                <div className="flex gap-2 justify-center">
                  <button onClick={startRecording} className="btn-secondary text-sm">
                    Re-record
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="label">
              Transcript
              <span className="text-ink-muted font-normal ml-1">— paste your transcription below to draft minutes</span>
            </label>
            <textarea
              className="input min-h-[160px] resize-y font-mono text-xs leading-relaxed"
              placeholder="After recording, paste the transcript here. Use your preferred transcription service (Whisper, Otter.ai, etc.)"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Draft button */}
      <div className="pt-2">
        <button
          onClick={handleDraft}
          disabled={drafting}
          className="btn-primary py-3 px-6 text-base"
        >
          {drafting ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40" />
              </svg>
              Drafting minutes with AI…
            </>
          ) : (
            'Draft minutes with AI →'
          )}
        </button>
        <p className="text-xs text-ink-muted mt-2">Claude will extract decisions, action items, and discussion points.</p>
      </div>
    </div>
  );
}
