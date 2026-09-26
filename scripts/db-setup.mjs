// Applies db/schema.sql to the Netlify DB.
//
//   NETLIFY_DATABASE_URL=postgres://... npm run db:setup
//
// Get the URL from Netlify → Site → Extensions → Neon database, or run
// `netlify env:get NETLIFY_DATABASE_URL` with the Netlify CLI linked to the site.

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set NETLIFY_DATABASE_URL (or DATABASE_URL) to the Postgres connection string.');
  process.exit(1);
}

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const sql = neon(url);

// Run statement by statement so an error points at the right one
const statements = schema
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);

for (const statement of statements) {
  try {
    await sql.query(statement);
  } catch (err) {
    console.error(`Failed:\n${statement}\n\n${err.message}`);
    process.exit(1);
  }
}

const [{ count }] = await sql`select count(*)::int as count from information_schema.tables where table_schema = 'public'`;
console.log(`Schema applied — ${count} tables in public.`);
