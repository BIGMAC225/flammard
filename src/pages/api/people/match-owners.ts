import type { APIRoute } from 'astro';
import { isUuid, json, readBody } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { nameKey, OWNER_COLUMNS } from '../../../lib/people';

// POST /api/people/match-owners { text, person_id, add_alias? } → { updated, counts }
// Links every unlinked item whose owner text is `text` (case-insensitive,
// trimmed) to the person and rewrites the text to their name. With add_alias
// the text is remembered as an alias, so it matches automatically from now on.
// The name also leaves the "kept as text" list if it was there. One transaction.

export const POST: APIRoute = async ({ request }) => {
  const { text, person_id, add_alias } = await readBody(request);
  if (typeof text !== 'string' || !text.trim() || text.length > 200) return json({ error: 'Invalid owner text' }, 400);
  if (!isUuid(person_id)) return json({ error: 'Choose a person' }, 400);

  const person = await one<{ id: string; name: string }>(
    sql().query('select id, name from people where id = $1 and active', [person_id])
  );
  if (!person) return json({ error: 'Person not found or inactive' }, 404);

  const key = nameKey(text);
  const alias = text.trim();
  const queries = [
    ...OWNER_COLUMNS.map((c) =>
      sql().query(
        `update ${c.table} set ${c.id} = $1, ${c.text} = $2
         where ${c.id} is null and ${c.text} is not null and lower(btrim(${c.text})) = $3
         returning id`,
        [person.id, person.name, key]
      )
    ),
    sql().query(
      `update company_settings
       set text_only_owner_names = array(select n from unnest(text_only_owner_names) n where lower(btrim(n)) <> $1)
       where id and exists (select 1 from unnest(text_only_owner_names) n where lower(btrim(n)) = $1)`,
      [key]
    ),
  ];
  if (add_alias === true) {
    queries.push(
      sql().query(
        `update people set aliases = array_append(aliases, $2), updated_at = now()
         where id = $1 and lower(btrim(name)) <> $3
           and not exists (select 1 from unnest(aliases) a where lower(btrim(a)) = $3)`,
        [person.id, alias, key]
      )
    );
  }

  const results = await sql().transaction(queries);
  const counts: Record<string, number> = {};
  let updated = 0;
  OWNER_COLUMNS.forEach((c, i) => {
    const n = (results[i] as unknown[]).length;
    counts[c.table] = n;
    updated += n;
  });
  return json({ updated, counts });
};
