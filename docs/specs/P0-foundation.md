# P0 spec: people, sign-in, owners, company settings and the Ninety importer

Status: draft for approval. Written 2026-09-26 against `master` at 35c2747 plus the working tree.
Inputs:
- `docs/success-co-parity.md`: section 0 has the decisions and section 20 the phase plan.
- `success-research/05-ninety-export-formats.md`: the real Ninety export layouts.
- The current code.

Nothing in this document has been built yet.

---

## 1. Summary and non-goals

### Summary

P0 turns Flammard from a single shared-password app into one where everyone has an account. It also brings the firm's open Ninety data across. Five pieces make up the phase:

1. **People and individual logins.** P0 adds a `people` table and six roles: owner, admin, facilitator, manager, member and observer. Each person signs in with an email and a password, stored as a scrypt hash. An admin creates a person and gets a one-time setup link to send them by hand, through Teams, a text or in person. The same mechanism handles password resets. The session cookie identifies the person. The shared password keeps working behind an env toggle until everyone has signed in.
2. **People admin and My account pages.**
3. **Owner pickers.** P0 adds a nullable `owner_id` next to every free-text owner column and adds an owner to issues. A migration matches existing owner text to people. One `OwnerPicker` component replaces the owner text inputs. The text column stays in sync with the person's name, so existing read code, the PDF and the AI prompts keep working unchanged.
4. **Company settings.** A single-row table and a page hold:
   - first day of week
   - timezone
   - the four quarter start dates
   - how fiscal years are named
   - the Zapier recap webhook URL and secret, which are stored now and used in P2
5. **Ninety importer.** You upload the XLSX exports and the browser parses them with JSZip. Only open items are imported; completed and archived rows are skipped. A preview groups rows by type with checkboxes and maps Ninety owner names to people, or keeps a name as text with no account, as for a consultant. The commit runs as one transaction. Ninety ids are used for dedupe, and each import is recorded as a batch that can be undone.

### Non-goals (deferred)

- Azure/Entra, magic links and any email sending. Links are copied and sent by hand.
- Any number of teams, or team types. Leadership and Management stay hard-coded (`src/lib/teams.ts`).
- Row-level team privacy on `/api/.../[id]` routes. In P0 the team scope is enforced on the team switcher and the "current team" only. See open question Q1.
- Using the settings timezone and week start in existing screens. P0 stores them, and the importer uses the timezone. `todayLocal()` keeps reading `PUBLIC_TIMEZONE` until P1.
- Due-date, priority and description UI for to-dos beyond what the importer writes. The columns land now and the UI comes in P1. Milestone owners and dates on steps are the same: stored now, shown in P1.
- A Headlines page. Imported headlines with no meeting stay invisible until P1 (see Q6).
- Owner pickers inside the minutes JSON (`minutes.actions[].owner`) and inside `AnalysisReview`. Those stay free text. The server resolves AI-proposed owner names to people when the analysis is committed.
- Avatars, per-person timezone, bulk CSV user import, 2FA and audit log. These are P1 and P3.

---

## 2. Data model

### 2.1 Principles

- Every statement is idempotent and additive: `create … if not exists`, `add column if not exists`, `create or replace view`, `insert … on conflict do nothing`. There are no `DO` blocks and no functions. `scripts/db-setup.mjs` splits on `;\n`, so every statement ends with `;` at the end of a line, and no statement contains `;` followed by a newline internally.
- The deployed (pre-P0) code must keep working after the SQL runs. Every new column is nullable or has a default. Old inserts that don't name the new columns still succeed. The only behavioural caveat concerns headlines: `headlines.team` defaults to `leadership`. Old code that inserts a headline for a Management meeting in the window between running the SQL and merging would get `leadership`. The upgrade file includes a fix-up `update`, so running it again after the merge corrects those rows (see §7).
- The same block is appended to `db/schema.sql`, under a `-- ── P0 ──` banner after the existing "Upgrades" section and before "Indexes", and it is saved as `db/upgrades/p0-foundation.sql`.
- Two more one-time files are **not** added to `schema.sql`:
  - `db/upgrades/p0-seed-people.sql` (§2.3) seeds the firm's people.
  - `db/upgrades/p0-backfill-owners.sql` (§2.4) links existing owner text to them. It is also available as a button on the People page.
- Run order in Neon: foundation, then seed, then backfill.

### 2.2 `db/upgrades/p0-foundation.sql` (exact)

```sql
-- Flammard P0 upgrade: people, sign-in tokens, company settings, owner ids,
-- to-do fields, rock level, Ninety import bookkeeping.
-- Paste into the Neon SQL Editor and run. Safe to run more than once.

create extension if not exists pgcrypto;

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
```

### 2.3 `db/upgrades/p0-seed-people.sql` (one-time seed, user decisions 2026-09-26)

The seed creates the firm's people **with their work emails and without passwords**. The owner backfill can then link existing items straight away, and an admin only has to create each person's setup link.

The email domain is **not confirmed**:
- The user said "JHCPA".
- The firm's website is `jheathcpa.com`.
- Git history shows `russell@jheathcpa.local`.

It is therefore set in **one clearly marked place** at the top of the seed statement, defaulting to `jheathcpa.com`. Edit that one line before running if the domain differs (Q13). The same statement stores it as `company_settings.email_domain`, but only if that setting is empty, and that value pre-fills the email field when people are added later.

Jeff Arnol is a consultant. He gets no account and is deliberately left out.

| Person | Email (local part) | Teams | Role | Aliases |
|---|---|---|---|---|
| Russell Heath | `russell@` | leadership, management | owner | |
| Jude Heath | `judej@` | leadership | admin (suggested, to be confirmed: Q12) | |
| Jennifer Louise | `jennifer@` | leadership | admin (suggested, to be confirmed: Q12) | |
| Xixi | `xihong.ma@` | management | member | Shishi |
| Kayla | `kayla@` | management | member | |
| Nicole | `nicole@` | management | member | |

```sql
-- One-time seed of J Heath & Co people (emails, roles, teams; no passwords).
-- Safe to run more than once: a person whose name or email already exists is skipped.
--
-- >>> EMAIL DOMAIN: edit 'jheathcpa.com' on the next line if the firm's address domain differs <<<
with cfg as (select lower('jheathcpa.com')::text as domain),
set_domain as (
  update company_settings s set email_domain = cfg.domain, updated_at = now()
  from cfg where s.id and s.email_domain is null
  returning s.id
)
insert into people (name, email, role, teams, aliases)
select v.name, v.local || '@' || cfg.domain, v.role, v.teams, v.aliases
from cfg
cross join (values
  ('Russell Heath',   'russell',    'owner',  array['leadership', 'management']::text[], array[]::text[]),
  ('Jude Heath',      'judej',      'admin',  array['leadership']::text[],               array[]::text[]),
  ('Jennifer Louise', 'jennifer',   'admin',  array['leadership']::text[],               array[]::text[]),
  ('Xixi',            'xihong.ma',  'member', array['management']::text[],               array['Shishi']::text[]),
  ('Kayla',           'kayla',      'member', array['management']::text[],               array[]::text[]),
  ('Nicole',          'nicole',     'member', array['management']::text[],               array[]::text[])
) as v(name, local, role, teams, aliases)
where not exists (
  select 1 from people p
  where lower(btrim(p.name)) = lower(v.name) or p.email = v.local || '@' || cfg.domain
);
```

This is a single statement: a data-modifying CTE always runs, even though nothing references it. The domain therefore appears once, and the file passes the `;
` splitter.

How the seeded names match:
- **Full names:** "Russell Heath", "Jude Heath" and "Jennifer Louise" match in full.
- **First names:** "Russell", "Jude" and "Jennifer" are unique first names, so they match too.
- **Single names and aliases:** "Xixi", "Shishi", "Kayla" and "Nicole" match.
- **Jeff Arnol:** his items keep the text "Jeff Arnol" with no `owner_id`.

The seed means an owner row, Russell with his email, exists before anyone can sign in. The bootstrap in §3.7 therefore *claims* that row instead of creating a new one.

### 2.4 `db/upgrades/p0-backfill-owners.sql` (the owner-matching migration)

Run this after the seed, either by pasting it or from People → "Match owner names", which runs the same statements through `POST /api/people/backfill-owners`. It fills `owner_id` only where it is null and the text matches a key. It also rewrites the matched text to the person's canonical name, which keeps the text in sync. Unmatched text is left alone. The file is idempotent.

```sql
-- Match existing free-text owners to people (case-insensitive full name,
-- alias, or unique first name). Unmatched text is left as it is.
update rocks x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update todos x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update meeting_rocks x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update scorecard_metrics x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update issues x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update steps x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update headlines x set presenter_id = k.person_id, presenter = k.name
from person_name_keys k
where x.presenter_id is null and x.presenter is not null and lower(btrim(x.presenter)) = k.key;

-- What is still unmatched (read-only report)
select 'rocks' as tbl, owner as text, count(*) from rocks where owner_id is null and owner is not null group by owner
union all select 'todos', owner, count(*) from todos where owner_id is null and owner is not null group by owner
union all select 'meeting_rocks', owner, count(*) from meeting_rocks where owner_id is null and owner is not null group by owner
union all select 'scorecard_metrics', owner, count(*) from scorecard_metrics where owner_id is null and owner is not null group by owner
union all select 'issues', owner, count(*) from issues where owner_id is null and owner is not null group by owner
union all select 'headlines', presenter, count(*) from headlines where presenter_id is null and presenter is not null group by presenter
order by 2;
```

The People page then offers "Unmatched owner names": each distinct unmatched text with its count, a person dropdown, and a "remember as alias" tick. Applying it runs the same updates scoped to that text, `lower(btrim(owner)) = $text`, and, when ticked, appends the text to `people.aliases`.

Unmatched text that is meant to stay text, such as "Jeff Arnol" for a consultant with no account, simply stays in the list. The panel labels it "kept as text" once an admin chooses "Leave as text (no account)". That choice is remembered in `company_settings.text_only_owner_names` (see below), and those names drop to a collapsed "Kept as text" section.

The column is already in the §2.2 file.

### 2.5 Keeping the text in sync

This is done in application code, not triggers, because triggers need function bodies, which the `;\n` splitter can't carry.

