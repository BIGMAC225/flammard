-- Accountability extra-parent links: a seat keeps exactly one primary parent
-- (accountability_seats.parent_id, the tree stays, one root per chart) and may
-- report to any number of extra parents here — the pooled-staff case (Tax
-- Staff 1 under both Tax-Jude and Tax-Jen). Cycles are prevented in the app
-- (validateReparent walks primary and extra edges), not in SQL.
-- Paste into the Neon SQL Editor and run, or `node work/db-upgrade-links.mjs`.
-- Additive and safe to run more than once.

create table if not exists accountability_seat_links (
  id          uuid primary key default gen_random_uuid(),
  seat_id     uuid not null references accountability_seats(id) on delete cascade,
  parent_id   uuid not null references accountability_seats(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (seat_id, parent_id),
  check (seat_id <> parent_id)
);
create index if not exists accountability_seat_links_seat_idx on accountability_seat_links(seat_id);
create index if not exists accountability_seat_links_parent_idx on accountability_seat_links(parent_id);
