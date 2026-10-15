import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum, requireUuid } from '../../../lib/api';
import { buildUpdate, one, sql } from '../../../lib/db';
import { isIsoDate } from '../../../lib/dates';
import { resolveOwner } from '../../../lib/people';
import { quarterEndFor, rockLoadWarning } from '../../../lib/rocks';

const STATUSES = ['planned', 'on_track', 'off_track', 'complete', 'dropped'];
const LEVELS = ['company', 'individual'];
const OUTCOMES = ['done', 'not_done'];

// Edits a team rock. Owner and due date can be changed but never cleared.
// Adopting a planned rock (status → on_track) fills a missing due date with
// the end of the current firm quarter. `outcome` is the quarter-end call:
// 'done' also marks the rock complete; 'not_done' leaves its status alone so
// the team can carry it into the next quarter or drop it.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;

  const body = await readBody(request);
  // outcome: null clears the quarter-end call
  const invalid = requireEnum(body, 'status', STATUSES) ?? (body.outcome === null ? null : requireEnum(body, 'outcome', OUTCOMES));
  if (invalid) return invalid;
  if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return json({ error: 'Title required' }, 400);
  if ('period_id' in body && body.period_id !== null && !isUuid(body.period_id)) return json({ error: 'Invalid period' }, 400);
  if ('due_date' in body && body.due_date !== null && !isIsoDate(body.due_date)) return json({ error: 'Invalid due date' }, 400);
  if ('level' in body && body.level !== null && !LEVELS.includes(body.level)) return json({ error: 'Invalid level' }, 400);

  const rock = await one<{ team: string; owner_id: string | null; due_date: string | null; status: string }>(
    sql()`select team, owner_id, due_date::text as due_date, status from rocks where id = ${params.id!}`
  );
  if (!rock) return json({ error: 'Not found' }, 404);

  if (isUuid(body.period_id)) {
    const period = await one<{ team: string }>(sql()`select team from periods where id = ${body.period_id}`);
    if (!period) return json({ error: 'Period not found' }, 404);
    if (period.team !== rock.team) return json({ error: 'That period belongs to the other team' }, 400);
  }
  for (const k of ['title', 'notes', 'quarter'] as const) {
    if (typeof body[k] === 'string') body[k] = body[k].trim() || null;
  }
  // Owner: an id (or text from an old client, auto-matched) sets both columns; never cleared
  if ('owner' in body || 'owner_id' in body) {
    const owner = await resolveOwner(body);
    if ('error' in owner) return json({ error: owner.error }, 400);
    if (!owner.owner) return json({ error: 'Every rock needs one owner' }, 400);
    Object.assign(body, owner);
  }
  if ('due_date' in body && body.due_date === null) return json({ error: 'Every rock needs a due date' }, 400);

  // Adopting as a Rock: needs an owner, and a due date (default: this quarter's end)
  const activating = (body.status === 'on_track' || body.status === 'off_track') && rock.status === 'planned';
  if (activating) {
    if (!(body.owner_id ?? rock.owner_id)) return json({ error: 'Give the rock an owner before adopting it' }, 400);
    if (!body.due_date && !rock.due_date) body.due_date = await quarterEndFor();
  }
  const extra: Record<string, unknown> = { updated_at: new Date() };
  if (body.outcome === 'done') {
    body.status = 'complete';
  }
  if ('status' in body) extra.completed_at = body.status === 'complete' ? new Date() : null;

  const update = buildUpdate(
    'rocks',
    params.id!,
    body,
    ['title', 'owner', 'owner_id', 'notes', 'status', 'period_id', 'quarter', 'due_date', 'level', 'outcome'],
    extra
  );
  if (!update) return json({ error: 'Nothing to update' }, 400);
  const [saved] = await sql().query(`${update.text}, due_date::text as due_date`, update.params);
  if (!saved) return json({ error: 'Not found' }, 404);
  const warning = await rockLoadWarning(rock.team, saved.owner_id, saved.due_date, saved.id);
  return json({ rock: saved, warning });
};

// Meeting snapshots keep their copy (rock_id becomes null); steps go with it.
export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies) ?? requireUuid(params.id);
  if (denied) return denied;
  await sql().transaction([
    sql()`delete from steps where parent_type = 'rock' and parent_id = ${params.id!}`,
    sql()`delete from rocks where id = ${params.id!}`,
  ]);
  return json({ ok: true });
};
