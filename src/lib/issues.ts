import { one, sql } from './db';
import { resolveOwner } from './people';
import type { Issue } from '../types';

export const HORIZONS = ['short', 'long'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;
export const ISSUE_TYPES = ['problem', 'information', 'idea'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inserts an open issue at the bottom of its list (short-term unless the body
 * says long-term). Shared by the Issues page and the meeting EOS tab. The
 * owner comes from `owner_id`, or `owner` text (auto-matched to a person).
 *
 * `rock_id` / `headline_id` link the issue to what it dropped from (an
 * off-track rock, a headline that needs discussion). A rock or headline that
 * already has an open issue is not dropped twice: the existing issue comes
 * back with `existed: true`. `issue_type` is optional: problem, information
 * or idea.
 */
export async function insertIssue(
  body: Record<string, any>,
  team: string,
  meetingId: string | null
): Promise<{ issue: Issue; existed?: boolean } | { error: string }> {
  const { title, description, priority = 'medium', horizon = 'short', rock_id, headline_id, issue_type } = body;
  if (typeof title !== 'string' || !title.trim()) return { error: 'Title required' };
  if (!PRIORITIES.includes(priority)) return { error: 'Invalid priority' };
  if (!HORIZONS.includes(horizon)) return { error: 'Invalid horizon' };
  if (rock_id != null && !UUID.test(String(rock_id))) return { error: 'Invalid rock_id' };
  if (headline_id != null && !UUID.test(String(headline_id))) return { error: 'Invalid headline_id' };
  if (issue_type != null && !ISSUE_TYPES.includes(issue_type)) return { error: 'Invalid issue_type' };
  const desc = typeof description === 'string' && description.trim() ? description.trim() : null;
  const owner = await resolveOwner(body);
  if ('error' in owner) return owner;

  const db = sql();
  if (rock_id) {
    const rock = await one<{ id: string }>(db`select id from rocks where id = ${rock_id} and team = ${team}`);
    if (!rock) return { error: 'Rock not found on this team' };
    const open = await one<Issue>(db`select * from issues where rock_id = ${rock_id} and status = 'open' limit 1`);
    if (open) return { issue: open, existed: true };
  }
  if (headline_id) {
    const headline = await one<{ id: string }>(db`select id from headlines where id = ${headline_id} and team = ${team}`);
    if (!headline) return { error: 'Headline not found on this team' };
    const open = await one<Issue>(db`select * from issues where headline_id = ${headline_id} and status = 'open' limit 1`);
    if (open) return { issue: open, existed: true };
  }

  const issue = await one<Issue>(db`
    insert into issues (meeting_id, team, title, description, owner, owner_id, priority, status, horizon, rank, rock_id, headline_id, issue_type)
    values (${meetingId}, ${team}, ${title.trim().slice(0, 500)}, ${desc}, ${owner.owner}, ${owner.owner_id}, ${priority}, 'open', ${horizon},
      (select coalesce(max(rank), 0) + 1 from issues where team = ${team} and horizon = ${horizon}),
      ${rock_id ?? null}, ${headline_id ?? null}, ${issue_type ?? null})
    returning *
  `);
  return { issue: issue! };
}

/**
 * EOS: an issue is solved when it ends in a resolution and (usually) a to-do.
 * Marking it solved needs a resolution note or a to-do linked to it.
 */
export async function solveRequirementMet(issueId: string, resolution: unknown): Promise<boolean> {
  if (typeof resolution === 'string' && resolution.trim()) return true;
  const linked = await one<{ id: string }>(sql()`select id from todos where issue_id = ${issueId} limit 1`);
  return !!linked;
}
