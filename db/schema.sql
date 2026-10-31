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

-- ── L10 Conclude (2026-10-15) ─────────────────────────────────────────────
-- Also shipped as db/upgrades/2026-10-15-l10-conclude.sql.
-- One rating per attendee per meeting (1–10). `name` is the attendee as
-- written on the meeting; person_id is set when it matches a person. The
-- average is kept on meetings.meeting_rating so the PDF and lists keep working.
create table if not exists meeting_ratings (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  person_id   uuid references people(id) on delete set null,
  name        text not null check (btrim(name) <> ''),
  rating      smallint not null check (rating between 1 and 10),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists meeting_ratings_meeting_name_uidx on meeting_ratings(meeting_id, lower(btrim(name)));

-- Cascading messages agreed in Conclude: what to tell whom, by whom, and how.
create table if not exists cascading_messages (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  message     text not null check (btrim(message) <> ''),
  to_whom     text,
  by_whom     text,
  by_whom_id  uuid references people(id) on delete set null,
  how         text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists cascading_messages_meeting_idx on cascading_messages(meeting_id, sort_order);

-- Which closes the transcript analysis made, so accepting an analysis again
-- undoes only its own work: a to-do or issue a person closed on the meeting
-- page stays closed. analysis_resolution is the text the analysis wrote
-- (null when it kept an existing resolution), so undo never nulls a
-- resolution a person typed.
alter table todos  add column if not exists closed_by_analysis boolean not null default false;
alter table issues add column if not exists closed_by_analysis boolean not null default false;
alter table issues add column if not exists analysis_resolution text;

-- Which meeting carried a rock review / closed a to-do or issue
create index if not exists meeting_rocks_rock_idx       on meeting_rocks(rock_id) where rock_id is not null;
create index if not exists todos_resolved_meeting_idx   on todos(resolved_meeting_id) where resolved_meeting_id is not null;
create index if not exists issues_resolved_meeting_idx  on issues(resolved_in_meeting_id) where resolved_in_meeting_id is not null;

-- ── L10 rules (2026-10-15) ───────────────────────────────────────────────
-- Also shipped as db/upgrades/2026-10-15-l10-rules.sql.
-- An issue dropped from an off-track rock or a headline keeps the link
alter table issues add column if not exists rock_id     uuid references rocks(id)     on delete set null;
alter table issues add column if not exists headline_id uuid references headlines(id) on delete set null;
-- Optional type: a problem to solve, information to share, or an idea
alter table issues add column if not exists issue_type text check (issue_type in ('problem', 'information', 'idea'));
create index if not exists issues_rock_idx     on issues(rock_id)     where rock_id is not null;
create index if not exists issues_headline_idx on issues(headline_id) where headline_id is not null;

-- The to-do that came out of solving an issue
alter table todos add column if not exists issue_id uuid references issues(id) on delete set null;
create index if not exists todos_issue_idx on todos(issue_id) where issue_id is not null;

-- Quarter end: each rock is done or not done (status 'complete' = done)
alter table rocks add column if not exists outcome text check (outcome in ('done', 'not_done'));

-- The three issues the team picked to work in a meeting, in order 1, 2, 3
create table if not exists meeting_issues (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  issue_id    uuid not null references issues(id) on delete cascade,
  position    smallint not null check (position between 1 and 3),
  created_at  timestamptz not null default now(),
  unique (meeting_id, position),
  unique (meeting_id, issue_id)
);

-- Minutes "actions" become to-dos (one list). The minutes keep their copy
-- for the sealed PDF; external_id makes this re-runnable without duplicates.
alter table todos drop constraint if exists todos_source_check;
alter table todos add constraint todos_source_check check (source in ('manual', 'analysis', 'minutes'));
insert into todos (meeting_id, team, title, owner, owner_id, status, due_date, completed_at, source, external_source, external_id, created_at)
select mi.meeting_id, m.team, left(a->>'text', 500),
       coalesce(k.name, nullif(btrim(a->>'owner'), '')), k.person_id,
       case when a->>'status' = 'completed' then 'done' else 'open' end,
       case when (a->>'due_date') ~ '^\d{4}-\d{2}-\d{2}$' then (a->>'due_date')::date else null end,
       case when a->>'status' = 'completed' then mi.updated_at else null end,
       'minutes', 'minutes', mi.meeting_id::text || ':' || coalesce(a->>'id', ord::text), mi.created_at
from minutes mi
join meetings m on m.id = mi.meeting_id
cross join lateral jsonb_array_elements(case when jsonb_typeof(mi.actions) = 'array' then mi.actions else '[]'::jsonb end) with ordinality as x(a, ord)
left join person_name_keys k on k.key = lower(btrim(a->>'owner'))
where nullif(btrim(a->>'text'), '') is not null
  -- not already a to-do (an analysis commit from before this key, or the same action re-run)
  and not exists (select 1 from todos t where t.meeting_id = mi.meeting_id and lower(btrim(t.title)) = lower(btrim(left(a->>'text', 500))))
on conflict (external_source, external_id) where external_id is not null do nothing;

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

-- ── Fulfillment (TaxDome pipelines) ────────────────────────────────────────
-- Also shipped as db/upgrades/2026-10-23-fulfillment.sql. Additive and safe
-- to run more than once. stage_order stores the API field "order" (a reserved
-- word in SQL); td_people is keyed by (actor_type, id) because owner and
-- employee ids can overlap.

-- "create type" has no "if not exists" in Postgres; the DO block ignores an
-- already-existing type
do $$ begin create type fulfillment_source as enum ('api', 'csv'); exception when duplicate_object then null; end $$;

-- One row per import run (API pull or CSV upload), with counts of what it wrote
create table if not exists import_runs (
  id               bigint generated always as identity primary key,
  source           fulfillment_source not null,
  status           text not null check (status in ('running', 'ok', 'error')),
  started_at       timestamptz not null,
  finished_at      timestamptz,
  snapshot_date    date,
  requests_made    integer,
  jobs_written     integer,
  jobs_new         integer,
  jobs_moved       integer,
  jobs_moved_back  integer,
  jobs_completed   integer,
  jobs_archived    integer,
  jobs_reopened    integer,
  alerts_opened    integer,
  error            text,
  detail           jsonb
);
create index if not exists import_runs_snapshot_idx on import_runs(snapshot_date, source);

-- TaxDome reference data, replaced wholesale on each sync
create table if not exists td_pipelines (
  id                      bigint primary key,
  title                   text not null,
  default_job_template_id bigint,
  synced_at               timestamptz not null
);

create table if not exists td_pipeline_stages (
  id               bigint primary key,
  pipeline_id      bigint not null references td_pipelines(id),
  title            text not null,
  stage_order      integer,
  stage_limit_days integer,
  automove_jobs    boolean,
  synced_at        timestamptz not null
);
create unique index if not exists td_pipeline_stages_order_uidx on td_pipeline_stages(pipeline_id, stage_order);

create table if not exists td_job_statuses (
  id          bigint primary key,
  pipeline_id bigint not null references td_pipelines(id),
  kind        text check (kind in ('active', 'archived', 'completed', 'on_hold')),
  name        text,
  synced_at   timestamptz not null
);

create table if not exists td_people (
  actor_type   text not null check (actor_type in ('Owner', 'Employee')),
  id           bigint not null,
  user_id      bigint,
  first_name   text,
  last_name    text,
  email        text,
  role         text,
  display_name text,
  synced_at    timestamptz not null,
  primary key (actor_type, id)
);

create table if not exists td_clients (
  id           bigint primary key,
  account_name text,
  company_name text,
  account_type text,
  code         text,
  lead         boolean,
  archived_at  timestamptz,
  tag_ids      bigint[],
  synced_at    timestamptz not null
);
create index if not exists td_clients_name_idx on td_clients(lower(account_name));

-- Postgres requires a generated-column expression to be immutable, but
-- "timestamptz at time zone 'America/Chicago'" is only stable (it depends on
-- the timezone setting), so the conversion is wrapped in an immutable
-- function. One line on purpose: scripts/db-setup.mjs splits statements on
-- ";" + newline.
create or replace function fulfillment_chicago_date(ts timestamptz) returns date language sql immutable parallel safe return (ts at time zone 'America/Chicago')::date;

-- One row per job per snapshot date
create table if not exists job_snapshots (
  snapshot_date     date not null,
  job_id            bigint not null,
  job_name          text,
  pipeline_id       bigint not null references td_pipelines(id),
  stage_id          bigint not null references td_pipeline_stages(id),
  status_id         bigint references td_job_statuses(id),
  moved_at          timestamptz not null,
  status_changed_at timestamptz,
  intake_date       date,
  start_date        date,
  due_date          date,
  internal_deadline date,
  completed_at      timestamptz,
  created_at        timestamptz,
  time_budget       integer,
  time_tracked      integer,
  priority          text,
  assignee_ids      bigint[] not null default '{}',
  assignee_actors   text[] not null default '{}',
  client_id         bigint not null references td_clients(id),
  source            fulfillment_source not null,
  import_run_id     bigint not null references import_runs(id),
  captured_at       timestamptz not null,
  days_in_stage     integer generated always as (snapshot_date - fulfillment_chicago_date(moved_at)) stored,
  primary key (snapshot_date, job_id)
);
create index if not exists job_snapshots_job_captured_idx on job_snapshots(job_id, captured_at desc);
create index if not exists job_snapshots_date_stage_idx on job_snapshots(snapshot_date, stage_id);
create index if not exists job_snapshots_assignees_gin_idx on job_snapshots using gin(assignee_ids);

-- Time a job spent in each stage (entered when the job appears in it, exited
-- when it moves on)
create table if not exists stage_intervals (
  id          bigint generated always as identity primary key,
  job_id      bigint not null,
  pipeline_id bigint not null,
  stage_id    bigint not null,
  entered_at  timestamptz not null,
  exited_at   timestamptz,
  days        integer,
  unique (job_id, stage_id, entered_at)
);
create index if not exists stage_intervals_open_idx on stage_intervals(job_id) where exited_at is null;

-- Events derived by diffing consecutive snapshots
create table if not exists job_events (
  id            bigint generated always as identity primary key,
  job_id        bigint not null,
  event_type    text not null check (event_type in
                ('new', 'moved', 'moved_back', 'status_changed', 'completed', 'archived', 'reopened')),
  at            timestamptz not null,
  from_stage_id bigint,
  to_stage_id   bigint,
  detail        jsonb,
  import_run_id bigint references import_runs(id)
);
create index if not exists job_events_job_at_idx  on job_events(job_id, at desc);
create index if not exists job_events_type_at_idx on job_events(event_type, at desc);

-- Days a job may sit in a stage type before it is stuck or critical
create table if not exists stall_rules (
  stage_type    text primary key,
  stuck_days    integer not null,
  critical_days integer not null,
  ball_with     text not null check (ball_with in ('client', 'firm', 'excluded'))
);

-- Default stall rules (research report 03, section 3)
insert into stall_rules (stage_type, stuck_days, critical_days, ball_with) values
  ('intake', 7, 14, 'client'),
  ('documents', 14, 30, 'client'),
  ('ready_to_prepare', 5, 10, 'firm'),
  ('preparation', 7, 14, 'firm'),
  ('missing_info', 7, 14, 'client'),
  ('review', 5, 10, 'firm'),
  ('client_review_sign', 7, 14, 'client'),
  ('filing', 2, 5, 'firm'),
  ('delivery', 3, 7, 'firm'),
  -- excluded from stall counts; the sentinel keeps the NOT NULL columns satisfied
  ('on_hold', 9999, 9999, 'excluded'),
  -- fallback used by the rules runner for stages with no stage_type_map row
  ('unmapped', 7, 10, 'firm')
on conflict (stage_type) do nothing;

-- Not seeded: Russell fills stage_type_map later from plans/stage-type-map.csv
create table if not exists stage_type_map (
  pipeline_id bigint not null references td_pipelines(id),
  stage_id    bigint not null references td_pipeline_stages(id),
  stage_type  text not null references stall_rules(stage_type),
  primary key (pipeline_id, stage_id)
);

-- Alerts raised by the rules runner
create table if not exists alerts_log (
  id               bigint generated always as identity primary key,
  job_id           bigint,
  alert_type       text not null check (alert_type in
                   ('stuck', 'critical', 'past_internal_deadline', 'due_soon',
                    'no_snapshot', 'row_count_drop', 'unknown_stage')),
  level            text not null check (level in ('stuck', 'critical', 'escalated')),
  status           text not null default 'open' check (status in ('open', 'resolved', 'snoozed')),
  opened_at        timestamptz not null,
  last_notified_at timestamptz,
  snoozed_until    date,
  snooze_reason    text,
  resolved_at      timestamptz,
  detail           jsonb
);
create index if not exists alerts_log_open_idx on alerts_log(job_id, alert_type) where status = 'open';
create index if not exists alerts_log_job_idx on alerts_log(job_id);

-- ── Fulfillment settings (2026-10-24) ─────────────────────────────────────
-- Also shipped as db/upgrades/2026-10-24-fulfillment-settings.sql. Job
-- creation date from the TaxDome API, so arrival charts reach before the
-- first snapshot; nullable for rows captured before the column existed (the
-- charts fall back to intake_date / start_date).
alter table job_snapshots add column if not exists created_at timestamptz;

-- Part 2: the settings page's own schema — a hidden flag on td_pipelines,
-- per-stage threshold overrides on stage_type_map, the government_wait stall
-- rule, the hidden-pipeline seeds and a draft stage_type_map seeded from the
-- 2026-10-23 stages export (titles joined, never ids).

alter table td_pipelines add column if not exists hidden boolean not null default false;

-- warn_days overrides stall_rules.stuck_days (amber), stuck_days overrides
-- stall_rules.critical_days (red), ball_with overrides stall_rules.ball_with
-- ('none' means excluded); null means use the stall_rules default.
alter table stage_type_map add column if not exists warn_days integer;
alter table stage_type_map add column if not exists stuck_days integer;
alter table stage_type_map add column if not exists ball_with text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stage_type_map_ball_with_check') then
    alter table stage_type_map add constraint stage_type_map_ball_with_check
      check (ball_with is null or ball_with in ('firm', 'client', 'government', 'none'));
  end if;
end $$;

-- The government-wait stage type: long clock, the ball sits with the agency
-- (the seeded map rows override ball_with to 'government' per stage).
insert into stall_rules (stage_type, stuck_days, critical_days, ball_with)
values ('government_wait', 30, 60, 'client')
on conflict (stage_type) do nothing;

-- Seed the hidden flag for the pipelines that never carry client work. The
-- guard means a re-run never undoes a later unhide by Russell: once any
-- pipeline is hidden, this seed does nothing again.
update td_pipelines set hidden = true
where title in (
    'DO NOT USE',
    'Internal Tasks',
    'Misc - No stages',
    'Taxdome Backup Records',
    'Video Production - Tax Bites',
    '1040 Tax Return Pipeline (from webinar)',
    '1040 Tax Return Pipeline (from webinar) (2)',
    '1040 Tax Return Pipeline (from webinar) (4)',
    'EN (UK) - Payroll Processing'
  )
  and not exists (select 1 from td_pipelines where hidden);

-- Draft stage map from the 2026-10-23 stages export (117 of its 195 stages
-- classify; the rest stay unmapped). Joined on titles — some carry an en dash,
-- a leading/trailing space or a double space, all preserved byte for byte and
-- single quotes escaped by doubling — so nothing depends on TaxDome ids;
-- on conflict keeps any row Russell has since edited.
insert into stage_type_map (pipeline_id, stage_id, stage_type, warn_days, stuck_days, ball_with)
select p.id, s.id, v.stage_type, v.warn_days, v.stuck_days, v.ball_with
from (values
  ('1040 Tax Return Pipeline (from webinar)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'Prep post missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Prep post missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', '1st review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Prepare 1099s', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Review 1099s', 'review', 5, 10, 'firm'),
  ('1099 Preparation', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Review and Send Invoice', 'review', 5, 10, 'firm'),
  ('1120 – Corporate Income Tax Return', 'Organizer Sent / Contract Signed', 'documents', 14, 30, 'client'),
  ('1120 – Corporate Income Tax Return', 'In Prep', 'preparation', 7, 14, 'firm'),
  ('1120 – Corporate Income Tax Return', 'In Review', 'review', 5, 10, 'firm'),
  ('After the Fact Payroll Preparation', 'Prepare Payroll Tax Returns in Accountant''s Office', 'preparation', 7, 14, 'firm'),
  ('After the Fact Payroll Preparation', 'Review Prepared Payroll Returns', 'review', 5, 10, 'firm'),
  ('After the Fact Payroll Preparation', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('After the Fact Payroll Preparation', 'Review and send invoice', 'review', 5, 10, 'firm'),
  ('Bi-Weekly Payroll', 'Draft & Review Invoice ', 'review', 5, 10, 'firm'),
  ('Cash Flow Management', 'Review All Cash Flow Reports - 1', 'review', 5, 10, 'firm'),
  ('EN (UK) - Payroll Processing', 'Prepare Payroll', 'preparation', 7, 14, 'firm'),
  ('Easy Task Tax Prep', 'Prepare', 'preparation', 7, 14, 'firm'),
  ('Easy Task Tax Prep', 'Review', 'review', 5, 10, 'firm'),
  ('Easy Task Tax Prep', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Easy Task Tax Prep', 'Efile', 'filing', 3, 7, 'firm'),
  ('Easy Task Tax Prep', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '1st Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '1st Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '2nd Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '2nd Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '3rd Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '3rd Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '4th Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '4th Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Internal Tasks', 'Assign Task', 'intake', 3, 7, 'firm'),
  ('Misc - No stages', 'To Do', 'intake', 3, 7, 'firm'),
  ('Monthly Accounting', 'Prepare monthly bookkeeping', 'preparation', 7, 14, 'firm'),
  ('Monthly Accounting', 'Initial review', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'XiXi Review', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Review bookkeeping and prepare reports to send to client', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Archive once complete', 'delivery', 3, 7, 'firm'),
  ('Monthly Bookkeeping', 'Review Documents', 'review', 5, 10, 'firm'),
  ('Monthly Bookkeeping', 'Prepare the Draft Reports', 'preparation', 7, 14, 'firm'),
  ('Monthly Bookkeeping', 'Review Draft Reports', 'review', 5, 10, 'firm'),
  ('Monthly Bookkeeping', 'Client Review', 'review', 5, 10, 'firm'),
  ('Notice Response', 'Prepare Response', 'preparation', 7, 14, 'firm'),
  ('Notice Response', 'Review Response', 'review', 5, 10, 'firm'),
  ('Notice Response', 'Waiting for Government Response', 'government_wait', 30, 60, 'government'),
  ('Notice Response REVAMPED', 'Prepare Response', 'preparation', 7, 14, 'firm'),
  ('Notice Response REVAMPED', 'Review Response', 'review', 5, 10, 'firm'),
  ('Notice Response REVAMPED', ' Signer Review', 'review', 5, 10, 'firm'),
  ('Notice Response REVAMPED', 'Waiting for Government Response', 'government_wait', 30, 60, 'government'),
  ('Quarterly Tax Estimate', 'Prepare estimate', 'preparation', 7, 14, 'firm'),
  ('Quarterly Tax Estimate', 'Review estimate', 'review', 5, 10, 'firm'),
  ('Reasonable Comp Worksheet', 'Prepare ', 'preparation', 7, 14, 'firm'),
  ('Reasonable Comp Worksheet', 'Review ', 'review', 5, 10, 'firm'),
  ('Reasonable Comp Worksheet', 'Review Invoice ', 'review', 5, 10, 'firm'),
  ('Sales Tax', 'Prepare sales tax returns', 'preparation', 7, 14, 'firm'),
  ('Sales Tax', 'XiXi Review ', 'review', 5, 10, 'firm'),
  ('Sales Tax', 'Efile and Process', 'filing', 3, 7, 'firm'),
  ('Sales Tax', 'Archive once complete', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation', 'Send out organizer from Lacerte', 'documents', 14, 30, 'client'),
  ('Tax Preparation', 'Prepare Return', 'preparation', 7, 14, 'firm'),
  ('Tax Preparation', 'Perform Admin Review', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Review Return', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Missing Information and Open Questions', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation', 'Update for Missing Information In', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation', 'Review Updated Return - Is it ready for signature?', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation', 'Efile Return (Jennifer)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation', 'Efile Return (Jude)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation', 'Process Return for Client Delivery', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation', 'Processed Return Review - XixI', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Send out organizer from Lacerte', 'documents', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Prepare Return', 'preparation', 7, 14, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Perform Admin Review', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Review Return', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Missing Information and Open Questions', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Update for Missing Information In', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Review Updated Return - Is it ready for signature?', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Efile Return (Jennifer)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Efile Return (Jude)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Process Return for Client Delivery', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Review Processed Return - XiXi', 'review', 5, 10, 'firm'),
  ('Taxdome Backup Records', 'Prep', 'preparation', 7, 14, 'firm'),
  ('Taxdome Backup Records', 'Logged & complete', 'delivery', 3, 7, 'firm'),
  ('Video Production - Tax Bites', 'Review Script', 'review', 5, 10, 'firm'),
  ('Video Production - Tax Bites', 'Send Video for Review', 'review', 5, 10, 'firm'),
  ('WC Audit', 'Prep Audit ', 'preparation', 7, 14, 'firm'),
  ('WC Audit', 'Review Audit', 'review', 5, 10, 'firm'),
  ('WC Audit', 'FINAL Review', 'review', 5, 10, 'firm'),
  ('WC Audit', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('WC Audit', 'Review and send invoice', 'review', 5, 10, 'firm')
) as v(pipeline_title, stage_title, stage_type, warn_days, stuck_days, ball_with)
join td_pipelines p on p.title = v.pipeline_title
join td_pipeline_stages s on s.pipeline_id = p.id and s.title = v.stage_title
on conflict do nothing;

-- ── Accountability chart (2026-10-31) ─────────────────────────────────────
-- Also shipped as db/upgrades/2026-10-31-accountability.sql. Firm-wide EOS
-- accountability chart: exactly one current version, any number of proposals;
-- seats form a strict tree (one parent, one root per chart). People on a seat
-- live in accountability_seat_people with the dual id-plus-text convention
-- (person_id nullable, person text kept equal to people.name by the app), so
-- a seat can be open, held or shared.

create table if not exists accountability_charts (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Accountability Chart',
  status      text not null default 'proposal' check (status in ('current', 'proposal')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Exactly one current chart at a time
create unique index if not exists accountability_charts_one_current
  on accountability_charts(status) where status = 'current';

create table if not exists accountability_seats (
  id          uuid primary key default gen_random_uuid(),
  chart_id    uuid not null references accountability_charts(id) on delete cascade,
  parent_id   uuid references accountability_seats(id) on delete cascade,
  title       text not null check (btrim(title) <> ''),
  roles       text[] not null default '{}'
              check (coalesce(array_length(roles, 1), 0) <= 5),
  notes       text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists accountability_seats_chart_idx on accountability_seats(chart_id);
create index if not exists accountability_seats_parent_idx on accountability_seats(parent_id);
-- Exactly one root seat per chart (one line: db-setup.mjs splits on ";" + newline)
create unique index if not exists accountability_seats_one_root on accountability_seats(chart_id) where parent_id is null;

-- Zero or more people per seat: zero renders "Open seat", two or more shows a
-- shared marker. person text keeps working when the person has no account.
create table if not exists accountability_seat_people (
  id          uuid primary key default gen_random_uuid(),
  seat_id     uuid not null references accountability_seats(id) on delete cascade,
  person_id   uuid references people(id) on delete set null,
  person      text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists accountability_seat_people_seat_idx on accountability_seat_people(seat_id);
