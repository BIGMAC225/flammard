-- Minutes Platform — Initial Schema
-- Run this in the Supabase SQL editor or via supabase db push

-- ── Extensions ───────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── Tables ───────────────────────────────────────────────────────────────

-- Meetings
create table public.meetings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid,
  title          text not null,
  date           date not null,
  location       text,
  attendees      jsonb not null default '[]',
  input_type     text check (input_type in ('recording', 'upload', 'transcript', 'text')),
  transcript     text,
  recording_path text,
  status         text not null default 'draft'
                   check (status in ('draft', 'minutes_draft', 'approved', 'distributed')),
  created_by     uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Structured minutes content
create table public.minutes (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null unique references public.meetings(id) on delete cascade,
  summary       text,
  decisions     jsonb not null default '[]',
  actions       jsonb not null default '[]',
  discussion    jsonb not null default '[]',
  version       integer not null default 1,
  content_hash  text,
  sealed_at     timestamptz,
  sealed_by     uuid references auth.users(id),
  pdf_path      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Approval records
create table public.approvals (
  id                 uuid primary key default gen_random_uuid(),
  minutes_id         uuid not null references public.minutes(id) on delete cascade,
  approved_by        uuid not null references auth.users(id),
  approved_by_email  text not null,
  hash_at_approval   text not null,
  notes              text,
  approved_at        timestamptz not null default now()
);

-- Email distributions (one row per recipient per send)
create table public.distributions (
  id               uuid primary key default gen_random_uuid(),
  minutes_id       uuid not null references public.minutes(id) on delete cascade,
  meeting_id       uuid not null references public.meetings(id) on delete cascade,
  recipient_email  text not null,
  recipient_name   text,
  token            uuid not null default gen_random_uuid(),
  sent_at          timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_ip  text,
  acknowledged_ua  text
);

-- Audit event chain (cryptographically linked)
create table public.audit_events (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references public.meetings(id) on delete cascade,
  event_type    text not null,
  actor_id      uuid,
  actor_email   text,
  payload       jsonb,
  prev_event_id uuid references public.audit_events(id),
  event_hash    text not null,
  created_at    timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
create index on public.meetings(created_by);
create index on public.meetings(status);
create index on public.meetings(date desc);
create index on public.minutes(meeting_id);
create index on public.distributions(token);
create index on public.distributions(meeting_id);
create index on public.distributions(minutes_id);
create index on public.audit_events(meeting_id);

-- ── Updated-at trigger ────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

create trigger minutes_set_updated_at
  before update on public.minutes
  for each row execute function public.set_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────
alter table public.meetings     enable row level security;
alter table public.minutes      enable row level security;
alter table public.approvals    enable row level security;
alter table public.distributions enable row level security;
alter table public.audit_events enable row level security;

-- Meetings: owner only
create policy "owner can select meetings"
  on public.meetings for select
  using (created_by = auth.uid());

create policy "owner can insert meetings"
  on public.meetings for insert
  with check (created_by = auth.uid());

create policy "owner can update meetings"
  on public.meetings for update
  using (created_by = auth.uid());

-- Minutes: scoped to meeting owner
create policy "owner can select minutes"
  on public.minutes for select
  using (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

create policy "owner can insert minutes"
  on public.minutes for insert
  with check (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

create policy "owner can update minutes"
  on public.minutes for update
  using (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

-- Approvals
create policy "owner can select approvals"
  on public.approvals for select
  using (
    minutes_id in (
      select m.id from public.minutes m
      join public.meetings mt on mt.id = m.meeting_id
      where mt.created_by = auth.uid()
    )
  );

create policy "owner can insert approvals"
  on public.approvals for insert
  with check (approved_by = auth.uid());

-- Distributions (owner reads; service role writes for acknowledge)
create policy "owner can select distributions"
  on public.distributions for select
  using (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

create policy "owner can insert distributions"
  on public.distributions for insert
  with check (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

-- Audit events
create policy "owner can select audit events"
  on public.audit_events for select
  using (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

create policy "owner can insert audit events"
  on public.audit_events for insert
  with check (
    meeting_id in (select id from public.meetings where created_by = auth.uid())
  );

-- ── Storage buckets ───────────────────────────────────────────────────────
-- Run these in the Supabase dashboard Storage section, or via the API:
--
--   INSERT INTO storage.buckets (id, name, public) VALUES ('minutes-pdf', 'minutes-pdf', false);
--
-- Then add a storage RLS policy:
--   CREATE POLICY "owner can read own pdfs"
--     ON storage.objects FOR SELECT
--     USING (
--       bucket_id = 'minutes-pdf'
--       AND auth.uid()::text = (storage.foldername(name))[1]
--     );
--
-- (The PDF is stored as minutes/{meeting_id}/... — you may need to adjust
--  the policy to match the actual path structure used in approve.ts)
