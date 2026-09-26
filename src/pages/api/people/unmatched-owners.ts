import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { many, sql } from '../../../lib/db';
import { nameKey, OWNER_COLUMNS } from '../../../lib/people';
import { getSettings } from '../../../lib/settings';

// GET /api/people/unmatched-owners → { items, text_only_owner_names }
// Each distinct owner text (case-insensitive, trimmed) that isn't linked to a
// person, with counts per table. `kept` marks names an admin chose to leave as
// text (company_settings.text_only_owner_names), e.g. a consultant.

interface UnmatchedItem {
  text: string;
  key: string;
  counts: Record<string, number>;
  total: number;
  kept: boolean;
}

export const GET: APIRoute = async () => {
  const union = OWNER_COLUMNS.map(
    (c) =>
      `select '${c.table}' as tbl, lower(btrim(${c.text})) as key, min(btrim(${c.text})) as text, count(*)::int as n
       from ${c.table}
       where ${c.id} is null and ${c.text} is not null and btrim(${c.text}) <> ''
       group by lower(btrim(${c.text}))`
  ).join('\nunion all\n');

  const [rows, settings] = await Promise.all([
    many<{ tbl: string; key: string; text: string; n: number }>(sql().query(union)),
    getSettings(),
  ]);

  const kept = new Set(settings.text_only_owner_names.map(nameKey));
  const byKey = new Map<string, UnmatchedItem>();
  for (const r of rows) {
    const item = byKey.get(r.key) ?? { text: r.text, key: r.key, counts: {}, total: 0, kept: kept.has(r.key) };
    item.counts[r.tbl] = (item.counts[r.tbl] ?? 0) + Number(r.n);
    item.total += Number(r.n);
    byKey.set(r.key, item);
  }
  const items = [...byKey.values()].sort((a, b) => b.total - a.total || a.text.localeCompare(b.text));
  return json({ items, text_only_owner_names: settings.text_only_owner_names });
};
