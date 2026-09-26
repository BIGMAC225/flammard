import type { APIRoute } from 'astro';
import { json, requirePermission } from '../../../../lib/api';
import { many, sql } from '../../../../lib/db';
import { MAX_ROWS, NINETY_KINDS, TABLE_FOR_KIND, type NinetyKind } from '../../../../lib/ninety';
import { resolveOwnerNames, nameKey } from '../../../../lib/people';
import { getSettings, publicSettings } from '../../../../lib/settings';

// Import preview: the browser has parsed the XLSX files; this reports which
// rows are already imported, how the Ninety owner names match people, the
// existing periods, and existing rocks (for placing milestones). Read-only.

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requirePermission(locals, 'import.manage');
  if (denied) return denied;

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Too much data: the preview accepts up to 4 MB' }, 413);
  let body: { rows?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const rows = Array.isArray(body?.rows) ? (body.rows as Array<Record<string, unknown>>) : null;
  if (!rows) return json({ error: 'rows is required' }, 400);
  if (rows.length > MAX_ROWS) return json({ error: `Too many rows: at most ${MAX_ROWS} per import` }, 400);

  const idsByKind = new Map<NinetyKind, Set<string>>();
  const owners = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const kind = r.kind as NinetyKind;
    if (!NINETY_KINDS.includes(kind)) continue;
    if (typeof r.externalId === 'string' && r.externalId) {
      if (!idsByKind.has(kind)) idsByKind.set(kind, new Set());
      idsByKind.get(kind)!.add(r.externalId);
    }
    if (typeof r.ownerName === 'string' && r.ownerName.trim()) owners.add(r.ownerName.trim());
  }

  const db = sql();
  const existingQueries = [...idsByKind.entries()].map(([kind, ids]) =>
    many<{ kind: string; external_id: string }>(
      db.query(
        `select $1::text as kind, external_id from ${TABLE_FOR_KIND[kind]}
         where external_source = 'ninety' and external_id = any($2::text[])`,
        [kind, [...ids]]
      )
    )
  );

  const [existingLists, matches, periods, rocks, settings] = await Promise.all([
    Promise.all(existingQueries),
    resolveOwnerNames([...owners]),
    many<{ id: string; team: string; name: string; start_date: string; end_date: string }>(
      db`select id, team, name, start_date::text as start_date, end_date::text as end_date
         from periods order by team, start_date`
    ),
    many<{ id: string; team: string; title: string }>(db`select id, team, title from rocks order by created_at`),
    getSettings(),
  ]);

  const ownerMap: Record<string, { person_id: string; name: string } | null> = {};
  for (const name of owners) {
    const hit = matches.get(nameKey(name));
    ownerMap[name] = hit ? { person_id: hit.id, name: hit.name } : null;
  }
  const rocksByTitle: Record<string, Array<{ id: string; title: string }>> = { leadership: [], management: [] };
  for (const r of rocks) (rocksByTitle[r.team] ??= []).push({ id: r.id, title: r.title });

  return json({
    existing: [...new Set(existingLists.flat().map((e) => e.external_id))],
    existingKeys: existingLists.flat().map((e) => `${e.kind}:${e.external_id}`),
    owners: ownerMap,
    periods,
    rocksByTitle,
    settings: publicSettings(settings),
  });
};
