-- Flammard schema for Netlify DB (Neon Postgres).
-- Apply with `npm run db:setup` (reads NETLIFY_DATABASE_URL). Safe to re-run.
--
-- There is one shared login, so tables carry no per-user ownership and there
-- is no row-level security: every query goes through the app's API, which
-- checks the session cookie.
--
-- Two EOS teams (leadership, management) share the login but keep separate
-- meetings, rocks, to-dos, issues, headlines and scorecards. `team` lives on
-- meetings, rocks and scorecard_metrics; everything else belongs to a meeting
-- and inherits its team.

create extension if not exists pgcrypto;

-- ── Meetings ──────────────────────────────────────────────────────────────
create table if not exists meetings (
  id               uuid primary key default gen_random_uuid(),
  team             text not null default 'leadership' check (team in ('leadership', 'management')),
  title            text not null,
  date             date not null,
  location         text,
  attendees        jsonb not null default '[]',
  input_type       text check (input_type in ('recording', 'upload', 'transcript', 'text')),
  transcript       text,
  transcript_path  text,
  -- Browser recording, stored in Netlify Blobs as numbered chunks under this prefix
  recording_path   text,
  recording_parts  integer,
  recording_mime   text,
  analysis         jsonb,
  analysis_status  text not null default 'none'
                     check (analysis_status in ('none', 'ready', 'committed')),
  analyzed_at      timestamptz,
  meeting_rating   numeric(3,1),
  conclude_notes   text,
  eos_analyzed     boolean not null default false,
  status           text not null default 'draft'
                     check (status in ('draft', 'minutes_draft', 'approved', 'distributed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Structured minutes content
create table if not exists minutes (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null unique references meetings(id) on delete cascade,
  summary       text,
  decisions     jsonb not null default '[]',
  actions       jsonb not null default '[]',
  discussion    jsonb not null default '[]',
  version       integer not null default 1,
  content_hash  text,
  sealed_at     timestamptz,
  pdf_path      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists approvals (
  id                 uuid primary key default gen_random_uuid(),
  minutes_id         uuid not null references minutes(id) on delete cascade,
  approved_by        text not null,
  hash_at_approval   text not null,
  notes              text,
  approved_at        timestamptz not null default now()
);

-- ── EOS ───────────────────────────────────────────────────────────────────
create table if not exists rocks (
  id          uuid primary key default gen_random_uuid(),
  team        text not null default 'leadership' check (team in ('leadership', 'management')),
  title       text not null,
  owner       text,
  status      text not null default 'on_track'
                check (status in ('on_track', 'off_track', 'complete', 'dropped')),
  quarter     text,
  due_date    date,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Rock review per meeting (snapshot of status at that meeting).
-- `source` on this and the next three tables: 'analysis' rows were created by
-- accepting a transcript analysis and are replaced when it is accepted again;
-- 'manual' rows (added on the EOS tab) are never touched by that.
create table if not exists meeting_rocks (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  rock_id     uuid references rocks(id) on delete set null,
  title       text not null,
  owner       text,
  status      text not null default 'on_track'
                check (status in ('on_track', 'off_track', 'complete', 'dropped')),
  notes       text,
  source      text not null default 'manual' check (source in ('manual', 'analysis')),
  created_at  timestamptz not null default now()
);

create table if not exists todos (
  id                   uuid primary key default gen_random_uuid(),
  meeting_id           uuid not null references meetings(id) on delete cascade,
  title                text not null,
  owner                text,
  status               text not null default 'open'
                         check (status in ('open', 'done', 'not_done', 'dropped')),
  resolved_meeting_id  uuid references meetings(id) on delete set null,
  source               text not null default 'manual' check (source in ('manual', 'analysis')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists issues (
  id                      uuid primary key default gen_random_uuid(),
  meeting_id              uuid not null references meetings(id) on delete cascade,
  title                   text not null,
  description             text,
  priority                text not null default 'medium'
                            check (priority in ('low', 'medium', 'high')),
  status                  text not null default 'open'
                            check (status in ('open', 'solved', 'dropped')),
  resolution              text,
  resolved_in_meeting_id  uuid references meetings(id) on delete set null,
  source                  text not null default 'manual' check (source in ('manual', 'analysis')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists headlines (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  type        text not null default 'general'
                check (type in ('customer', 'employee', 'general')),
  text        text not null,
  presenter   text,
  source      text not null default 'manual' check (source in ('manual', 'analysis')),
  created_at  timestamptz not null default now()
);

-- ── Scorecard ─────────────────────────────────────────────────────────────
create table if not exists scorecard_metrics (
  id           uuid primary key default gen_random_uuid(),
  team         text not null default 'leadership' check (team in ('leadership', 'management')),
  title        text not null,
  owner        text,
  goal         text,
  unit         text,
  frequency    text not null default 'weekly'
                 check (frequency in ('weekly', 'monthly', 'quarterly')),
  -- Where to find this number in the TaxDome report (used by the extractor)
  description  text,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One value per metric per reporting period
create table if not exists scorecard_entries (
  id           uuid primary key default gen_random_uuid(),
  metric_id    uuid not null references scorecard_metrics(id) on delete cascade,
  period_date  date not null,
  value        text,
  on_track     boolean,
  notes        text,
  source       text not null default 'manual' check (source in ('manual', 'taxdome')),
  import_id    uuid,
  created_at   timestamptz not null default now(),
  unique (metric_id, period_date)
);

-- One row per TaxDome report received through the webhook
create table if not exists taxdome_imports (
  id               uuid primary key default gen_random_uuid(),
  team             text not null default 'leadership' check (team in ('leadership', 'management')),
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

-- ── Indexes ───────────────────────────────────────────────────────────────
create index if not exists meetings_date_idx        on meetings(date desc);
create index if not exists meetings_team_idx        on meetings(team);
create index if not exists rocks_team_idx           on rocks(team);
create index if not exists scorecard_metrics_team_idx on scorecard_metrics(team);
create index if not exists meeting_rocks_meeting_idx on meeting_rocks(meeting_id);
create index if not exists todos_meeting_idx        on todos(meeting_id);
create index if not exists todos_status_idx         on todos(status);
create index if not exists issues_meeting_idx       on issues(meeting_id);
create index if not exists issues_status_idx        on issues(status);
create index if not exists headlines_meeting_idx    on headlines(meeting_id);
create index if not exists scorecard_entries_period_idx on scorecard_entries(period_date desc);
