# Setup

Flammard runs entirely on Netlify: the site (Astro SSR as a Netlify Function), the database (**Netlify DB**, a Neon Postgres), and file storage (**Netlify Blobs** for recordings and sealed PDFs). Everyone signs in with their own email and password (see [People and sign-in](#people-and-sign-in)); the old shared team password keeps working behind a switch during rollout. There is nothing else to create an account for besides Anthropic (for the AI steps) and Zapier (for TaxDome).

## 1. Deploy the site

Connect the repository to Netlify (Add new site → Import from Git). Build settings come from `netlify.toml`.

## 2. Turn on the database

In the Netlify dashboard: **Site → Extensions → Neon** (or `netlify db init` with the CLI). Netlify creates the Postgres database and injects `NETLIFY_DATABASE_URL` into every build and function automatically — nothing to paste.

Then create the tables. Locally, with the Netlify CLI linked to the site:

```bash
npm install
npx netlify link
NETLIFY_DATABASE_URL="$(npx netlify env:get NETLIFY_DATABASE_URL)" npm run db:setup
```

(or copy the connection string from the Neon panel and run `NETLIFY_DATABASE_URL=postgres://… npm run db:setup`). The script applies `db/schema.sql` and is safe to re-run.

Free tier: 0.5 GB storage, scales to zero when idle, no pausing.

## 3. Environment variables

**Site settings → Environment variables**:

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | Signs the login cookie; 48+ random characters: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`. Required for personal sign-in. Setting or changing it signs everyone out once. |
| `SHARED_PASSWORD` | during rollout | The old shared team password. Remove it once everyone has their own account; with it unset the team-password form disappears. |
| `SHARED_PASSWORD_LOGIN` | optional | `on` (default) allows the team password and existing team-password sessions; `off` turns both off. |
| `SHARED_LOGIN_ROLE` | optional | What the team password may do: `facilitator` (default), or `manager`, `member`, `observer`. It never grants People, Settings or Import. |
| `ANTHROPIC_API_KEY` | for AI steps | Transcript analysis and TaxDome extraction. |
| `TAXDOME_WEBHOOK_SECRET` | for TaxDome | Bearer secret Zapier sends. `openssl rand -hex 32`. |
| `PUBLIC_APP_URL` | yes | e.g. `https://flammard.netlify.app` — shown as the webhook URL. |
| `PUBLIC_APP_NAME` | optional | Name in the header and PDF. Default `Flammard`. |
| `PUBLIC_TEAM_LABEL` | optional | Who "approved" the minutes, e.g. `Leadership team`. |

Set each variable's scope to **All scopes** (builds and functions — the default), then **trigger a new deploy**: Astro evaluates secrets at build time as well as at runtime, so a variable added after the last build isn't picked up until the next one.

## 4. Blobs

Nothing to configure. Three stores are created on first use: `recordings` (browser audio, chunked), `minutes-pdf` and `auth` (sign-in attempt counters). Free tier is generous; each blob can be up to 5 GB.

## People and sign-in

Each person has an account (`people` table) with one of six roles:

| Role | Can |
|---|---|
| Owner | everything, including making people owners or admins |
| Admin | everything except granting or changing owner/admin; People, Settings, Import |
| Facilitator | run meetings, approve minutes, manage scorecard/periods/roadmap, see both teams |
| Manager | the same as a facilitator but only for their own teams |
| Member | add, edit and delete rocks, to-dos, issues, headlines, steps and scorecard values |
| Observer | read only |

Passwords are never emailed. An admin creates a one-time **setup link** on the People page (7 days) or a **reset link** (24 hours) and sends it by Teams, text or in person. Forgotten passwords: ask an admin for a reset link.

### Upgrading an existing database (P0)

Paste each file into the Neon SQL Editor and run it, in this order. Each is safe to run more than once, and the live site keeps working after each.

1. `db/upgrades/p0-foundation.sql` — people, setup links, company settings, owner ids. (The same block is in `db/schema.sql`, so `npm run db:setup` also applies it.) Run it once more after the P0 code is deployed; that fixes the team on any headline added to a Management meeting in between.
2. `db/upgrades/p0-seed-people.sql` — the firm's people with their work emails and no passwords. **Check the email-domain line at the top first.**
3. `db/upgrades/p0-backfill-owners.sql` — links existing owner names on rocks, to-dos, issues and so on to those people, and lists the names still unmatched. (The same thing is on People → "Match owner names".)

Then set `SESSION_SECRET` (and keep `SHARED_PASSWORD`, `SHARED_PASSWORD_LOGIN=on`) and redeploy.

### The first owner

Until an owner has a password, signing in with the team password shows a banner, **Set up your owner account →**. It opens People, where you pick the seeded owner (e.g. Russell Heath), check the email and choose a password. You are then signed in as yourself, and the banner is gone for good.

If the team password is already off, create the owner's setup link from a terminal instead:

```bash
NETLIFY_DATABASE_URL="$(npx netlify env:get NETLIFY_DATABASE_URL)"   npm run people:create-owner -- --name "Russell Heath" --email russell@example.com
```

It reuses the owner row with that name (or creates one), prints a 7-day setup link for `--origin` (default `https://flammard.netlify.app`), and refuses once an owner can sign in unless you pass `--force`.

### Turning off the team password

When everyone has signed in (People shows a last sign-in for each), set `SHARED_PASSWORD_LOGIN=off` and redeploy. Existing team-password sessions end at their next click. `SHARED_PASSWORD` can then be removed.

## Teams

There are two EOS teams — **Leadership** and **Management**. Each person belongs to one or both; owners, admins and facilitators (and the team password) can see both. The switcher in the header picks the active team from the ones you may see, and every list (meetings, rocks, to-dos, issues, scorecard, register) shows only that team's items. A meeting is filed under whichever team is active when it's created and keeps that team. Rocks and scorecard metrics belong to a team too.

## Local development

```bash
cp .env.example .env     # fill in NETLIFY_DATABASE_URL, SESSION_SECRET and SHARED_PASSWORD
npx netlify dev          # runs Astro with Blobs + env wired up like production
```

`npm run dev` also works; the Netlify adapter emulates Blobs locally, and `NETLIFY_DATABASE_URL` comes from `.env`.
