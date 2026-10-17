-- L10 rules: linked issues (from a rock or a headline), issue types, the
-- meeting's top-three picks, rock quarter-end outcome, to-dos linked to an
-- issue, and the minutes "actions" folded into the to-do list.
-- Paste into the Neon SQL Editor and run, or `npm run db:setup` (the same
-- block is in db/schema.sql). Additive and safe to run more than once.

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
