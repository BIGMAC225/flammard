-- Automation: meeting sessions (recording → Vibe transcript → AI analysis)
-- and TaxDome report imports feeding the scorecard.

-- ── Meetings: session state ──────────────────────────────────────────────
alter table public.meetings
  add column if not exists transcript_path  text,
  add column if not exists analysis         jsonb,
  add column if not exists analysis_status  text not null default 'none'
                             check (analysis_status in ('none', 'ready', 'committed')),
  add column if not exists analyzed_at      timestamptz;

-- ── Scorecard: entries can now come from imports, not only meetings ──────
alter table public.scorecard_entries
  alter column meeting_id drop not null,
  alter column created_by drop not null,
  add column if not exists period_date  date,
  add column if not exists source       text not null default 'manual'
                             check (source in ('manual', 'taxdome')),
  add column if not exists import_id    uuid;

-- One value per metric per reporting period
create unique index if not exists scorecard_entries_metric_period_idx
  on public.scorecard_entries (metric_id, period_date)
  where period_date is not null;

-- Free-text hint that tells the extractor where to find this metric in a report
alter table public.scorecard_metrics
  add column if not exists description text;

-- ── TaxDome imports (one row per report received via the webhook) ────────
create table public.taxdome_imports (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  file_name        text,
  report_title     text,
  period_start     date,
  period_end       date,
  raw_text         text,
  extracted        jsonb,
  status           text not null default 'processed'
                     check (status in ('processed', 'failed')),
  error            text,
  entries_written  integer not null default 0
);

alter table public.taxdome_imports enable row level security;

-- Imports are written by the webhook (service role) and readable by the team
create policy "authenticated can select taxdome_imports"
  on public.taxdome_imports for select to authenticated using (true);

-- Imported entries have no meeting and no creator; make them visible
drop policy if exists "owner can select scorecard_entries" on public.scorecard_entries;
create policy "owner can select scorecard_entries"
  on public.scorecard_entries for select
  using (
    created_by = auth.uid()
    or source = 'taxdome'
    or meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

-- ── Storage ───────────────────────────────────────────────────────────────
-- Recordings are uploaded straight from the browser (they can exceed the
-- serverless request-body limit), so authenticated users need write access.
insert into storage.buckets (id, name, public)
  values ('recordings', 'recordings', false)
  on conflict (id) do nothing;

create policy "authenticated can upload recordings"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings');

create policy "authenticated can update recordings"
  on storage.objects for update to authenticated
  using (bucket_id = 'recordings');

create policy "authenticated can read recordings"
  on storage.objects for select to authenticated
  using (bucket_id = 'recordings');
