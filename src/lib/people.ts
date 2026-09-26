import type { AstroCookies } from 'astro';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import type { PersonOption, Principal, Role, TeamId } from '../types';
import { readSession, sharedLoginEnabled, sharedLoginRole, TEAM_LABEL } from './auth';
import { many, one, sql } from './db';
import { isRole } from './permissions';

// People: who is signed in (loadPrincipal), owner pickers (listPeopleOptions)
// and owner resolution for every write that sets an owner (resolveOwner).
//
// Every owner-bearing table keeps its free-text column next to the id; the app
// keeps the text equal to people.name (see syncOwnerNameQueries), so existing
// readers — lists, the PDF, AI prompts — keep working unchanged.

/** Every free-text owner column and its id column (spec §2.5). */
export const OWNER_COLUMNS: Array<{ table: string; text: string; id: string }> = [
  { table: 'rocks', text: 'owner', id: 'owner_id' },
  { table: 'todos', text: 'owner', id: 'owner_id' },
  { table: 'meeting_rocks', text: 'owner', id: 'owner_id' },
  { table: 'scorecard_metrics', text: 'owner', id: 'owner_id' },
  { table: 'issues', text: 'owner', id: 'owner_id' },
  { table: 'steps', text: 'owner', id: 'owner_id' },
  { table: 'headlines', text: 'presenter', id: 'presenter_id' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_TEAMS: TeamId[] = ['leadership', 'management'];

/** The name key person_name_keys matches on: lower-cased, trimmed. */
export const nameKey = (text: string) => text.trim().toLowerCase();

/**
 * Resolves the session cookie to a principal, or null when signed out. A
 * person session costs one query and is valid only while the person is active
 * and their session_version matches. Shared sessions need no query and are
 * accepted only while the shared login is enabled.
 */
export async function loadPrincipal(cookies: AstroCookies): Promise<Principal | null> {
  const session = readSession(cookies);
  if (!session) return null;

  if (session.kind === 'shared') {
    if (!sharedLoginEnabled()) return null;
    const role = sharedLoginRole();
    return { kind: 'shared', id: null, name: TEAM_LABEL, role: isRole(role) ? role : 'facilitator', teams: [...ALL_TEAMS] };
  }

  const row = await one<{ id: string; name: string; email: string | null; role: Role; teams: TeamId[]; session_version: number }>(
    sql().query(
      'select id, name, email, role, teams, session_version from people where id = $1 and active',
      [session.personId]
    )
  );
  if (!row || row.session_version !== session.version) return null;
  return { kind: 'person', id: row.id, name: row.name, email: row.email ?? '', role: row.role, teams: row.teams ?? [] };
}

/** People for owner pickers: active first, then by name. */
export async function listPeopleOptions(includeInactive = false): Promise<PersonOption[]> {
  return many<PersonOption>(
    sql().query(
      `select id, name, teams, active from people
       where $1::boolean or active
       order by active desc, lower(name), id`,
      [includeInactive]
    )
  );
}

/**
 * Works out the owner columns for a write.
 * - `owner_id` (uuid of an active person) wins → owner = that person's name.
 * - Otherwise the `owner` text: with `opts.match` (default true) text matching
 *   a name key (full name, alias or unique first name) becomes that person's
 *   id and canonical name; anything else is kept as trimmed text, no id.
 * - Nothing (or blank) → both null.
 * An unknown or inactive id, or a malformed owner_id, is an error.
 */
export async function resolveOwner(
  input: { owner_id?: unknown; owner?: unknown },
  opts: { match?: boolean } = {}
): Promise<{ owner_id: string | null; owner: string | null } | { error: string }> {
  const { owner_id, owner } = input;

  if (owner_id !== undefined && owner_id !== null && owner_id !== '') {
    if (typeof owner_id !== 'string' || !UUID.test(owner_id)) return { error: 'Invalid owner_id' };
    const person = await one<{ id: string; name: string }>(
      sql().query('select id, name from people where id = $1 and active', [owner_id])
    );
    if (!person) return { error: 'Owner not found or inactive' };
    return { owner_id: person.id, owner: person.name };
  }

  if (owner !== undefined && owner !== null && typeof owner !== 'string') return { error: 'Invalid owner' };
  const text = typeof owner === 'string' ? owner.trim() : '';
  if (!text) return { owner_id: null, owner: null };

  if (opts.match ?? true) {
    const hit = await one<{ person_id: string; name: string }>(
      sql().query('select person_id, name from person_name_keys where key = $1', [nameKey(text)])
    );
    if (hit) return { owner_id: hit.person_id, owner: hit.name };
  }
  return { owner_id: null, owner: text };
}

/**
 * Batch name matching (one query) for AI commits and imports. Keys of the
 * returned map are nameKey(text); names with no unique match are absent.
 */
export async function resolveOwnerNames(names: string[]): Promise<Map<string, { id: string; name: string }>> {
  const keys = [...new Set(names.filter((n) => typeof n === 'string').map(nameKey).filter(Boolean))];
  const out = new Map<string, { id: string; name: string }>();
  if (!keys.length) return out;
  const rows = await many<{ key: string; person_id: string; name: string }>(
    sql().query('select key, person_id, name from person_name_keys where key = any($1::text[])', [keys])
  );
  for (const r of rows) out.set(r.key, { id: r.person_id, name: r.name });
  return out;
}

/**
 * Queries that rewrite the owner text on every item a person owns; run them
 * in the same transaction as a rename:
 *   await sql().transaction([renameQuery, ...syncOwnerNameQueries(id, name)])
 */
export function syncOwnerNameQueries(personId: string, name: string): NeonQueryPromise<false, false>[] {
  return OWNER_COLUMNS.map((c) =>
    sql().query(`update ${c.table} set ${c.text} = $1 where ${c.id} = $2`, [name, personId])
  );
}

/**
 * The owner backfill (db/upgrades/p0-backfill-owners.sql): links free-text
 * owners to people where the id is still null and the text matches a name key,
 * rewriting the text to the canonical name. One query per OWNER_COLUMNS entry,
 * in that order; each returns the ids it updated, so
 * `(await sql().transaction(backfillOwnerQueries()))[i].length` is the count
 * for OWNER_COLUMNS[i].table.
 */
export function backfillOwnerQueries(): NeonQueryPromise<false, false>[] {
  return OWNER_COLUMNS.map((c) =>
    sql().query(
      `update ${c.table} x set ${c.id} = k.person_id, ${c.text} = k.name
       from person_name_keys k
       where x.${c.id} is null and x.${c.text} is not null and lower(btrim(x.${c.text})) = k.key
       returning x.id`
    )
  );
}

/** True while no active owner has a password, i.e. nobody can sign in as an owner (§3.7). */
export async function bootstrapOpen(): Promise<boolean> {
  const row = await one<{ open: boolean }>(
    sql()`select not exists (
      select 1 from people where role = 'owner' and active and password_hash is not null
    ) as open`
  );
  return row?.open === true;
}
