-- Automation: meeting sessions (recording → Vibe transcript → AI analysis)
-- and TaxDome report imports feeding the scorecard.
-- Safe to re-run.

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

-- One value per metric per reporting period. This must be a plain (not
-- partial) unique index so `on conflict (metric_id, period_date)` can use it;
-- NULL period_dates are distinct, so meeting-based rows never collide.
drop index if exists scorecard_entries_metric_period_idx;
create unique index scorecard_entries_metric_period_idx
  on public.scorecard_entries (metric_id, period_date);

-- Free-text hint that tells the extractor where to find this metric in a report
alter table public.scorecard_metrics
  add column if not exists description text;

-- ── TaxDome imports (one row per report received via the webhook) ────────
create table if not exists public.taxdome_imports (
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
drop policy if exists "authenticated can select taxdome_imports" on public.taxdome_imports;
create policy "authenticated can select taxdome_imports"
  on public.taxdome_imports for select to authenticated using (true);

-- Imported entries have no meeting and no creator: the team must still be
-- able to see and correct them.
drop policy if exists "owner can select scorecard_entries" on public.scorecard_entries;
create policy "owner can select scorecard_entries"
  on public.scorecard_entries for select to authenticated
  using (
    created_by = auth.uid()
    or source = 'taxdome'
    or meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

drop policy if exists "owner can update scorecard_entries" on public.scorecard_entries;
create policy "owner can update scorecard_entries"
  on public.scorecard_entries for update to authenticated
  using (created_by = auth.uid() or source = 'taxdome');

drop policy if exists "owner can delete scorecard_entries" on public.scorecard_entries;
create policy "owner can delete scorecard_entries"
  on public.scorecard_entries for delete to authenticated
  using (created_by = auth.uid() or source = 'taxdome');

-- ── Storage ───────────────────────────────────────────────────────────────
-- Recordings are uploaded straight from the browser (they can exceed the
-- serverless request-body limit), so authenticated users need write access.
-- 200 MB ≈ 9 hours at the recorder's 48 kbps. (The free plan caps files at
-- 50 MB globally; raise that in Storage settings if meetings run > 2 hours.)
insert into storage.buckets (id, name, public, file_size_limit)
  values ('recordings', 'recordings', false, 209715200)
  on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "authenticated can upload recordings" on storage.objects;
create policy "authenticated can upload recordings"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings');

drop policy if exists "authenticated can update recordings" on storage.objects;
create policy "authenticated can update recordings"
  on storage.objects for update to authenticated
  using (bucket_id = 'recordings');

drop policy if exists "authenticated can read recordings" on storage.objects;
create policy "authenticated can read recordings"
  on storage.objects for select to authenticated
  using (bucket_id = 'recordings');
