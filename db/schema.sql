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
-- Planning periods for the roadmap. Teams don't use calendar quarters, so a
-- period is any date range with a name ("Aug–Nov 2026").
create table if not exists periods (
  id          uuid primary key default gen_random_uuid(),
  team        text not null default 'leadership' check (team in ('leadership', 'management')),
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  created_at  timestamptz not null default now(),
  unique (team, name),
  check (end_date >= start_date)
);

create table if not exists rocks (
  id          uuid primary key default gen_random_uuid(),
  team        text not null default 'leadership' check (team in ('leadership', 'management')),
  period_id   uuid references periods(id) on delete set null,
  title       text not null,
  owner       text,
  -- 'planned' = on the roadmap, its period hasn't started
  status      text not null default 'on_track'
                check (status in ('planned', 'on_track', 'off_track', 'complete', 'dropped')),
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

-- ── Steps: break a to-do, issue or rock into smaller pieces ──────────────
-- Two levels under the item (step → sub-step). Written by hand or by the
-- AI breakdown; no FK to the parent because it can be any of three tables —
-- the delete routes and analysis re-commits clean them up.
create table if not exists steps (
  id              uuid primary key default gen_random_uuid(),
  parent_type     text not null check (parent_type in ('todo', 'issue', 'rock')),
  parent_id       uuid not null,
  parent_step_id  uuid references steps(id) on delete cascade,
  title           text not null,
  done            boolean not null default false,
  sort_order      integer not null default 0,
  source          text not null default 'manual' check (source in ('manual', 'ai')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists steps_parent_idx on steps(parent_type, parent_id);

-- ── Upgrades for databases created by an earlier version of this file ─────
-- (create table if not exists doesn't add columns to existing tables)
alter table rocks add column if not exists period_id uuid references periods(id) on delete set null;
alter table rocks drop constraint if exists rocks_status_check;
alter table rocks add constraint rocks_status_check check (status in ('planned', 'on_track', 'off_track', 'complete', 'dropped'));
alter table meeting_rocks add column if not exists source text not null default 'manual' check (source in ('manual', 'analysis'));
alter table todos         add column if not exists source text not null default 'manual' check (source in ('manual', 'analysis'));
alter table issues        add column if not exists source text not null default 'manual' check (source in ('manual', 'analysis'));
alter table headlines     add column if not exists source text not null default 'manual' check (source in ('manual', 'analysis'));
alter table meetings          add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
alter table rocks             add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
alter table scorecard_metrics add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
alter table taxdome_imports   add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));

-- To-dos and issues can exist without a meeting (added from their own pages),
-- so they carry their team directly. Issues also get a rank (1 = top) and a
-- horizon: 'short' is the working IDS list, 'long' the long-term issues list.
alter table todos  alter column meeting_id drop not null;
alter table issues alter column meeting_id drop not null;
alter table todos  add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
alter table issues add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
update todos  x set team = m.team from meetings m where m.id = x.meeting_id and x.team <> m.team;
update issues x set team = m.team from meetings m where m.id = x.meeting_id and x.team <> m.team;
alter table issues add column if not exists horizon text not null default 'short' check (horizon in ('short', 'long'));
alter table issues add column if not exists rank integer;
update issues x set rank = r.n + coalesce((select max(y.rank) from issues y where y.team = r.team and y.horizon = r.horizon), 0)
from (
  select id, team, horizon, row_number() over (
    partition by team, horizon
    order by case priority when 'high' then 0 when 'medium' then 1 else 2 end, created_at
  ) as n
  from issues where rank is null
) r
where r.id = x.id;

-- ── P0 ──────────────────────────────────────────────────────────────────
-- People, sign-in tokens, company settings, owner ids, to-do fields, rock
-- level, Ninety import bookkeeping. Also shipped as db/upgrades/p0-foundation.sql.

-- ── People ────────────────────────────────────────────────────────────────
-- One row per person who owns EOS items and/or signs in. A person without a
-- password_hash can own items but cannot sign in until they use a setup link.
-- email is stored lower-cased; people created by the Ninety importer may have
-- none until an admin adds it. teams lists the EOS teams the person belongs to.
-- session_version is bumped to sign the person out everywhere (password change,
-- reset, deactivation, role change).
create table if not exists people (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (btrim(name) <> ''),
  email                text check (email is null or (email = lower(btrim(email)) and email like '%_@_%')),
  title                text,
  role                 text not null default 'member'
                         check (role in ('owner', 'admin', 'facilitator', 'manager', 'member', 'observer')),
  teams                text[] not null default '{}'
                         check (teams <@ array['leadership', 'management']::text[]),
  aliases              text[] not null default '{}',
  active               boolean not null default true,
  password_hash        text,
  password_updated_at  timestamptz,
  session_version      integer not null default 1,
  last_login_at        timestamptz,
  -- soft references (no FK): the batch that created this person, and who added them
  import_batch_id      uuid,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists people_email_uidx on people(email) where email is not null;
create index if not exists people_active_idx on people(active, name);

-- One-time setup / reset links. Only the SHA-256 of the token is stored.
create table if not exists person_tokens (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references people(id) on delete cascade,
  purpose     text not null check (purpose in ('setup', 'reset')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid references people(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists person_tokens_person_idx on person_tokens(person_id);

-- ── Company settings (exactly one row, id = true) ─────────────────────────
-- Quarter starts are month-day ('MM-DD'), the same every year. A fiscal year
-- whose Q1 starts after January spans two calendar years; fiscal_year_named_by
-- says whether "FY 2026" is the year it starts in or ends in.
create table if not exists company_settings (
  id                    boolean primary key default true check (id),
  company_name          text not null default 'J Heath & Co',
  week_start            smallint not null default 2 check (week_start between 0 and 6),
  timezone              text not null default 'America/Chicago',
  q1_start              text not null default '02-01' check (q1_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  q2_start              text not null default '05-01' check (q2_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  q3_start              text not null default '08-01' check (q3_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  q4_start              text not null default '11-01' check (q4_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  fiscal_year_named_by  text not null default 'start' check (fiscal_year_named_by in ('start', 'end')),
  -- Pre-fills "@<domain>" when an admin adds a person; never enforced
  email_domain          text check (email_domain is null or email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  recap_webhook_url     text check (recap_webhook_url is null or recap_webhook_url ~ '^https://'),
  recap_webhook_secret  text,
  updated_by            uuid references people(id) on delete set null,
  updated_at            timestamptz not null default now()
);
insert into company_settings (id) values (true) on conflict (id) do nothing;
-- Owner names deliberately kept as text (e.g. consultants with no account)
alter table company_settings add column if not exists text_only_owner_names text[] not null default '{}';

-- ── Import batches (one per importer commit; lets an import be undone) ────
create table if not exists import_batches (
  id               uuid primary key default gen_random_uuid(),
  source           text not null default 'ninety' check (source in ('ninety')),
  file_names       jsonb not null default '[]',
  options          jsonb not null default '{}',
  counts           jsonb not null default '{}',
  status           text not null default 'committed' check (status in ('committed', 'undone')),
  created_by       uuid references people(id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  undone_at        timestamptz,
  undone_by        uuid references people(id) on delete set null,
  undone_counts    jsonb
);
create index if not exists import_batches_created_idx on import_batches(created_at desc);

-- ── Owner ids next to the free-text owner columns ─────────────────────────
-- The text column stays and is kept equal to people.name by the app, so every
-- existing reader (lists, PDF, AI prompts) keeps working.
alter table rocks             add column if not exists owner_id uuid references people(id) on delete set null;
alter table todos             add column if not exists owner_id uuid references people(id) on delete set null;
alter table meeting_rocks     add column if not exists owner_id uuid references people(id) on delete set null;
alter table scorecard_metrics add column if not exists owner_id uuid references people(id) on delete set null;
alter table headlines         add column if not exists presenter_id uuid references people(id) on delete set null;
alter table issues            add column if not exists owner text;
alter table issues            add column if not exists owner_id uuid references people(id) on delete set null;

-- ── New item fields ───────────────────────────────────────────────────────
alter table todos  add column if not exists due_date date;
alter table todos  add column if not exists description text;
alter table todos  add column if not exists completed_at timestamptz;
alter table issues add column if not exists solved_at timestamptz;
alter table rocks  add column if not exists level text check (level in ('company', 'individual'));
alter table rocks  add column if not exists completed_at timestamptz;
-- Milestones (steps under a rock) get a date and owner now; UI arrives in P1
alter table steps  add column if not exists due_date date;
alter table steps  add column if not exists owner text;
alter table steps  add column if not exists owner_id uuid references people(id) on delete set null;

-- Headlines can exist outside a meeting (Ninety import now, Headlines page in P1)
alter table headlines alter column meeting_id drop not null;
alter table headlines add column if not exists team text not null default 'leadership' check (team in ('leadership', 'management'));
alter table headlines add column if not exists description text;
update headlines x set team = m.team from meetings m where m.id = x.meeting_id and x.team <> m.team;

-- Scorecard entries written by the importer
alter table scorecard_entries drop constraint if exists scorecard_entries_source_check;
alter table scorecard_entries add constraint scorecard_entries_source_check check (source in ('manual', 'taxdome', 'import'));

-- ── External ids (dedupe) and import batch links ──────────────────────────
alter table issues            add column if not exists external_source text;
alter table issues            add column if not exists external_id text;
alter table issues            add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table todos             add column if not exists external_source text;
alter table todos             add column if not exists external_id text;
alter table todos             add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table rocks             add column if not exists external_source text;
alter table rocks             add column if not exists external_id text;
alter table rocks             add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table steps             add column if not exists external_source text;
alter table steps             add column if not exists external_id text;
alter table steps             add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table headlines         add column if not exists external_source text;
alter table headlines         add column if not exists external_id text;
alter table headlines         add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table scorecard_metrics add column if not exists external_source text;
alter table scorecard_metrics add column if not exists external_id text;
alter table scorecard_metrics add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table scorecard_entries add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
alter table periods           add column if not exists import_batch_id uuid references import_batches(id) on delete set null;

create unique index if not exists issues_external_uidx            on issues(external_source, external_id)            where external_id is not null;
create unique index if not exists todos_external_uidx             on todos(external_source, external_id)             where external_id is not null;
create unique index if not exists rocks_external_uidx             on rocks(external_source, external_id)             where external_id is not null;
create unique index if not exists steps_external_uidx             on steps(external_source, external_id)             where external_id is not null;
create unique index if not exists headlines_external_uidx         on headlines(external_source, external_id)         where external_id is not null;
create unique index if not exists scorecard_metrics_external_uidx on scorecard_metrics(external_source, external_id) where external_id is not null;

create index if not exists issues_import_batch_idx            on issues(import_batch_id)            where import_batch_id is not null;
create index if not exists todos_import_batch_idx             on todos(import_batch_id)             where import_batch_id is not null;
create index if not exists rocks_import_batch_idx             on rocks(import_batch_id)             where import_batch_id is not null;
create index if not exists steps_import_batch_idx             on steps(import_batch_id)             where import_batch_id is not null;
create index if not exists headlines_import_batch_idx         on headlines(import_batch_id)         where import_batch_id is not null;
create index if not exists scorecard_metrics_import_batch_idx on scorecard_metrics(import_batch_id) where import_batch_id is not null;
create index if not exists scorecard_entries_import_batch_idx on scorecard_entries(import_batch_id) where import_batch_id is not null;
create index if not exists periods_import_batch_idx           on periods(import_batch_id)           where import_batch_id is not null;

-- ── Owner lookups ─────────────────────────────────────────────────────────
create index if not exists rocks_owner_idx             on rocks(owner_id)             where owner_id is not null;
create index if not exists todos_owner_idx             on todos(owner_id)             where owner_id is not null;
create index if not exists issues_owner_idx            on issues(owner_id)            where owner_id is not null;
create index if not exists meeting_rocks_owner_idx     on meeting_rocks(owner_id)     where owner_id is not null;
create index if not exists scorecard_metrics_owner_idx on scorecard_metrics(owner_id) where owner_id is not null;
create index if not exists headlines_presenter_idx     on headlines(presenter_id)     where presenter_id is not null;
create index if not exists headlines_team_idx          on headlines(team);
create index if not exists todos_due_idx               on todos(team, due_date)       where status = 'open';

-- ── Name keys used to match free text to people ───────────────────────────
-- key = lower-cased trimmed text. A full name or alias (strength 1) beats a
-- first name (strength 2). A key is kept only when exactly one active person
-- holds it at its best strength, so "Jude" never matches when two Judes exist.
create or replace view person_name_keys as
with p as (
  select id, name, aliases,
         lower(btrim(name)) as full_key,
         lower(split_part(btrim(name), ' ', 1)) as first_key
  from people
  where active
),
k as (
  select full_key as key, id, name, 1 as strength from p
  union all
  select lower(btrim(a)), p.id, p.name, 1 from p cross join lateral unnest(p.aliases) as a where btrim(a) <> ''
  union all
  select first_key, id, name, 2 from p where first_key <> full_key
),
ranked as (
  select key, id, name, strength, min(strength) over (partition by key) as best from k
)
select key, min(id::text)::uuid as person_id, min(name) as name
from ranked
where strength = best
group by key
having count(distinct id) = 1;

-- Background meeting analysis (2026-09-30)
alter table meetings add column if not exists analysis_started_at timestamptz;
alter table meetings add column if not exists analysis_error text;

-- ── Indexes ───────────────────────────────────────────────────────────────
create index if not exists meetings_date_idx        on meetings(date desc);
create index if not exists meetings_team_idx        on meetings(team);
create index if not exists rocks_team_idx           on rocks(team);
create index if not exists rocks_period_idx         on rocks(period_id);
create index if not exists periods_team_idx         on periods(team, start_date);
create index if not exists scorecard_metrics_team_idx on scorecard_metrics(team);
create index if not exists meeting_rocks_meeting_idx on meeting_rocks(meeting_id);
create index if not exists todos_meeting_idx        on todos(meeting_id);
create index if not exists todos_status_idx         on todos(status);
create index if not exists issues_meeting_idx       on issues(meeting_id);
create index if not exists issues_status_idx        on issues(status);
create index if not exists issues_team_rank_idx     on issues(team, horizon, rank);
create index if not exists todos_team_idx           on todos(team, status);
create index if not exists headlines_meeting_idx    on headlines(meeting_id);
create index if not exists scorecard_entries_period_idx on scorecard_entries(period_date desc);