- On every write that sets an owner, `resolveOwner()` (§3.8) returns `{ owner_id, owner }`. When an id is given, `owner` is the person's current `name`.
- When an admin renames a person, the same transaction runs `update <t> set owner = $name where owner_id = $id` for rocks, todos, meeting_rocks, scorecard_metrics, issues and steps, and `update headlines set presenter = $name where presenter_id = $id`. That is `syncOwnerNameQueries(id, name)` in `src/lib/people.ts`.
- Deactivating a person leaves their items and names as they are. Pickers show inactive owners as "Name (inactive)" on existing items but don't offer them for new ones.

### 2.6 TypeScript types (added to `src/types.ts`)

```ts
export type Role = 'owner' | 'admin' | 'facilitator' | 'manager' | 'member' | 'observer';
export interface Person {
  id: string; name: string; email: string | null; title: string | null; role: Role;
  teams: TeamId[]; aliases: string[]; active: boolean; has_password: boolean;
  last_login_at: string | null; created_at: string; updated_at: string;
}
export interface PersonOption { id: string; name: string; teams: TeamId[]; active: boolean } // for pickers
export interface CompanySettings {
  company_name: string; week_start: number; timezone: string;
  q1_start: string; q2_start: string; q3_start: string; q4_start: string;
  fiscal_year_named_by: 'start' | 'end'; email_domain: string | null;
  recap_webhook_url: string | null; recap_webhook_secret_set: boolean; // secret never sent to the browser
  updated_at: string;
}
export interface ImportBatch {
  id: string; source: 'ninety'; file_names: string[]; counts: Record<string, number>;
  status: 'committed' | 'undone'; created_by_name: string | null; created_at: string; undone_at: string | null;
}
// Rock, Todo, Issue, MeetingRock, ScorecardMetric gain owner_id: string | null;
// Headline gains presenter_id, team, description; Issue gains owner, solved_at;
// Todo gains due_date, description, completed_at; Rock gains level, completed_at.
```

---

## 3. Auth and roles design

### 3.1 Principal

Middleware resolves every `/dashboard/*` and non-public `/api/*` request to a **principal** and puts it on `Astro.locals.principal`. The type is declared in a new `src/env.d.ts`.

```ts
type Principal =
  | { kind: 'person'; id: string; name: string; email: string; role: Role; teams: TeamId[] }
  | { kind: 'shared'; id: null; name: string /* TEAM_LABEL */; role: Role /* SHARED_LOGIN_ROLE */; teams: TeamId[] /* both */ };
```

### 3.2 Session cookie

The cookie name stays `flammard_session`, HttpOnly, `SameSite=Lax`, `Secure` in production, with a 30-day absolute expiry. Two signed formats are accepted:

