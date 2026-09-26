# Setup

Flammard runs entirely on Netlify: the site (Astro SSR as a Netlify Function), the database (**Netlify DB**, a Neon Postgres), and file storage (**Netlify Blobs** for recordings and sealed PDFs). Sign-in is one shared team password. There is nothing else to create an account for besides Anthropic (for the AI steps) and Zapier (for TaxDome).

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
| `SHARED_PASSWORD` | yes | The one password the team signs in with. |
| `SESSION_SECRET` | recommended | Signs the login cookie. `openssl rand -hex 32`. Falls back to the password if unset. |
| `ANTHROPIC_API_KEY` | for AI steps | Transcript analysis and TaxDome extraction. |
| `TAXDOME_WEBHOOK_SECRET` | for TaxDome | Bearer secret Zapier sends. `openssl rand -hex 32`. |
| `PUBLIC_APP_URL` | yes | e.g. `https://flammard.netlify.app` — shown as the webhook URL. |
| `PUBLIC_APP_NAME` | optional | Name in the header and PDF. Default `Flammard`. |
| `PUBLIC_TEAM_LABEL` | optional | Who "approved" the minutes, e.g. `Leadership team`. |

Redeploy after changing them.

## 4. Blobs

Nothing to configure. Two stores are created on first use: `recordings` (browser audio, chunked) and `minutes-pdf`. Free tier is generous; each blob can be up to 5 GB.

## Teams

There are two EOS teams — **Leadership** and **Management** — behind the one login. The switcher in the header picks the active team, and every list (meetings, rocks, to-dos, issues, scorecard, register) shows only that team's items. A meeting is filed under whichever team is active when it's created and keeps that team. Rocks and scorecard metrics belong to a team too.

## Local development

```bash
cp .env.example .env     # fill in NETLIFY_DATABASE_URL and SHARED_PASSWORD
npx netlify dev          # runs Astro with Blobs + env wired up like production
```

`npm run dev` also works for pages that don't touch Blobs.
