-- Accountability chart (EOS): firm-wide chart versions (exactly one current,
-- any number of proposals) and the seats that form one strict tree per chart.
-- People on a seat live in accountability_seat_people, following the dual
-- id-plus-text owner convention (person_id nullable, person text kept equal to
-- people.name by the app), so a seat can be open, held or shared.
-- Paste into the Neon SQL Editor and run, or `npm run db:setup` (the same
-- block is in db/schema.sql). Additive and safe to run more than once.

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
