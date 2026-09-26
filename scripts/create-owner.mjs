// Creates (or claims) the first owner account and prints a one-time setup link.
// The fallback for when the team password is already off (see docs/SETUP.md).
//
//   NETLIFY_DATABASE_URL=postgres://... npm run people:create-owner -- --name "Russell Heath" --email russell@example.com
//
// Options:
//   --name "<full name>"   the owner's name; an existing owner row with this
//                          name (case-insensitive, e.g. from the seed) is reused
//   --email <address>      work email (required unless the row already has one)
//   --origin <url>         site the link points at (default https://flammard.netlify.app)
//   --force                run even though an owner can already sign in
//
// Refuses unless the bootstrap condition holds (no active owner has a
// password yet), unless --force is given. Only the SHA-256 of the token is
// stored, the same as the app's setup links.

import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { neon } from '@neondatabase/serverless';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    origin: { type: 'string', default: 'https://flammard.netlify.app' },
    force: { type: 'boolean', default: false },
  },
});

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!url) fail('Set NETLIFY_DATABASE_URL (or DATABASE_URL) to the Postgres connection string.');

const name = args.name?.trim();
const email = args.email?.trim().toLowerCase() || null;
if (!name) fail('Pass --name "<full name>".');
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Not an email address: ${email}`);

let origin;
try {
  origin = new URL(args.origin).origin;
} catch {
  fail(`Not a URL: ${args.origin}`);
}

const sql = neon(url);

const [{ open }] = await sql`
  select not exists (select 1 from people where role = 'owner' and active and password_hash is not null) as open`;
if (!open && !args.force) {
  fail('An owner can already sign in. Create links from the People page instead, or pass --force.');
}

// Reuse the owner row with this name (the seed creates one), else insert one
let [person] = await sql`
  select id, name, email, password_hash is not null as has_password
  from people where role = 'owner' and lower(btrim(name)) = ${name.toLowerCase()}
  order by active desc, created_at limit 1`;

if (email) {
  const [clash] = await sql`select id, name from people where email = ${email}`;
  if (clash && clash.id !== person?.id) fail(`${email} already belongs to ${clash.name}.`);
}

if (!person) {
  if (!email) fail('No owner with that name exists yet, so --email is required.');
  [person] = await sql`
    insert into people (name, email, role, teams)
    values (${name}, ${email}, 'owner', array['leadership', 'management']::text[])
    returning id, name, email, false as has_password`;
  console.log(`Created owner ${person.name}.`);
} else {
  if (!person.email && !email) fail(`${person.name} has no email yet; pass --email.`);
  await sql`
    update people set email = coalesce(${email}, email), active = true, updated_at = now()
    where id = ${person.id}`;
  console.log(`Using existing owner ${person.name}.`);
}

// One live link at a time: void older unused ones, then issue a new one
const purpose = person.has_password ? 'reset' : 'setup';
const hours = purpose === 'setup' ? 7 * 24 : 24;
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');

await sql.transaction([
  sql`update person_tokens set used_at = now() where person_id = ${person.id} and used_at is null`,
  sql`insert into person_tokens (person_id, purpose, token_hash, expires_at)
      values (${person.id}, ${purpose}, ${hash}, now() + make_interval(hours => ${hours}))`,
]);

console.log(`\n${purpose === 'setup' ? 'Setup' : 'Reset'} link for ${person.name} (works once, expires in ${purpose === 'setup' ? '7 days' : '24 hours'}):\n`);
console.log(`  ${origin}/setup/${token}\n`);
