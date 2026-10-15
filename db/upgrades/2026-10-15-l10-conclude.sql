-- L10 Conclude: per-attendee meeting ratings and cascading messages.
-- Paste into the Neon SQL Editor and run, or `npm run db:setup` (the same
-- block is in db/schema.sql). Additive and safe to run more than once.

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

-- Which meeting carried a rock review / closed a to-do or issue
create index if not exists meeting_rocks_rock_idx       on meeting_rocks(rock_id) where rock_id is not null;
create index if not exists todos_resolved_meeting_idx   on todos(resolved_meeting_id) where resolved_meeting_id is not null;
create index if not exists issues_resolved_meeting_idx  on issues(resolved_in_meeting_id) where resolved_in_meeting_id is not null;
