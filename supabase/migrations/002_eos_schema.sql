-- EOS (Entrepreneurial Operating System) L10 Meeting Schema
-- Adds rocks, todos, issues, scorecard, headlines tables

-- ── Rocks (quarterly goals) ──────────────────────────────────────────────
create table public.rocks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  owner       text,
  status      text not null default 'on_track'
                check (status in ('on_track', 'off_track', 'complete', 'dropped')),
  quarter     text,
  due_date    date,
  notes       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Rock review per-meeting (snapshot of status at that meeting)
create table public.meeting_rocks (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  rock_id     uuid references public.rocks(id) on delete set null,
  title       text not null,
  owner       text,
  status      text not null default 'on_track'
                check (status in ('on_track', 'off_track', 'complete', 'dropped')),
  notes       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ── To-Dos (7-day action items) ───────────────────────────────────────────
create table public.todos (
  id                   uuid primary key default gen_random_uuid(),
  meeting_id           uuid not null references public.meetings(id) on delete cascade,
  title                text not null,
  owner                text,
  status               text not null default 'open'
                         check (status in ('open', 'done', 'not_done', 'dropped')),
  resolved_meeting_id  uuid references public.meetings(id) on delete set null,
  created_by           uuid not null references auth.users(id) on delete cascade,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── Issues (IDS items) ────────────────────────────────────────────────────
create table public.issues (
  id                      uuid primary key default gen_random_uuid(),
  meeting_id              uuid not null references public.meetings(id) on delete cascade,
  title                   text not null,
  description             text,
  priority                text not null default 'medium'
                            check (priority in ('low', 'medium', 'high')),
  status                  text not null default 'open'
                            check (status in ('open', 'solved', 'dropped')),
  resolution              text,
  resolved_in_meeting_id  uuid references public.meetings(id) on delete set null,
  created_by              uuid not null references auth.users(id) on delete cascade,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ── Scorecard metrics (recurring measurables) ─────────────────────────────
create table public.scorecard_metrics (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  owner       text,
  goal        text,
  unit        text,
  frequency   text not null default 'weekly'
                check (frequency in ('weekly', 'monthly', 'quarterly')),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Scorecard entries (per-meeting actuals)
create table public.scorecard_entries (
  id          uuid primary key default gen_random_uuid(),
  metric_id   uuid not null references public.scorecard_metrics(id) on delete cascade,
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  value       text,
  on_track    boolean,
  notes       text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (metric_id, meeting_id)
);

-- ── Headlines ──────────────────────────────────────────────────────────────
create table public.headlines (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  type        text not null default 'general'
                check (type in ('customer', 'employee', 'general')),
  text        text not null,
  presenter   text,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ── Meeting EOS metadata (rating, conclude notes) ─────────────────────────
alter table public.meetings
  add column if not exists meeting_rating  numeric(3,1),
  add column if not exists conclude_notes  text,
  add column if not exists eos_analyzed    boolean not null default false;

-- ── Indexes ────────────────────────────────────────────────────────────────
create index on public.rocks(created_by);
create index on public.rocks(status);
create index on public.meeting_rocks(meeting_id);
create index on public.meeting_rocks(rock_id);
create index on public.todos(meeting_id);
create index on public.todos(status);
create index on public.todos(created_by);
create index on public.issues(meeting_id);
create index on public.issues(status);
create index on public.issues(created_by);
create index on public.scorecard_metrics(created_by);
create index on public.scorecard_entries(meeting_id);
create index on public.scorecard_entries(metric_id);
create index on public.headlines(meeting_id);

-- ── Updated-at triggers ────────────────────────────────────────────────────
create trigger rocks_set_updated_at
  before update on public.rocks
  for each row execute function public.set_updated_at();

create trigger todos_set_updated_at
  before update on public.todos
  for each row execute function public.set_updated_at();

create trigger issues_set_updated_at
  before update on public.issues
  for each row execute function public.set_updated_at();

create trigger scorecard_metrics_set_updated_at
  before update on public.scorecard_metrics
  for each row execute function public.set_updated_at();

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.rocks               enable row level security;
alter table public.meeting_rocks       enable row level security;
alter table public.todos               enable row level security;
alter table public.issues              enable row level security;
alter table public.scorecard_metrics   enable row level security;
alter table public.scorecard_entries   enable row level security;
alter table public.headlines           enable row level security;

-- Rocks: owner only
create policy "owner can select rocks"
  on public.rocks for select using (created_by = auth.uid());
create policy "owner can insert rocks"
  on public.rocks for insert with check (created_by = auth.uid());
create policy "owner can update rocks"
  on public.rocks for update using (created_by = auth.uid());
create policy "owner can delete rocks"
  on public.rocks for delete using (created_by = auth.uid());

-- Meeting rocks: scoped to meeting owner
create policy "owner can select meeting_rocks"
  on public.meeting_rocks for select
  using (meeting_id in (select id from public.meetings where created_by = auth.uid()));
create policy "owner can insert meeting_rocks"
  on public.meeting_rocks for insert with check (created_by = auth.uid());
create policy "owner can update meeting_rocks"
  on public.meeting_rocks for update using (created_by = auth.uid());
create policy "owner can delete meeting_rocks"
  on public.meeting_rocks for delete using (created_by = auth.uid());

-- Todos
create policy "owner can select todos"
  on public.todos for select using (created_by = auth.uid());
create policy "owner can insert todos"
  on public.todos for insert with check (created_by = auth.uid());
create policy "owner can update todos"
  on public.todos for update using (created_by = auth.uid());
create policy "owner can delete todos"
  on public.todos for delete using (created_by = auth.uid());

-- Issues
create policy "owner can select issues"
  on public.issues for select using (created_by = auth.uid());
create policy "owner can insert issues"
  on public.issues for insert with check (created_by = auth.uid());
create policy "owner can update issues"
  on public.issues for update using (created_by = auth.uid());
create policy "owner can delete issues"
  on public.issues for delete using (created_by = auth.uid());

-- Scorecard metrics
create policy "owner can select scorecard_metrics"
  on public.scorecard_metrics for select using (created_by = auth.uid());
create policy "owner can insert scorecard_metrics"
  on public.scorecard_metrics for insert with check (created_by = auth.uid());
create policy "owner can update scorecard_metrics"
  on public.scorecard_metrics for update using (created_by = auth.uid());
create policy "owner can delete scorecard_metrics"
  on public.scorecard_metrics for delete using (created_by = auth.uid());

-- Scorecard entries
create policy "owner can select scorecard_entries"
  on public.scorecard_entries for select
  using (meeting_id in (select id from public.meetings where created_by = auth.uid()));
create policy "owner can insert scorecard_entries"
  on public.scorecard_entries for insert with check (created_by = auth.uid());
create policy "owner can update scorecard_entries"
  on public.scorecard_entries for update using (created_by = auth.uid());
create policy "owner can delete scorecard_entries"
  on public.scorecard_entries for delete using (created_by = auth.uid());

-- Headlines
create policy "owner can select headlines"
  on public.headlines for select
  using (meeting_id in (select id from public.meetings where created_by = auth.uid()));
create policy "owner can insert headlines"
  on public.headlines for insert with check (created_by = auth.uid());
create policy "owner can delete headlines"
  on public.headlines for delete using (created_by = auth.uid());
