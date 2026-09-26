import { useMemo, useState } from 'react';
import { isMonthDay, quarterDates, quarterForDate, quarterWarnings } from '../lib/quarters';
import type { CompanySettings } from '../types';

// Company settings form (spec §5.1). Saves with PATCH /api/settings. The
// webhook secret is never sent to the browser: the page shows whether one is
// set, "Generate" shows a new one once, and "Clear" removes it.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];
const QS = ['q1_start', 'q2_start', 'q3_start', 'q4_start'] as const;

const fmt = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

function MonthDay({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [m, d] = value.split('-').map(Number);
  const set = (month: number, day: number) => onChange(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  return (
    <div className="flex gap-2">
      <select id={id} className="input text-sm" value={m} onChange={(e) => set(Number(e.target.value), d)} aria-label="Month">
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      <select className="input text-sm w-24" value={d} onChange={(e) => set(m, Number(e.target.value))} aria-label="Day">
        {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function SettingsForm({ initial }: { initial: CompanySettings }) {
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState({
    company_name: initial.company_name,
    week_start: initial.week_start,
    timezone: initial.timezone,
    q1_start: initial.q1_start,
    q2_start: initial.q2_start,
    q3_start: initial.q3_start,
    q4_start: initial.q4_start,
    fiscal_year_named_by: initial.fiscal_year_named_by,
    email_domain: initial.email_domain ?? '',
    recap_webhook_url: initial.recap_webhook_url ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setNotice('');
  };

  const quartersValid = QS.every((q) => isMonthDay(form[q]));
  const preview = useMemo(() => {
    if (!quartersValid) return null;
    const today = new Date().toLocaleDateString('en-CA');
    const { fy } = quarterForDate(today, form);
    return { fy, ranges: ([1, 2, 3, 4] as const).map((q) => quarterDates(q, fy, form)) };
  }, [form, quartersValid]);
  const liveWarnings = quartersValid ? quarterWarnings(form) : ['Each quarter start must be a real date'];
  const zones = ZONES.includes(form.timezone) ? ZONES : [...ZONES, form.timezone];
  const [customZone, setCustomZone] = useState(!ZONES.includes(initial.timezone));

  const send = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Could not save (${res.status})`);
      setSaved(json.settings);
      setWarnings(json.warnings ?? []);
      if (json.generated_secret) setSecret(json.generated_secret);
      setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const save = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void send(
      {
        ...form,
        email_domain: form.email_domain.trim() || null,
        recap_webhook_url: form.recap_webhook_url.trim() || null,
      },
      'Settings saved'
    );
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* select-and-copy by hand */
    }
  };

  return (
    <form onSubmit={save} className="space-y-8 max-w-3xl">
      <section className="card space-y-5">
        <h2 className="section-title">Company</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="s-name">Company name</label>
            <input id="s-name" className="input" value={form.company_name} maxLength={120} required
              onChange={(e) => set('company_name', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-week">Week starts on</label>
            <select id="s-week" className="input" value={form.week_start} onChange={(e) => set('week_start', Number(e.target.value))}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-tz">Timezone</label>
            {customZone ? (
              <input id="s-tz" className="input" value={form.timezone} placeholder="e.g. America/Chicago"
                onChange={(e) => set('timezone', e.target.value)} />
            ) : (
              <select id="s-tz" className="input" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            )}
            <button type="button" className="text-xs text-ink-muted hover:text-ink-primary mt-1" onClick={() => setCustomZone((c) => !c)}>
              {customZone ? 'Choose from the list' : 'Type another timezone'}
            </button>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="s-domain">Email domain</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-muted">@</span>
              <input id="s-domain" className="input" value={form.email_domain} placeholder="example.com"
                onChange={(e) => set('email_domain', e.target.value)} />
            </div>
            <p className="text-xs text-ink-muted mt-1">Pre-fills the email when someone adds a person. It is not enforced.</p>
          </div>
        </div>
      </section>

      <section className="card space-y-5">
        <div>
          <h2 className="section-title">Quarters</h2>
          <p className="text-sm text-ink-secondary mt-0.5">Each quarter starts on the same day every year. Q1 begins the fiscal year.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {QS.map((q, i) => (
            <div key={q}>
              <label className="label" htmlFor={`s-${q}`}>Q{i + 1} starts</label>
              <MonthDay id={`s-${q}`} value={form[q]} onChange={(v) => set(q, v)} />
            </div>
          ))}
        </div>
        <fieldset>
          <legend className="label">Fiscal year name</legend>
          <div className="space-y-1.5 text-sm text-ink-primary">
            <label className="flex items-center gap-2">
              <input type="radio" name="fy" checked={form.fiscal_year_named_by === 'start'} onChange={() => set('fiscal_year_named_by', 'start')} />
              The year it starts in
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="fy" checked={form.fiscal_year_named_by === 'end'} onChange={() => set('fiscal_year_named_by', 'end')} />
              The year it ends in
            </label>
          </div>
        </fieldset>
        {preview && (
          <div className="surface-inset p-4">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">This fiscal year: FY {preview.fy}</p>
            <ul className="grid gap-1 sm:grid-cols-2 text-sm text-ink-secondary">
              {preview.ranges.map((r, i) => (
                <li key={i}>
                  <span className="font-medium text-ink-primary">Q{i + 1} FY {preview.fy}</span>: {fmt(r.start_date)} – {fmt(r.end_date)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {[...new Set([...liveWarnings, ...warnings])].map((w) => (
          <p key={w} className="text-xs text-state-warning">{w}</p>
        ))}
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="section-title">Meeting recap webhook</h2>
          <p className="text-sm text-ink-secondary mt-0.5">Stored now. Flammard starts sending meeting recaps to this Zapier webhook in a later phase.</p>
        </div>
        <div>
          <label className="label" htmlFor="s-hook">Webhook URL</label>
          <input id="s-hook" className="input" type="url" value={form.recap_webhook_url} placeholder="https://hooks.zapier.com/…"
            onChange={(e) => set('recap_webhook_url', e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-secondary">
            Secret: <span className="font-medium text-ink-primary">{saved.recap_webhook_secret_set ? 'set' : 'not set'}</span>
          </span>
          <button type="button" className="btn-secondary text-sm" disabled={busy}
            onClick={() => {
              if (saved.recap_webhook_secret_set && !confirm('Replace the current secret? Anything using the old one stops working.')) return;
              void send({ generate_secret: true }, 'New secret generated');
            }}>
            Generate
          </button>
          {saved.recap_webhook_secret_set && (
            <button type="button" className="btn-ghost text-sm" disabled={busy}
              onClick={() => {
                if (!confirm('Clear the webhook secret?')) return;
                setSecret(null);
                void send({ recap_webhook_secret: null }, 'Secret cleared');
              }}>
              Clear
            </button>
          )}
        </div>
        {secret && (
          <div className="surface-inset p-4 space-y-2">
            <p className="text-sm text-ink-primary">Copy this secret now. It will not be shown again.</p>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" readOnly value={secret} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn-secondary text-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-4">
        <button type="submit" className="btn-primary" disabled={busy || !quartersValid}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {notice && <span className="text-sm text-state-success">{notice}</span>}
        {error && <span className="text-sm text-state-danger">{error}</span>}
      </div>
    </form>
  );
}
