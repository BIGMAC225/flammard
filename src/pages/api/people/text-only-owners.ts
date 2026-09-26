import type { APIRoute } from 'astro';
import { json, principal, readBody } from '../../../lib/api';
import { one, sql } from '../../../lib/db';

// POST /api/people/text-only-owners { text, keep } → { names }
// "Leave as text (no account)": adds the owner name to (keep: true) or removes
// it from (keep: false) company_settings.text_only_owner_names, compared
// case-insensitively. Items are not changed.
export const POST: APIRoute = async ({ request, locals }) => {
  const { text, keep } = await readBody(request);
  if (typeof text !== 'string' || !text.trim() || text.length > 200) return json({ error: 'Invalid owner text' }, 400);
  if (typeof keep !== 'boolean') return json({ error: 'keep must be true or false' }, 400);

  const name = text.trim();
  const row = await one<{ text_only_owner_names: string[] }>(
    sql().query(
      `update company_settings set
         text_only_owner_names = case
           when $2 then
             case when exists (select 1 from unnest(text_only_owner_names) n where lower(btrim(n)) = lower($1))
                  then text_only_owner_names
                  else array_append(text_only_owner_names, $1::text) end
           else array(select n from unnest(text_only_owner_names) n where lower(btrim(n)) <> lower($1))
         end,
         updated_by = $3
       where id
       returning text_only_owner_names`,
      [name, keep, principal(locals).id]
    )
  );
  if (!row) return json({ error: 'Company settings are missing. Run db/upgrades/p0-foundation.sql.' }, 500);
  return json({ names: row.text_only_owner_names });
};
