-- Fulfillment (TaxDome pipelines): import-run bookkeeping, TaxDome reference
-- data (pipelines, stages, job statuses, people, clients), daily job
-- snapshots, stage intervals, job events, stall rules, the stage-type map and
-- the alerts log.
-- Paste into the Neon SQL Editor and run, or `npm run db:setup` (the same
-- block is in db/schema.sql). Additive and safe to run more than once.
--
-- From the implementation plan: td_pipeline_stages.stage_order stores the API
-- field "order" (a reserved word in SQL), and td_people is keyed by
-- (actor_type, id) because owner and employee ids can overlap.

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