| Format | Value | When |
|---|---|---|
| Person | `p1.<personId>.<sessionVersion>.<expiresMs>.<hmac>` | email + password sign-in, setup link |
| Shared (legacy) | `<expiresMs>.<hmac>` (exactly today's format) | shared-password sign-in, only while `SHARED_PASSWORD_LOGIN` is not `off` |

- The HMAC is SHA-256 keyed by `SESSION_SECRET`. P0 requires `SESSION_SECRET` for person sessions. The fallback to `SHARED_PASSWORD` stays only for shared cookies, so current sessions survive until `SESSION_SECRET` is set. After that everyone signs in once more.
- Person sessions cost one query per request: `select … from people where id = $1 and active`. The session is valid only if `session_version` matches. Bumping `session_version` signs a person out everywhere, which happens on:
  - a password change
  - using a reset link
  - deactivation
  - a role or teams change
- `isAuthenticated(cookies)` keeps its signature and checks only the signature and expiry of either format. That way the 30+ routes that call `requireAuth(cookies)` compile unchanged. The real gate is the middleware (§3.6).

### 3.3 Password hashing

- `scrypt` from `node:crypto`. N = 2^15, r = 8, p = 1, 16-byte random salt, 64-byte key, `maxmem` = 64 MiB. That is roughly 50–100 ms on a Netlify function.
- Stored as `scrypt$15$8$1$<salt b64url>$<key b64url>`, so the parameters can be raised later. On a successful sign-in with outdated parameters, the password is rehashed.
- Verification uses `timingSafeEqual`. When the email is unknown or the person has no password, the check runs against a fixed dummy hash so timing doesn't reveal which emails exist. The error message is always "Email or password is incorrect".
- Policy: 12 to 200 characters, no composition rules, not equal to the email, and rejected if it is in a short built-in list of very common passwords.

### 3.4 Setup and reset links (token lifecycle)

1. An admin clicks "Create setup link", or "Create reset link" when the person already has a password. The server generates 32 random bytes and encodes them as base64url for the token. It stores `sha256(token)` in `person_tokens` with a purpose and an expiry: **7 days for setup, 24 hours for reset**. It also marks every earlier unused token for that person as used, so only the newest link works. The person must have an email and be active.
2. The response returns `{ url: "<origin>/setup/<token>", expires_at }` once. The UI shows it with a Copy button and the text "Send this to <name>. It works once and expires <date>." The token is never shown again and never logged.
3. `/setup/[token]` is a public page. It is served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The page shows the person's name and email only if the token is valid, unexpired and unused. Otherwise it says "This link has expired or was already used. Ask an admin for a new one."
4. On submit, `POST /api/auth/setup { token, password }` runs in one transaction:
   - validates the token and the password policy
   - sets `password_hash` and `password_updated_at`
   - bumps `session_version`
   - sets `used_at`
   - sets `last_login_at`

   The server then issues a person cookie.
5. The setup endpoint shares the per-IP throttle with login.
6. Expired and used rows are harmless. `POST /api/people/[id]/link` deletes that person's rows older than 30 days, which keeps the table small without a cron.

### 3.5 Roles and permission matrix

Permissions are named strings checked by `can(principal, permission)` in `src/lib/permissions.ts`. Roles map to permissions as follows.

| Permission | What it covers | owner | admin | facilitator | manager | member | observer |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `app.view` | all dashboard pages and GET APIs for their teams | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.self` | My account, change own password (persons only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `items.edit` | create, edit and delete rocks, to-dos, issues, headlines, steps and scorecard entries; reorder issues | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `meetings.run` | create meetings, record, upload a transcript, analyze, commit an analysis, save minutes | ✓ | ✓ | ✓ | ✓ | — | — |
| `minutes.approve` | approve and seal minutes | ✓ | ✓ | ✓ | ✓ | — | — |
| `structure.manage` | scorecard metric definitions, periods, roadmap import and commit | ✓ | ✓ | ✓ | ✓ | — | — |
| `teams.all` | see and switch to every team whatever their membership | ✓ | ✓ | ✓ | — | — | — |
| `people.manage` | People page: add and edit people with role facilitator and below, links, deactivate, owner matching | ✓ | ✓ | — | — | — | — |
| `people.grant_admin` | give, change or remove the owner or admin role; edit or deactivate owners and admins | ✓ | — | — | — | — | — |
| `settings.manage` | company settings | ✓ | ✓ | — | — | — | — |
| `import.manage` | Ninety import, undo import | ✓ | ✓ | — | — | — | — |

**Delete rights stay as they are today** (user decision 2026-09-26). Anyone who can edit an item can delete it, so `items.edit`, `meetings.run` and `structure.manage` each include delete for their objects. Observers stay read-only.

**Invariants**, enforced in the people handlers:
- There is always at least one active owner. The last owner can't be demoted or deactivated.
- Nobody can deactivate themselves or change their own role.
- An admin can't create, edit, link or deactivate an owner or admin.

**Shared principal:** role = `SHARED_LOGIN_ROLE` (default `facilitator`), so the app works during rollout as it does today. A shared principal never has `people.*`, `settings.manage`, `import.manage` or `account.self`, whatever the role is set to. The only exception is first-owner bootstrap (§3.7).

**Team scope in P0:**
- `allowedTeams(principal)` returns both teams if the principal has `teams.all`, and otherwise `person.teams`.
- If a person has no teams, the list falls back to `['leadership']` and the People page shows a warning.
- The middleware checks the team cookie on every request. If the cookie names a team the person isn't allowed, it is reset to their first allowed team.
- `/api/team` refuses a disallowed team.
- The header switcher shows only the allowed teams.
- Row-level checks on `/api/.../[id]` are out of scope (Q1).

### 3.6 Enforcement

Enforcement happens in one place: `src/middleware.ts` plus the route-rule table in `permissions.ts`. That way P0 doesn't have to edit every existing route.

1. **Public paths** skip everything:
   - `/`, `/login`
   - `/setup/*`
   - `/api/auth/login`, `/api/auth/setup`, `/api/auth/logout`
   - `/api/integrations/*`, which has its own Bearer secret
   - static assets
2. **Session.** Otherwise, for `/dashboard/*` and `/api/*`, the middleware resolves the principal. With no principal, `/dashboard` redirects to `/login?next=…` and `/api` returns a 401 JSON response.
3. **Cross-site check.** Non-GET `/api` requests whose `Origin` header is present and differs from the site origin get a 403. `SameSite=Lax` already covers most of this; the check is defence in depth.
4. **Route rules.** `checkRoute(method, pathname, principal)` matches the first rule; on a miss it returns a 403 JSON response, or a 403 page for `/dashboard`. The rules, in order:

| Method | Path pattern | Permission |
|---|---|---|
| any | `/api/people/options` | `app.view` |
| POST | `/api/people/bootstrap` | special: shared principal and the bootstrap condition holds (§3.7) |
| any | `/api/people`, `/api/people/**` | `people.manage` (+ handler invariants) |
| any | `/api/me/**` | `account.self` |
| GET | `/api/settings` | `app.view` |
| PATCH | `/api/settings` | `settings.manage` |
| any | `/api/import/**` | `import.manage` |
| POST | `/api/meetings/*/approve` | `minutes.approve` |
| non-GET | `/api/meetings/create`, `/api/meetings/*/{recording,recording/chunk,transcript,analyze,commit-analysis,save}` | `meetings.run` |
| non-GET | `/api/scorecard/metrics`, `/api/scorecard/metrics/*`, `/api/periods`, `/api/periods/*`, `/api/roadmap/**` | `structure.manage` |
| GET | `/api/team` | `app.view` (team checked in handler) |
| non-GET | any other `/api/**` | `items.edit` |
| GET | any other `/api/**` | `app.view` |
| GET | `/dashboard/people` | `people.manage` (bootstrap view for a shared principal while the bootstrap condition holds) |
| GET | `/dashboard/settings` | `settings.manage` |
| GET | `/dashboard/import` | `import.manage` |
| GET | `/dashboard/account` | `account.self` |
| GET | any other `/dashboard/**` | `app.view` |

5. **Team cookie.** The middleware then applies the team-cookie coercion from §3.5.

Handlers that need finer checks call `requirePermission(locals, perm)` from `src/lib/api.ts`. Examples are the people invariants and `people.grant_admin`. UI islands receive a `can` map computed server-side, for example `{ approve: true, manageStructure: false }`, and hide controls the person can't use. The server check is the one that counts.

**Record the actor.** `approvals.approved_by` becomes `principal.name` instead of `TEAM_LABEL`. For a shared principal that name is `TEAM_LABEL`, so nothing changes for it. The batch table records `created_by`.

### 3.7 First-owner bootstrap

**The bootstrap condition.** Bootstrap is open while **no active owner has a password**, meaning nobody can sign in as an owner yet:

```sql
not exists (select 1 from people where role = 'owner' and active and password_hash is not null)
```

The seed (§2.3) creates Russell Heath as an owner without a password, so bootstrap *claims* that row. There are two paths; the second is for when the shared password is already off.

1. **In the app** (the normal path). The user signs in with the shared password.
   - While the bootstrap condition holds, the dashboard shows a banner: "Set up your owner account". The link goes to `/dashboard/people`, and for a shared principal that page renders only the bootstrap form:
     - **Claim a seeded owner.** A select lists the active owners without a password; after the seed that is just "Russell Heath". The email is pre-filled from the seed and can be corrected. You enter a password and confirm it.
     - **Create a new owner.** Used only if no owner rows exist (a fresh database without the seed): name, email, password and confirm.
   - `POST /api/people/bootstrap` sets the email and password hash on the chosen owner row, or inserts a new owner with both teams. It uses one conditional statement, `update … where id = $id and role = 'owner' and password_hash is null and <bootstrap condition>` or `insert … select … where <bootstrap condition>`, so two tabs bootstrapping at once can't both succeed.
   - The response replaces the shared cookie with a person cookie. From then on the endpoint returns 409.
2. **From a terminal** (fallback). `node scripts/create-owner.mjs --name "Russell Heath" --email <work email>`, run with `NETLIFY_DATABASE_URL` set.
   - It refuses if the bootstrap condition is false, unless `--force` is passed.
   - It reuses the seeded owner row with that name, case-insensitive, or inserts one. It sets the email when one is given and prints a 7-day setup link for the given `--origin`, which defaults to `https://flammard.netlify.app`.
   - It reuses the same token hashing (SHA-256) and needs no app code.

### 3.8 Shared library interfaces (owned by Task A)

```ts
// src/lib/password.ts
hashPassword(pw: string): Promise<string>
verifyPassword(pw: string, stored: string | null): Promise<{ ok: boolean; needsRehash: boolean }>
passwordProblem(pw: string, email?: string | null): string | null      // null = acceptable
newToken(): { token: string; hash: string }                            // hash = sha256 hex
hashToken(token: string): string

// src/lib/auth.ts (rewritten, keeps old exports)
SESSION_COOKIE; TEAM_LABEL
sharedLoginEnabled(): boolean               // SHARED_PASSWORD set && SHARED_PASSWORD_LOGIN !== 'off'
passwordMatches(candidate: string): boolean // shared password, unchanged
startPersonSession(cookies, p: { id: string; session_version: number }): void
startSharedSession(cookies): void           // = old startSession
startSession = startSharedSession           // alias for compatibility
endSession(cookies): void
readSession(cookies): { kind: 'person'; personId: string; version: number } | { kind: 'shared' } | null
isAuthenticated(cookies): boolean           // signature + expiry only

// src/lib/people.ts
OWNER_COLUMNS: Array<{ table: string; text: string; id: string }>     // 7 entries incl. headlines presenter, steps
loadPrincipal(cookies): Promise<Principal | null>
listPeopleOptions(includeInactive?: boolean): Promise<PersonOption[]>
resolveOwner(input: { owner_id?: unknown; owner?: unknown }, opts?: { match?: boolean }):
  Promise<{ owner_id: string | null; owner: string | null } | { error: string }>
  // owner_id (uuid of an active person) wins → owner = person.name.
  // Else owner text: if opts.match (default true) and it matches person_name_keys → id + canonical name;
  // else { owner_id: null, owner: trimmed text or null }. Unknown/inactive id → error.
resolveOwnerNames(names: string[]): Promise<Map<string /*lower key*/, { id: string; name: string }>> // batch, for AI commits
syncOwnerNameQueries(personId: string, name: string): NeonQueryPromise[]  // for a rename transaction
backfillOwnerQueries(): NeonQueryPromise[]                                 // the §2.4 updates
bootstrapOpen(): Promise<boolean>                                          // §3.7 condition

// src/lib/permissions.ts
ROLES; ROLE_LABELS; Permission; can(p: Principal, perm: Permission): boolean
allowedTeams(p: Principal): TeamId[]; canAccessTeam(p, team): boolean
checkRoute(method: string, pathname: string, p: Principal): { ok: true } | { ok: false; status: 403 }
canManagePerson(actor: Principal, target: { role: Role }, newRole?: Role): boolean

// src/lib/api.ts (additions; existing exports unchanged)
principal(locals: App.Locals): Principal            // throws if middleware didn't set it
requirePermission(locals: App.Locals, perm: Permission): Response | null

// src/lib/settings.ts
getSettings(): Promise<CompanySettings & { recap_webhook_secret: string | null }>  // server only
publicSettings(s): CompanySettings                                                   // strips secret
```

### 3.9 Rollout and fallback

| `SHARED_PASSWORD_LOGIN` | Login page | Existing shared cookies |
|---|---|---|
| unset or `on` (P0 default) | email + password form, plus a "Use the team password" link that reveals the old form | accepted, principal = shared |
| `off` | email + password only | rejected; the person is sent to `/login` |

- Per-IP throttling stays as it is in `login.ts`: 10 attempts per 15 minutes per IPv4 address or IPv6 /64, a delay on every miss, and a conditional write in the Blobs `auth` store. It moves into `src/lib/throttle.ts` so that setup can use it too.
- A second counter is added per email, keyed `login-attempts/email/<sha256(email)>`, with a limit of 10 per 15 minutes. It slows guessing against one account from many IPs.
- A successful sign-in clears the IP counter and the email counter.
- A forgotten password gets no email. The login page says: "Forgot your password? Ask an admin for a reset link."

---

## 4. API routes

All request and response bodies are JSON. Errors are `{ error: string }` with 400, 401, 403, 404 or 409. "Role" means the permission from §3.5.

### 4.1 Auth and account

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| POST | `/api/auth/login` (changed) | public | `{ email?, password, next? }`. With email: person sign-in. Without: shared sign-in (403 if disabled) | `{ next }` + cookie |
| POST | `/api/auth/logout` | public | (form post) | redirect `/login`, cookie cleared |
| GET | `/api/auth/setup?token=` | public | | `{ name, email, purpose, expires_at }` or 410 |
| POST | `/api/auth/setup` | public, throttled | `{ token, password }` | `{ next: '/dashboard' }` + person cookie |
| GET | `/api/me` | account.self | | `{ person: Person }` |
| POST | `/api/me/password` | account.self | `{ current_password, new_password }`, or `{ current_password, sign_out_only: true }` | `{ ok }`. Bumps session_version and reissues own cookie, which signs out every other device |

### 4.2 People (Task C)

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/api/people/options` | app.view | `?include_inactive=1` | `{ people: PersonOption[] }` (active first, by name) |
| GET | `/api/people` | people.manage | | `{ people: Person[] }` (no hashes) |
| POST | `/api/people` | people.manage | `{ name, email?, title?, role, teams, aliases? }` | `{ person }`. 409 on duplicate email; role owner/admin needs grant_admin |
| PATCH | `/api/people/[id]` | people.manage | any of `{ name, email, title, role, teams, aliases, active }` | `{ person }`. A rename syncs owner text; role, teams or active changes bump session_version; invariants §3.5 |
| POST | `/api/people/[id]/link` | people.manage | `{ purpose?: 'setup' \| 'reset' }` (default: setup if no password, else reset) | `{ url, expires_at, purpose }` (shown once) |
| GET | `/api/people/bootstrap` | shared + bootstrap open | | `{ claimable: Array<{ id, name }>, email_domain }` |
| POST | `/api/people/bootstrap` | shared + bootstrap open | `{ person_id?, name?, email, password }` (`person_id` claims a seeded owner; else `name` creates one) | `{ next: '/dashboard/people' }` + person cookie; 409 once an owner can sign in |
| GET | `/api/people/unmatched-owners` | people.manage | | `{ items: [{ text, counts: { rocks, todos, issues, … }, total }] }` |
| POST | `/api/people/match-owners` | people.manage | `{ text, person_id, add_alias?: boolean }` | `{ updated: number }` |
| POST | `/api/people/backfill-owners` | people.manage | | `{ updated: { rocks, todos, … } }` (runs §2.4) |
| POST | `/api/people/text-only-owners` | people.manage | `{ text, keep: boolean }` | `{ names: string[] }`. Adds or removes the name in `company_settings.text_only_owner_names` ("Leave as text, no account", e.g. Jeff Arnol) |

People are never hard-deleted through the API. Deactivation is `PATCH { active: false }`.

### 4.3 Settings (Task D)

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/api/settings` | app.view | | `{ settings: CompanySettings }` (no secret, `recap_webhook_secret_set`) |
| PATCH | `/api/settings` | settings.manage | any of `{ company_name, week_start, timezone, q1_start…q4_start, fiscal_year_named_by, email_domain, recap_webhook_url, recap_webhook_secret }`. Secret: string to set, `null` to clear, omitted to keep. `generate_secret: true` → server creates 32 random bytes hex | `{ settings, generated_secret? }` (generated secret shown once) |

Validation rules:
- The timezone must pass `Intl.DateTimeFormat`.
- Quarter starts must be valid month-days, the four must be distinct, and Q1 through Q4 must run in cyclic order each three months apart, give or take 7 days. If they don't, the response is a warning rather than an error.
- The URL must be https.

### 4.4 Owner-bearing routes (Task B)

Each of these routes changes the same way. It accepts `owner_id` (uuid or null) alongside or instead of `owner` (text). It calls `resolveOwner()` and writes both columns. Old clients that send only `owner` text still work, and their text is auto-matched to a person.

| Route | Change |
|---|---|
| `POST /api/rocks`, `PATCH /api/rocks/[id]` | owner_id; PATCH also accepts `level` (`company`/`individual`/null) |
| `POST /api/todos`, `PATCH /api/todos/[id]` | owner_id; also `due_date` (ISO or null) and `description`. Setting status `done` sets `completed_at = now()`, any other status clears it |
| `POST /api/issues`, `POST /api/meetings/[id]/issues` (via `insertIssue`), `PATCH /api/issues/[id]` | new `owner`/`owner_id`; status `solved` sets `solved_at`, reopening clears it |
| `POST /api/meetings/[id]/rocks` | owner_id on both the master rock and the snapshot |
| `PATCH /api/meeting-rocks/[id]` | also accepts owner_id/owner (status no longer required if owner sent) |
| `POST /api/meetings/[id]/todos` | owner_id |
| `POST /api/meetings/[id]/headlines` | `presenter_id`; sets `team` from the meeting |
| `POST /api/scorecard/metrics`, `PATCH /api/scorecard/metrics/[id]` | owner_id |
| `POST /api/meetings/[id]/commit-analysis` | AI owner and presenter names go through `resolveOwnerNames` (one query), so ids are set when a name matches; headlines get `team` |
| `POST /api/roadmap/commit` | rock owner names resolved the same way |
| `POST /api/meetings/[id]/approve` | `approved_by` = principal name |

Every response returns the row including `owner_id`.

### 4.5 Import (Task D)

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| POST | `/api/import/ninety/preview` | import.manage | `{ rows: NinetyRow[] }` (parsed in browser, ≤ 3,000 rows, ≤ 4 MB) | `{ existing: string[] /* external ids already in DB */, owners: Record<ninetyName, { person_id, name } \| null>, periods: Array<{ id, team, name, start_date, end_date }>, rocksByTitle: Record<team, Array<{ id, title }>>, settings: CompanySettings }` |
| POST | `/api/import/ninety/commit` | import.manage | `CommitRequest` (§6.6) | `{ batch_id, counts }` |
| GET | `/api/import/batches` | import.manage | | `{ batches: ImportBatch[] }` (latest 50) |
| POST | `/api/import/batches/[id]/undo` | import.manage | `{ confirm: true }` | `{ counts }`; 409 if already undone |
| GET | `/api/import/batches/[id]` | import.manage | | `{ batch, edited_since: number }` (rows with `updated_at > batch.created_at`, shown as a warning before undo) |

---

## 5. Pages and components

### 5.1 Pages

| Page | Who | Contents |
|---|---|---|
| `/login` (changed, C) | public | An email and password form. "Use the team password" toggle when shared login is on. "Ask an admin for a reset link" |
| `/setup/[token]` (new, C) | public | "Hi <name>, choose a password" with password and confirm fields, the policy hint, then submit and go to the dashboard. Invalid or expired state. No-referrer, no-store |
| `/dashboard/people` (new, C) | people.manage; the bootstrap form (§3.7) for a shared principal while bootstrap is open | Three parts: a People table, a Link panel and an Unmatched-owners panel (details below) |
| `/dashboard/account` (new, C) | account.self | Name, email, role and teams (read-only). A change-password form with current, new and confirm fields. A "Sign out other devices" button (`POST /api/me/password` with `sign_out_only: true`) |
| `/dashboard/settings` (new, D) | settings.manage | A company form with name, week start (select, Sunday to Saturday), timezone (select of common US zones plus free text) and four quarter start month-day pickers with a preview of this year's quarter ranges. A fiscal-year naming radio. The recap webhook with a URL, a "Secret: set / not set" line, Generate, Clear, and a note that the webhook is used from P2 |
| `/dashboard/import` (new, D) | import.manage | The Ninety importer (§6) and import history with Undo |

The People page has three parts:
- **People table:** name, email, title, role, teams, status (Active / Invited / No sign-in / Inactive) and last sign-in. An "Add person" drawer. Row actions: Edit, Create setup/reset link, Deactivate or Reactivate.
- **Link panel:** shows a new link once, with a Copy button.
- **Unmatched owners:** "Match owner names automatically" runs the backfill. Below it sits a list of unmatched text, each with an OwnerPicker (free text off), a "Remember as alias" tick, an Apply button and **"Leave as text (no account)"**. The last one is for people like Jeff Arnol, the consultant, and moves the name into a collapsed "Kept as text" section.
- **Adding a person:** the email field is pre-filled with `@<email_domain>` from settings when one is set. The admin types the local part, and no pattern is assumed. The seeded people already have emails. A person without one, for example someone created by the importer, shows "No email", and their "Create setup link" button is disabled with the tooltip "Add a work email first".

**Layout (`src/layouts/Dashboard.astro`, A):**
- The header shows the principal's name. Clicking it opens a small menu with My account (persons only), People, Settings and Import Ninety, each shown only when permitted, and Sign out.
- For a shared principal while bootstrap is open (`bootstrapOpen()`), a banner reads "Set up your owner account →".
- The team switcher lists only `allowedTeams`.

### 5.2 `OwnerPicker` (built by Task A as a shared interface; wired in by Tasks B, C and D; `src/components/OwnerPicker.tsx`)

```ts
export interface OwnerValue { owner_id: string | null; owner: string | null }
export default function OwnerPicker(props: {
  value: OwnerValue;
  onChange: (v: OwnerValue) => void;
  team?: TeamId;              // people on this team are listed first, others under "Other people"
  placeholder?: string;       // default "Owner"
  allowUnassigned?: boolean;  // default true
  size?: 'sm' | 'md';         // 'sm' = pill-sized for inline row controls
  disabled?: boolean;
  id?: string; 'aria-label'?: string;
}): JSX.Element
export function usePeople(): { people: PersonOption[]; loading: boolean; error: string | null }
```

- It renders a native `<select>`, which is accessible, works on phones, and suits about 10–30 people. The options are:
  - Unassigned
  - the team's active people
  - an "Other people" optgroup
  - when the value has text but no id, a selected `"<text> (not matched)"` option, so legacy values show and aren't wiped
  - when the value is an inactive person, `"<name> (inactive)"`
- `usePeople()` fetches `/api/people/options` once per page load. A promise is cached at module level so ten pickers make one request. It also accepts an optional `initialPeople` prop so that server-rendered pages can pass the list and skip the fetch.
- Choosing a person emits `{ owner_id, owner: name }`, and choosing Unassigned emits `{ owner_id: null, owner: null }`.

**Every text input it replaces, plus the new owner controls:**

| # | File | Current control | P0 change |
|---|---|---|---|
| 1 | `src/components/TodosBoard.tsx` | "Owner (optional)" input in the add form | OwnerPicker (default = current person) |
| 2 | `src/components/TodosBoard.tsx` | owner text in each row | `size="sm"` OwnerPicker in the row → `PATCH /api/todos/[id]` |
| 3 | `src/components/TodoPanel.tsx` | "Owner (optional)" input (meeting EOS tab) | OwnerPicker |
| 4 | `src/components/RocksPanel.tsx` | "Owner (optional)" input (meeting EOS tab) | OwnerPicker |
| 5 | `src/components/HeadlinesPanel.tsx` | "Presenter (optional)" input | OwnerPicker labelled "Presenter", sends `presenter_id` |
| 6 | `src/components/RoadmapEditor.tsx` → `AddRock` | "Owner (optional)" input | OwnerPicker |
| 7 | `src/components/RoadmapEditor.tsx` → `RockControls` | (status and period selects only) | add `size="sm"` OwnerPicker → `PATCH /api/rocks/[id]`. Props gain `owner`, `ownerId` (roadmap.astro passes them; Task B owns that page edit) |
| 8 | `src/components/ScorecardManager.tsx` | "Owner" input in the metric form (add and edit) | OwnerPicker |
| 9 | `src/components/IssuesBoard.tsx` | no owner today | OwnerPicker in the add form and `size="sm"` in each row |
| 10 | `src/components/IssuesPanel.tsx` | no owner today | OwnerPicker in the add form |

These stay free text in P0 (listed so nobody hunts for them):
- `MinutesDraftEditor` action owner, which lives in the minutes JSON and the sealed hash
- `AnalysisReview`, which shows AI-proposed names; they are resolved on commit
- `MeetingForm` attendees, which are converted in P2

Displays that show `owner` text (`rocks.astro`, `TodoPanel`, `RocksPanel`, the PDF, `DecisionRegister`) need no change because the text is kept in sync.

### 5.3 Other new components

| Component | Task | Notes |
|---|---|---|
| `SetPasswordForm.tsx` | C | used by `/setup/[token]`, reused on the bootstrap form |
| `PeopleAdmin.tsx` | C | table, add/edit drawer, link panel, invariant errors surfaced |
| `UnmatchedOwners.tsx` | C | uses OwnerPicker (from Task A), with `allowUnassigned={false}` |
| `AccountForm.tsx` | C | |
| `SettingsForm.tsx` | D | |
| `NinetyImport.tsx` | D | upload → preview → map → commit wizard |
| `ImportHistory.tsx` | D | list + undo with "N rows were edited since import" warning |

---

## 6. Ninety importer

### 6.1 Flow

1. **Upload.** You drop or select one or more `.xlsx` files: issues, to-dos, rocks, and later headlines and scorecard. Files are parsed in the browser with JSZip, which is already a dependency. Nothing is uploaded until the preview.
2. **Detect and normalize.** Each workbook is classified (§6.3) and turned into `NinetyRow[]`. Unknown workbooks are listed as "not recognised" with their sheet names and headers.
   - **Open items only** (user decision 2026-09-26). Any issue, to-do, rock or headline row with **Completed On or Archived Date** set is dropped here, before the preview.
   - The dropped rows are counted and shown per file, for example "12 completed or archived items skipped". There is no toggle to include them in P0.
   - The server applies the same rule again on commit.
   - Milestones follow their rock. A milestone of an imported (open) rock is imported even when it is completed, with `done = true`, because it records that rock's progress. A milestone whose own Archived Date is set is skipped. (The current file has no milestones.)
3. **Preview.** The rows go to `/api/import/ninety/preview`, which returns duplicates, owner matches, periods and existing rocks.
4. **Review UI.** This is covered in §6.5.
5. **Commit.** One transaction, one import batch. The result screen shows the counts and links to Issues, To-Dos and Rocks.
6. **Undo.** From the history list.

### 6.2 XLSX parsing (`src/lib/xlsx.ts`, browser-only, pure given a `DOMParser`)

- `readWorkbook(file: ArrayBuffer): Promise<Workbook>` where `Workbook = { sheets: Array<{ name: string; rows: string[][] }> }`, cells as raw strings.
- Steps:
  1. **Load the package.** `JSZip.loadAsync`.
  2. **Resolve sheets.** Read `xl/workbook.xml` for the `<sheet name r:id>` list. Resolve each `r:id` through `xl/_rels/workbook.xml.rels` to a target, and normalize it: strip a leading `/`, and prefix `xl/` if it is relative.
  3. **Shared strings.** Read `xl/sharedStrings.xml` if present. Each `<si>` becomes the concatenation of every descendant `t` element's text, which covers rich-text runs `<r><t>`. Phonetic `rPh` runs are skipped.
  4. **Namespace prefixes.** Ninety writes some workbooks with an `x:` prefix. Always select elements by **local name**, never by qualified name: use `getElementsByTagNameNS('*', 'row')`, `…('*', 'c')`, `…('*', 'v')`, `…('*', 't')` and `…('*', 'is')`, or compare `el.localName`. Attributes (`r`, `t`, `s`) are unprefixed in both variants.
  5. **Cells.** The column index comes from the letters in the `r` attribute (`A`=0 … `Z`=25, `AA`=26 …), because empty cells are omitted, so position in the row can't be trusted. If `r` is missing, the previous index plus one is used.
     - `t="s"`: shared string by index
     - `t="inlineStr"`: text of `is` → `t`
     - `t="str"` or `t="b"`: the `v` text
     - no `t`, or `t="n"`: the `v` text (the number as a string)
     - `t="e"`: empty
  6. **Row indices.** Row indices come from `<row r>`, and missing rows are empty arrays.
- Cell styles aren't read. Dates are recognized by column name, not number format.

**Excel dates** (`src/lib/excel-dates.ts`, shared by the browser and the server):

```ts
// Excel serial (1900 date system; 25569 = 1970-01-01). Fraction = time of day, firm-local wall clock.
excelDate(v: string): string | null      // '46287' → '2026-09-22'; also accepts 'YYYY-MM-DD' and 'M/D/YYYY'
excelDateTime(v: string): string | null  // '46224.8743055556' → '2026-07-21 20:59:00' (local wall time, no zone)
```

- `excelDate` returns null for blank or non-numeric input and for values below 1, and warns on values above 2958465.
- Conversion is `new Date(Math.round((serial - 25569) * 86400000))` read with UTC getters, so the browser timezone never shifts it.
- Timestamps are sent as local wall time. The server converts them with `($1::timestamp at time zone $tz)`, where `tz` is `company_settings.timezone`. That keeps DST correct without timezone code in the browser.

### 6.3 Workbook detection and normalized rows (`src/lib/ninety.ts`, pure, shared)

**Headers.** The header row is the first non-empty row of each sheet. Headers are matched case- and space-insensitively (`normalizeHeader`), and columns are looked up by name, never by position.

**Classification:**

| Kind | Rule | Hint only |
|---|---|---|
| issues | a sheet named `Short-Term` or `Long-Term`, or headers include `Type` and `Priority` with a Link containing `/issues/` | filename `Short_Term_Long_Term_*` |
| todos | headers include `Due Date` and `Repeat`, or Link contains `/todos/` | `To_Dos_*` |
| rocks | a sheet named `Rocks` with headers including `Level` or `Quarter`; a `Milestones` sheet in the same workbook → milestones | `Rocks_Milestones_*` |
| headlines (lower priority) | Link contains `/headlines/`, or a sheet or file name contains "Headline" | `Headlines_*` |
| scorecard (lower priority) | headers include `Title` and ≥ 2 headers that parse as dates (serial or date text), or a sheet or file name contains "Scorecard" | `Scorecard_*` |

**Link id.** `externalId(link)` returns the last 24-hex path segment, matching `/\/([0-9a-f]{24})(?:[/?#]|$)/i`. With no match, it falls back to the whole trimmed link and adds a warning. If there is no link at all, the result is null and that row can't be deduped. The preview flags it.

**Team.** `teamFromText(s)` maps `/leadership/i` to `leadership` and `/management/i` to `management`, and anything else to null, which the preview then asks about. The source is the Team column, with the sheet name as a fallback, since to-do sheets are named after the team.

The normalized row type:

```ts
type NinetyKind = 'issue' | 'todo' | 'rock' | 'milestone' | 'headline' | 'measurable';
interface NinetyRow {
  key: string;                 // `${kind}:${externalId ?? file+sheet+rowNumber}`, stable within a session
  kind: NinetyKind;
  file: string; sheet: string; rowNumber: number;
  externalId: string | null;
  team: TeamId | null; teamRaw: string | null;
  ownerName: string | null;    // trimmed Owner cell
  title: string;               // required; rows with blank Title are dropped with a warning
  description: string | null;
  createdAt: string | null;    // excelDateTime
  completedOn: string | null;  // excelDateTime
  archivedOn: string | null;   // excelDateTime
  dueDate: string | null;      // excelDate
  closed: boolean;             // completedOn || archivedOn; closed issue/to-do/rock/headline rows are dropped (open items only)
  // kind-specific
  horizon?: 'short' | 'long'; priorityNumber?: number | null; who?: string | null;
  repeat?: string | null;
  statusRaw?: string | null; level?: 'company' | 'individual' | null; quarter?: string | null;
  rockName?: string | null;                                  // milestone → parent rock title
  headlineType?: 'customer' | 'employee' | 'general';
  goal?: string | null; unit?: string | null; values?: Array<{ date: string; value: string }>; // measurable
  attachmentNames?: string | null;
  warnings: string[];
}
```

### 6.4 Field mapping tables

All rows written by the importer get:
- `external_source = 'ninety'`
- `external_id`, which may be null
- `import_batch_id`
- `source = 'manual'`
- `meeting_id = null`
- `created_at` from Created Date when present, otherwise `now()`
- owner text and id from the owner mapping (§6.5)

If `Attachment Names` is non-empty, `\n\nAttachments in Ninety (not imported): <names>` is appended to the description or notes.

**Issues** (`Short_Term_Long_Term_<Team>_Team_<date>.xlsx`)

| Ninety column | Flammard | Rule |
|---|---|---|
| Owner | `issues.owner`, `owner_id` | owner mapping |
| Title | `title` | trimmed, ≤ 500 chars |
| Description | `description` | kept verbatim, line breaks and URLs included |
| Type / sheet | `horizon` | "Short-Term" → `short`, "Long-Term" → `long`. Type column wins; sheet name is the fallback |
| Priority | `rank` | Open issues per (team, horizon) are sorted by Priority ascending with blanks last, then by Created Date. They are appended after the current bottom: `rank = max(rank) + i`. `priority` stays `medium` (Q9) |
| Team | `team` | teamFromText; the UI can override per file |
| Who | not stored | shown in the preview; if non-empty and different from Owner, appended to the description as `Who (Ninety): …` (Q4) |
| Completed On / Archived Date | row skipped | open items only; imported issues are `status = 'open'` |
| Link | `external_id` | |
| Created Date | `created_at` | |
| Attachment Names | description note | |

**To-dos** (`To_Dos_<Team>_Team_<date>.xlsx`)

| Ninety column | Flammard | Rule |
|---|---|---|
| Owner | `todos.owner`, `owner_id` | |
| Title | `title` | ≤ 500 |
| Description | `description` | new column |
| Due Date | `due_date` | new column, `excelDate` |
| Repeat | not stored | if not blank and not "Don't repeat", appended as `Repeats in Ninety: …` and flagged in the preview |
| Team | `team` | Team column, else the sheet name |
| Completed On / Archived Date | row skipped | open items only; imported to-dos are `status = 'open'` |
| Link | `external_id` | |
| Created Date | `created_at` | |

**Rocks** (`Rocks_Milestones_<Team>_Team_<date>.xlsx`, sheet `Rocks`)

| Ninety column | Flammard | Rule |
|---|---|---|
| Owner | `rocks.owner`, `owner_id` | |
| Title | `title` | |
| Description | `notes` | kept verbatim, bullet lines included |
| Due Date | `due_date` | |
| Status | `status` | See the status mapping after this table |
| Level | `level` | "Company" → `company`, "Individual" → `individual`, else null |
| Team | `team` | |
| Completed On / Archived Date | row skipped | open items only |
| Quarter | `quarter` (text, verbatim) and `period_id` | quarter → period mapping (§6.5) |
| Link | `external_id` | |
| Created Date | `created_at` | |

Rock status mapping (case-insensitive, after removing spaces and hyphens):
- `ontrack` → `on_track`
- `offtrack` → `off_track`
- `done`, `complete` or `completed` → `complete`
- `dropped` or `cancelled` → `dropped`
- blank → `on_track`
- anything else → `on_track`, with a warning
- A rock whose Status says Done/Complete but has no Completed On is still imported, as `complete`, because it belongs to the current quarter's review.
- If the result is `on_track` and the chosen period starts after today, the status is `planned`, which matches `/api/rocks` behaviour.

**Milestones** (sheet `Milestones` → `steps`, `parent_type = 'rock'`, top level)

| Ninety column | Flammard | Rule |
|---|---|---|
| Rock Name | `parent_id` | Matched first against a rock in the same import by title (case-insensitive, trimmed, same team), then against an existing rock in that team by title. If neither matches, the row is skipped with a warning. If the parent rock is excluded, the milestone is excluded too |
| Title | `title` | |
| Owner | `steps.owner`, `owner_id` | new columns, shown in P1 |
| Due Date | `steps.due_date` | new column |
| Completed On | `done = true` | milestones of an imported rock are kept even when completed (§6.1); Archived Date set → skipped |
| Description | not stored | steps have no description until P1; a non-empty one gets a preview warning |
| Link | `external_id` | |
| order | `sort_order` | by due date, then row order |

Today's file has a header row only, so this path must handle zero rows.

**Headlines** (lower priority; the format isn't in the firm's export, so verify with a real file before relying on it)

| Expected column | Flammard | Rule |
|---|---|---|
| Owner | `headlines.presenter`, `presenter_id` | |
| Title | `text` | |
| Description | `description` | |
| Type / Category (if present) | `type` | containing "customer" → customer; containing "employee" → employee; else general |
| Team | `team` | |
| Created Date | `created_at` | |
| Archived Date | row skipped | open items only |
| Link | `external_id` | |

Imported headlines have `meeting_id = null`, and nothing shows them until P1 (Q6). They are unchecked by default, with that note beside them.

**Scorecard** (lower priority; verify against a real file)

- **Metric fields:**
  - Owner → `scorecard_metrics.owner`/`owner_id`
  - Title → `title`
  - Goal → `goal` (text, verbatim, e.g. ">= 10")
  - Units (if present) → `unit`
- **Frequency:** the gap between date columns sets the frequency. About 7 days means `weekly`, about 1 month `monthly`, about 3 months `quarterly`.
- **Dedupe:** a metric matches by `external_id` when there is a Link. Otherwise it matches an existing metric by (team, lower(title)), and a matched metric is reused, not duplicated.
- **Values:** each date header with a non-blank cell becomes a `scorecard_entries` row with `period_date`, `value` as text, `source = 'import'` and `import_batch_id`. It uses `on conflict (metric_id, period_date) do nothing`, so existing values win and a preview checkbox for "overwrite" is not in P0. `on_track` is left null.

### 6.5 Mapping UI (`NinetyImport.tsx`)

**Header strip:**
- files recognised
- team per file, auto-detected and changeable with a select
- a note per file: "N completed or archived items skipped (open items only)"

**Owners panel.** There is one row per distinct Ninety owner name across the included rows. For each:
- The name.
- The number of items.
- A choice:
  - `Match: <person>`, pre-selected from the preview's `owners` map
  - `Choose person…` (an OwnerPicker with free text off)
  - `Create person "<name>"`, which creates the person with role `member`, teams from the files where the name appears, no email and no password
  - `Keep as text (no account)`, which stores the Ninety name as the owner text with no `owner_id`. This is the choice for Jeff Arnol, the consultant. It is pre-selected for names already in `company_settings.text_only_owner_names`, and otherwise for any name with no match, so nobody gets an account by accident. Choosing it also adds the name to that list, which keeps it out of the People page's unmatched list.
- "Remember spelling as alias" is ticked by default when the chosen person's name differs from the Ninety name.

**Quarters panel** (rocks only). There is one row per distinct `(team, Quarter)`:
- **Existing period:** auto-selected when an existing period of that team has the same name, case-insensitive.
- **Create period:** the name defaults to the Quarter text, for example "Q1 FY 2026". The start and end dates are computed by `quarterRange(label, settings)` and stay editable. The label is parsed with `/Q([1-4])\s*(?:FY)?\s*(\d{4})/i`. The FY year means the fiscal year named by `fiscal_year_named_by`. The range runs from the quarter's start month-day to the day before the next quarter's start. If the label can't be parsed, the dates are blank and required.
- **No period:** the quarter text is kept.

**Items.** There is one collapsible group per kind (Issues: short-term, Issues: long-term, To-dos, Rocks, Milestones, Headlines, Measurables), each with a count and a select-all checkbox. Each row shows:
- a checkbox
- title
- owner (mapped)
- team
- due or created date
- the status it will get
- warnings

Default state:
- Rows already imported, whose external id is in `existing`, are shown greyed and disabled with the note "Already imported".
- Everything else starts checked.

**Commit button:** "Import N items". Disabled while any included row has no team or an included quarter lacks dates.

`src/lib/quarters.ts` (Task D) exports:
- `quarterStarts(settings)`
- `quarterRange(label, settings)` → `{ start_date, end_date } | null`
- `quarterForDate(date, settings)` → `{ q, fy }`

### 6.6 Commit (`POST /api/import/ninety/commit`)

```ts
interface CommitRequest {
  files: string[];
  rows: NinetyRow[];                                  // only the checked rows
  owners: Record<string /* ninety name */,
    | { person_id: string; add_alias?: boolean }
    | { create: { name: string; teams: TeamId[] } }
    | { text_only: true }>;
  periods: Record<string /* `${team}|${quarter}` */,
    | { period_id: string }
    | { create: { name: string; start_date: string; end_date: string } }
    | { none: true }>;
}
```

The server's steps, following the pattern of `roadmap/commit.ts` and `commit-analysis.ts`:

1. **Validate everything again** (never trust the browser):
   - kinds and enums
   - title length
   - teams
   - ISO dates via `isIsoDate`, local timestamps via a regex
   - UUIDs, and that the referenced people and periods exist, belong to the team and are active
   - at most 3,000 rows
   - every `ownerName` present in `owners`
   - any issue, to-do, rock or headline row with `completedOn` or `archivedOn` set is rejected (400): open items only
2. **Read state.** Existing external ids per kind are read in one query each (`select external_id from <t> where external_source = 'ninety' and external_id = any($1)`). Rows already present are dropped and counted as `skipped_duplicates`. The current max rank per (team, horizon) is read too.
3. **Generate ids.** UUIDs are generated in code with `randomUUID()` for the batch, new people, new periods, rocks (so milestones can reference them), and every other row.
4. **Build the query list,** then run everything with **one** `sql().transaction(queries)`:
   1. `insert into import_batches (id, file_names, options, counts, created_by, created_by_name)`
   2. new people: `insert into people (id, name, role, teams, import_batch_id, created_by)`
   3. alias appends: `update people set aliases = array_append(aliases, $a) where id = $id and not ($a = any(aliases))`; text-only names: `update company_settings set text_only_owner_names = array_append(…)` when not already present
   4. new periods, with `import_batch_id`. The unique constraint on (team, name) means a same-name period created elsewhere makes the transaction fail with a clear message ("A period named X already exists; choose it instead").
   5. rocks, then steps, issues, todos, headlines, and metrics then entries. Each insert uses `on conflict (external_source, external_id) where external_id is not null do nothing`, which guards against a race with another import.
   6. The timestamp columns use `$ts::timestamp at time zone $tz`.
5. **Respond** with `{ batch_id, counts: { issues, todos, rocks, steps, headlines, metrics, entries, people, periods, aliases, skipped_duplicates } }`. The counts are computed from the query list, and the same object is stored in `import_batches.counts`.

A failure writes nothing, because the whole batch is one transaction.

### 6.7 Dedupe

- The dedupe key is (`external_source`, `external_id`), with partial unique indexes on issues, todos, rocks, steps, headlines and scorecard_metrics (§2.2).
- Re-importing a newer export **skips** items that already exist in P0; it doesn't update them (Q5). Rows without a Link can't be deduped. The preview warns "no Ninety id, may duplicate if imported twice".
- An import that has been undone deletes its rows, so importing the same file again brings them back.

### 6.8 Undo (`POST /api/import/batches/[id]/undo`)

The undo runs as one transaction:

```sql
delete from steps where import_batch_id = $1;
delete from steps where parent_type = 'rock'  and parent_id in (select id from rocks  where import_batch_id = $1);
delete from steps where parent_type = 'issue' and parent_id in (select id from issues where import_batch_id = $1);
delete from steps where parent_type = 'todo'  and parent_id in (select id from todos  where import_batch_id = $1);
update meeting_rocks set rock_id = null where rock_id in (select id from rocks where import_batch_id = $1); -- FK is set null anyway; explicit for clarity
delete from scorecard_entries where import_batch_id = $1;
delete from scorecard_metrics where import_batch_id = $1 and not exists (select 1 from scorecard_entries e where e.metric_id = scorecard_metrics.id);
delete from headlines where import_batch_id = $1;
delete from issues    where import_batch_id = $1;
delete from todos     where import_batch_id = $1;
delete from rocks     where import_batch_id = $1;
delete from periods p where p.import_batch_id = $1 and not exists (select 1 from rocks r where r.period_id = p.id);
delete from people p where p.import_batch_id = $1 and p.password_hash is null and p.email is null
  and not exists (select 1 from rocks where owner_id = p.id)
  and not exists (select 1 from todos where owner_id = p.id)
  and not exists (select 1 from issues where owner_id = p.id)
  and not exists (select 1 from meeting_rocks where owner_id = p.id)
  and not exists (select 1 from scorecard_metrics where owner_id = p.id)
  and not exists (select 1 from headlines where presenter_id = p.id)
  and not exists (select 1 from steps where owner_id = p.id);
update import_batches set status = 'undone', undone_at = now(), undone_by = $2, undone_counts = $3 where id = $1 and status = 'committed';
```

- The counts are computed by a read-only pass of `select count(*)` queries just before the transaction, which uses the same predicates. They are passed in as `$3` and returned to the UI.
- Before undoing, the UI calls `GET /api/import/batches/[id]`. If `edited_since > 0` it warns: "N imported items were changed after the import; undo deletes them anyway, including those edits and any steps added to them."
- Aliases added by the import are not removed. They are harmless and noted in the result.
- Imported people who were given an email, a password, or ownership of other items are kept. The result says "kept N people".

---

---

## 7. Rollout steps for the user

Do these in order. Each step leaves the live site working.

1. **Set up the phase branch.** Approve this spec. The builders work on `p0/*` branches and merge into `p0`, which opens one PR to `master` with a Netlify deploy preview.
2. **Run the SQL in Neon.** Before merging, open Neon and go to SQL Editor. Paste and run each file in turn:
   1. `db/upgrades/p0-foundation.sql`. It is additive, so the live (old) code keeps working.
   2. `db/upgrades/p0-seed-people.sql`, which creates the six people in §2.3 with their emails and no passwords. **Before running it, check the email domain line at the top**, which defaults to `jheathcpa.com`. The same statement stores the domain as the company email domain.
   3. `db/upgrades/p0-backfill-owners.sql`. It links existing rocks, to-dos, issues and so on to those people. Its last query lists the owner text that is still unmatched.

   Check it worked with `select name, email, role, teams, aliases from people order by name;`, which should return 6 rows with the right emails, and `select * from company_settings;`, which should return 1 row.

   The deploy preview uses whatever database its `NETLIFY_DATABASE_URL` points at, normally the same production database (Q11). Anything created on the preview is real. The importer's Undo covers test imports.
3. **Set the Netlify environment variables.** Go to Site configuration, then Environment variables. Scope them to all deploy contexts.

   | Variable | Value | Notes |
   |---|---|---|
   | `SESSION_SECRET` | 48+ random characters; generate with `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"` | New and required. Setting it signs everyone out once |
   | `SHARED_PASSWORD_LOGIN` | `on` | Set this to `off` at step 10 |
   | `SHARED_LOGIN_ROLE` | `facilitator` | Optional. It sets what the team password can do during rollout |
   | `SHARED_PASSWORD` | (unchanged) | Keep it until step 10 |
   | `PUBLIC_TIMEZONE` | (unchanged) | Still used by existing screens until P1 |

4. **Test the preview.** Trigger a deploy of the preview, since env changes need a redeploy, and work through §9.
5. **Merge the PR.** Once it has merged, **paste `p0-foundation.sql` again**. It is idempotent, and the second run fixes the `team` on any headline added to a Management meeting between steps 2 and 5.
6. **Claim the owner account.** Sign in on production with the team password and follow the banner "Set up your owner account".
   1. Pick "Russell Heath".
   2. Check the pre-filled email, then enter a password and save.
   3. You are now signed in as yourself.

   If the team password is already off, use `node scripts/create-owner.mjs --name "Russell Heath" --email <work email>` instead (§3.7).
7. **Company settings.** In Settings, check the email domain the seed set, then set the week start and the quarter dates.
8. **Accounts.** On People, do this for each seeded person except Jeff Arnol, who gets no account:
   1. Confirm their email, role and teams, which the seed already filled in.
   2. Choose "Create setup link", then Copy, and send the link through Teams or a text. Each link works once and expires in 7 days.
9. **Owner names and the import.**
   1. On People, check the "Unmatched owner names" list. Map any stragglers, ticking "remember as alias" for nicknames. Mark "Jeff Arnol" as **Leave as text (no account)**.
   2. Go to Import Ninety and drop in the XLSX files from `Downloads\Ninety Export\`. Skip the `(1)` duplicates; they would be deduped anyway.
   3. Only open items are imported. Check the owners (Jeff Arnol → "Keep as text") and the quarters, then choose Import.
   4. Check the Issues, To-Dos and Rocks pages. If something is wrong, choose Undo in the import history, adjust, and import again.
10. **Turn off the team password.** When everyone has signed in (People shows "Last sign-in" for all), set `SHARED_PASSWORD_LOGIN=off` and redeploy. You can remove `SHARED_PASSWORD` later. With it unset, the shared form disappears whatever the toggle says.
11. **Resetting a password.** Go to People, then the person's row, then "Create reset link", and send it. The old password stops working once they use it, and all their sessions end.

---

## 8. Task breakdown (4 builders, separate git worktrees)

**Branches.** Task A branches from `master` as `p0/foundation` and merges into `p0` first. Tasks B, C and D then branch from `p0` after A has merged, each in its own worktree: `p0/owners`, `p0/people-auth` and `p0/importer-settings`. No two tasks own the same file, and a file not listed belongs to nobody, so don't edit it. If a builder finds that it needs an unlisted file or a change in another task's file, it stops and reports the need instead of editing.

**Merge order:** A → C → B → D. B, C and D are independent, so the order only matters for review convenience: C first, because sign-in is needed to exercise the rest, and D last, because it is the largest. Each task must pass `npm run build` and `npx astro check` with no new errors in its own files. The reviewer reads each diff before it merges into `p0`.

### Task A: foundation (lands first, alone)

**Owns:**
- **SQL:**
  - `db/schema.sql` (append the §2.2 block only)
  - `db/upgrades/p0-foundation.sql`, `db/upgrades/p0-seed-people.sql` and `db/upgrades/p0-backfill-owners.sql` (all new)
- **Scripts:**
  - `scripts/create-owner.mjs` (new)
  - `package.json` (only the script `"people:create-owner": "node scripts/create-owner.mjs"`)
- **Types and middleware:**
  - `src/env.d.ts` (new: `/// <reference types="astro/client" />` plus `App.Locals { principal?: Principal }`)
  - `src/types.ts`
  - `src/middleware.ts`
- **Libraries:**
  - `src/lib/auth.ts`
  - `src/lib/password.ts`, `src/lib/permissions.ts`, `src/lib/people.ts` and `src/lib/settings.ts` (all new)
  - `src/lib/throttle.ts` (new). It takes the throttle logic moved out of `login.ts`, generalised to take a key, and adds the per-email key helper. `login.ts` itself switches to it in Task C.
  - `src/lib/api.ts` (additions only)
- **Routes and UI:**
  - `src/pages/api/team.ts`
  - `src/pages/api/people/options.ts` (new)
  - `src/components/OwnerPicker.tsx` (new, a full implementation of §5.2)
  - `src/layouts/Dashboard.astro` (user menu, role-gated links, bootstrap banner, switcher limited to allowed teams)
- **Docs:** `docs/SETUP.md` (env vars and the first-owner section)

**Provides:** every interface in §3.8, the route-rule table, the `Principal` type and `OwnerPicker`/`usePeople`.

**Acceptance:**
- [ ] The three SQL files run twice in a row on a fresh Neon branch with no errors. `schema.sql` runs through `npm run db:setup`, which uses the `;\n` splitter.
- [ ] After the seed, `people` has 6 rows with `<local>@jheathcpa.com` emails, and `company_settings.email_domain = 'jheathcpa.com'`. Changing the one domain line and re-running on a fresh branch changes both.
- [ ] After the seed, `select * from person_name_keys` includes the keys `russell`, `russell heath`, `jude`, `shishi` and `xixi`, and has no `heath` key.
- [ ] With the SQL applied and no other P0 task merged, signing in with the shared password works, and every existing page and action behaves as before.
- [ ] Old shared cookies are accepted while `SHARED_PASSWORD_LOGIN` is not `off` and rejected when it is.
- [ ] `/api/*` without a cookie returns 401 JSON, except on the public paths. The TaxDome webhook still works with its Bearer secret.
- [ ] A person cookie with a stale `session_version`, or for an inactive person, is rejected.
- [ ] `checkRoute` implements the §3.6 table.
- [ ] An observer gets 403 on `POST /api/todos`.
- [ ] A cross-origin POST gets 403.
- [ ] The team cookie is coerced to an allowed team.
- [ ] `bootstrapOpen()` is true after the seed, since Russell has no password yet.
- [ ] `hashPassword`/`verifyPassword` round-trip, reject a wrong password, and flag `needsRehash` for old parameters. An uncommitted self-test script in the scratchpad is enough to show this.
- [ ] `resolveOwner` handles each input:
  - [ ] a valid id → the person's name
  - [ ] an unknown or inactive id → error
  - [ ] "Shishi" → Xixi's id with the name "Xixi"
  - [ ] "Jeff Arnol" → text only
- [ ] `OwnerPicker` renders:
  - [ ] Unassigned, team-first and "Other people" groups
  - [ ] "(not matched)" for text-only values
  - [ ] "(inactive)" for inactive owners
  - [ ] one network request for many pickers

### Task B: owner pickers and item routes

**Owns:**
- **Components:**
  - `src/components/TodosBoard.tsx`, `TodoPanel.tsx`, `RocksPanel.tsx` and `HeadlinesPanel.tsx`
  - `src/components/RoadmapEditor.tsx`, `ScorecardManager.tsx`, `IssuesBoard.tsx` and `IssuesPanel.tsx`
- **Pages:**
  - `src/pages/dashboard/roadmap.astro`, `issues.astro`, `todos.astro` and `scorecard.astro`
  - `src/pages/dashboard/meetings/[id].astro`, only to pass owner fields, team or `can` props
- **Libraries:**
  - `src/lib/issues.ts`
  - `src/lib/steps.ts`, for the issue owner in the parent loader
  - `src/lib/roadmap.ts`, only if the rock loader needs `owner_id`
- **API:**
  - rocks: `src/pages/api/rocks/index.ts` and `rocks/[id].ts`
  - to-dos: `todos/index.ts` and `todos/[id].ts`
  - issues: `issues/index.ts` and `issues/[id].ts`
  - meetings: `meetings/[id]/rocks.ts`, `meetings/[id]/todos.ts`, `meetings/[id]/headlines.ts`, `meetings/[id]/issues.ts`, `meetings/[id]/commit-analysis.ts` and `meetings/[id]/approve.ts`
  - meeting rocks: `meeting-rocks/[id].ts`
  - scorecard: `scorecard/metrics.ts` and `scorecard/metrics/[id].ts`
  - roadmap: `roadmap/commit.ts`

**Uses:** `resolveOwner`, `resolveOwnerNames`, `principal`, `can` and `OwnerPicker`.

**Acceptance:**
- [ ] Every row of the §5.2 table is done. A new to-do defaults its owner to the signed-in person, or to unassigned for the shared principal.
- [ ] Each §4.4 route accepts `owner_id` and writes both columns. It still accepts plain `owner` text from an old client and auto-matches it.
- [ ] Headlines added in a meeting get the meeting's team.
- [ ] `approved_by` shows the person's name.
- [ ] Committing an AI analysis that names "Jude" or "Shishi" sets the right `owner_id`. "Jeff Arnol" stays text.
- [ ] Marking a to-do done sets `completed_at`, and solving an issue sets `solved_at`.
- [ ] Existing unmatched text still displays and is not wiped when a row's status changes.

### Task C: people, sign-in, setup links, My account

**Owns:**
- **Auth API:**
  - `src/pages/api/auth/login.ts` and `logout.ts`
  - `src/pages/api/auth/setup.ts` (new)
- **Public pages:**
  - `src/pages/login.astro`
  - `src/pages/setup/[token].astro` (new)
- **Account API:** `src/pages/api/me/index.ts` and `me/password.ts` (new)
- **People API** (all new, under `src/pages/api/people/`):
  - `index.ts`, `[id].ts` and `[id]/link.ts`
  - `bootstrap.ts`
  - `unmatched-owners.ts`, `match-owners.ts`, `backfill-owners.ts` and `text-only-owners.ts`
- **Dashboard pages:** `src/pages/dashboard/people.astro` and `account.astro` (new)
- **Components:** `src/components/PeopleAdmin.tsx`, `UnmatchedOwners.tsx`, `AccountForm.tsx` and `SetPasswordForm.tsx` (new)

**Uses:**
- `password.ts`, `auth.ts` and `throttle.ts`
- from `people.ts`: `syncOwnerNameQueries`, `backfillOwnerQueries` and `bootstrapOpen`
- from `permissions.ts`: `canManagePerson`
- from `settings.ts`: `getSettings`, for `email_domain` and `text_only_owner_names`
- `OwnerPicker`

**Acceptance:**
- [ ] Bootstrap claims the seeded "Russell Heath" row exactly once, even with two tabs, and switches the cookie to it. After that, the endpoint returns 409.
- [ ] The email field pre-fills `@<email_domain>`, and a duplicate email returns 409.
- [ ] Setup links:
  - [ ] "Create setup link" is disabled without an email.
  - [ ] A link works once and expires. After use or expiry it shows the invalid state.
  - [ ] A new link voids older ones.
  - [ ] Only hashes are stored.
- [ ] Sign-in and throttling:
  - [ ] Email and password sign-in works, and the email is case-insensitive.
  - [ ] A wrong password or an unknown email gives the same message after a similar delay.
  - [ ] The per-IP and per-email throttles trigger at 11 attempts.
- [ ] §3.5 invariants: the last owner can't be demoted, an admin can't touch owners or admins, and nobody can change their own role.
- [ ] Deactivating a person signs them out at their next request.
- [ ] Renaming a person updates the owner text on all their items.
- [ ] Changing your password signs out other browsers and keeps the current one.
- [ ] The unmatched-owner list can be applied, the alias tick works, and "Leave as text (no account)" moves Jeff Arnol into "Kept as text".

### Task D: company settings and the Ninety importer

**Owns:**
- **Libraries** (all new): `src/lib/xlsx.ts`, `src/lib/excel-dates.ts`, `src/lib/ninety.ts` and `src/lib/quarters.ts`
- **Settings API:** `src/pages/api/settings.ts`
- **Import API** (all new, under `src/pages/api/import/`):
  - `ninety/preview.ts` and `ninety/commit.ts`
  - `batches/index.ts`, `batches/[id].ts` and `batches/[id]/undo.ts`
- **Dashboard pages:** `src/pages/dashboard/settings.astro` and `import.astro` (new)
- **Components:** `src/components/SettingsForm.tsx`, `NinetyImport.tsx` and `ImportHistory.tsx` (new)

**Uses:** `settings.ts` (`getSettings`, `publicSettings`), `principal`, `OwnerPicker`, `isIsoDate` and `sql().transaction`.

**Acceptance:**
- [ ] Settings:
  - [ ] Settings save and reload, including `email_domain`.
  - [ ] The secret is never returned, and "Generate" shows it only once.
  - [ ] An invalid timezone, URL or domain is rejected.
- [ ] Parsing the real files in `Downloads\Ninety Export\`:
  - [ ] Both `x:`-prefixed and unprefixed sheets parse.
  - [ ] The row totals match: issues 19 + 5 (Leadership) and 3 + 1 (Management), to-dos 18 and 4, rocks 11, milestones 0.
  - [ ] Completed and archived rows are excluded and reported as skipped.
- [ ] Excel dates convert correctly: serial `46287` → `2026-09-22`, and `46224.8743055556` → `2026-07-21 20:59:00`.
- [ ] Mapping:
  - [ ] Team comes from the file.
  - [ ] Owners auto-match, including "Shishi", which maps to Xixi.
  - [ ] "Jeff Arnol" defaults to "Keep as text (no account)" and imports with no `owner_id`.
- [ ] Issue order: the Priority order becomes the rank order after existing issues.
- [ ] Rocks: "Q3 FY 2026" maps to an existing or new period with computed dates, and Level is stored.
- [ ] Idempotency:
  - [ ] Importing the same files twice creates nothing new the second time and reports `skipped_duplicates`.
  - [ ] A forced failure, such as a duplicate period name, writes nothing.
  - [ ] A commit containing a completed row is rejected.
- [ ] Undo removes exactly the batch's rows, periods and unreferenced new people, and marks the batch undone. A second undo returns 409.
- [ ] Headlines and scorecard have detection and mapping behind the same UI, tested with a small synthetic XLSX in the scratchpad (not committed). The UI marks them "unverified format".

---

## 9. Manual test checklist (Netlify deploy preview)

The preview needs `SESSION_SECRET` set and `SHARED_PASSWORD_LOGIN=on`, with all three SQL files already applied.

**Rollout compatibility**
- [ ] The old production site, still on master, works after the SQL runs. Add a to-do and an issue, and open a meeting.
- [ ] On the preview, the team password still signs in. Every page loads, and adding and editing items works as before.

**Bootstrap and accounts**
- [ ] The "Set up your owner account" banner shows.
- [ ] Claiming "Russell Heath" with an email and password signs you in as Russell, and the header shows your name.
- [ ] The banner is gone, and `POST /api/people/bootstrap` now returns 409.
- [ ] People lists the 6 seeded people with their emails, all marked "No sign-in yet". Settings shows the email domain, and "Add person" pre-fills `@<domain>`.
- [ ] Create setup links for Kayla (member, Management) and, as a test, an observer account.
- [ ] In a private window, open Kayla's link and try a too-short password, which shows an error. Then set a valid one, which lands on the dashboard.
- [ ] Reusing that link shows "expired or already used".
- [ ] Kayla's team switcher shows Management only. Editing the team cookie to `leadership` by hand is corrected on the next page load.
- [ ] Kayla can add, edit and delete a to-do.
- [ ] The observer's pages load, but adding or deleting a to-do fails with a clear permission message and a 403.
- [ ] 11 wrong passwords in a row give "Too many attempts".
- [ ] A reset link for Kayla works, and her other session is signed out.
- [ ] My account: changing the password signs out the other browser.
- [ ] Deactivating the observer bounces their open session to `/login` on the next click.
- [ ] As Jude (admin), editing Russell (owner) is refused, and so is demoting the last owner.
- [ ] Renaming Xixi to her full name updates her to-dos and rocks, and "Shishi" still matches her.

**Owners**
- [ ] "Match owner names automatically" reports counts, and the matched items show the full name.
- [ ] Any leftover nickname can be mapped with "remember as alias".
- [ ] Each picker in §5.2 works:
  - [ ] To-Dos page: add, and the row picker
  - [ ] meeting tab: to-do, rock and headline presenter
  - [ ] roadmap: add rock, and rock controls
  - [ ] scorecard: metric add and edit
  - [ ] Issues page: add, and the row picker
  - [ ] meeting issue add
- [ ] A legacy unmatched owner shows "(not matched)" and survives a status change.
- [ ] Approving minutes records your name, and it shows in the PDF and in approvals.

**Settings**
- [ ] Changing the week start and quarter dates, then saving and reloading, keeps the values.
- [ ] A generated webhook secret is shown once, and afterwards the page reads "Secret: set".
- [ ] A non-https webhook URL is rejected.
- [ ] A member opening `/dashboard/settings` gets a 403.

**Ninety import**
- [ ] Drop in all the files from `Downloads\Ninety Export\`, including the `(1)` copies. The recognised kinds and open-item counts show, with "N completed or archived items skipped" for each file.
- [ ] Russell Heath, Jude Heath and the Management names auto-match.
- [ ] Jeff Arnol shows as "Keep as text (no account)".
- [ ] The rocks' quarters panel proposes periods, and editing their dates works.
- [ ] Choose Import, then check these pages:
  - [ ] Issues: short and long lists in Ninety priority order after the existing issues, with owners set.
  - [ ] To-dos: present with owners, and due dates present in the database.
  - [ ] Rocks: on the Rocks page with owners. Level is stored and notes hold the description.
  - [ ] Jeff Arnol's items show "Jeff Arnol" as the owner.
- [ ] Importing the same files again shows everything as "Already imported", and the commit reports 0 new.
- [ ] Undo removes the batch's items and created periods, and the history shows "Undone".
- [ ] Importing again works.

**Regression**
- [ ] The TaxDome webhook (Zapier) still posts values.
- [ ] A meeting still runs end to end: record, transcribe, analyze, commit, approve, PDF.
- [ ] The Roadmap AI import still works.

---

## 10. Open questions for the user

Decided on 2026-09-26 and built in above:
- initial people, emails, roles and teams (§2.3)
- Shishi as an alias for Xixi
- Jeff Arnol stays text only, with no account
- emails are seeded; the domain sits on one editable line in the seed and also pre-fills new people's emails
- only open items are imported
- delete rights are unchanged

Decided on 2026-09-26, second round. These are final, so builders apply them as written:
1. **Quarters:**
   - Q1 starts **Feb 1**, then May 1, Aug 1 and Nov 1.
   - `fiscal_year_named_by = 'start'`: the Feb 2026–Jan 2027 year is "FY 2026". This matches Ninety, where April 2026 is "Q1 FY 2026" and August 2026 is "Q3 FY 2026".
   - The settings defaults and the seed use these values. The importer maps Ninety "Qn FY YYYY" onto these quarters.
2. **Week start is Tuesday** (`week_start = 2`, 0 = Sunday). The leadership L10 is on Tuesdays.
3. **Roles:**
   - Russell Heath: owner, and the only facilitator (owner includes all facilitator rights).
   - Jude Heath and Jennifer Louise: admin (confirmed).
   - Xixi, Kayla and Nicole: members on Management.
4. **Defaults accepted:**
   - Team privacy: switching only in P0; row-level checks come in P1.
   - Ninety "Who" is appended to the description.
   - Re-import skips existing items.
   - Headlines wait for P1.
   - The shared password gets the facilitator role.
   - Only managers and above create and analyze meetings.
   - Ninety Priority sets rank only.
   - Sessions last 30 days.
   - Completed milestones under an open rock import as done.
   - Minutes action-item owners stay text.
5. **Deploy previews** share the production database. Test with care, and undo test imports.
6. **Email domain:** `jheathcpa.com` stays until the user corrects it. It's on one line in the seed.
7. **Full names** for Xixi, Kayla and Nicole: first names for now, editable later.
