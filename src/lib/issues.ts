import { one, sql } from './db';
import { resolveOwner } from './people';
import type { Issue } from '../types';

export const HORIZONS = ['short', 'long'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;

/**
 * Inserts an open issue at the bottom of its list (short-term unless the body
 * says long-term). Shared by the Issues page and the meeting EOS tab. The
 * owner comes from `owner_id`, or `owner` text (auto-matched to a person).
 */
export async function insertIssue(
  body: Record<string, any>,
  team: string,
  meetingId: string | null
): Promise<{ issue: Issue } | { error: string }> {
  const { title, description, priority = 'medium', horizon = 'short' } = body;
  if (typeof title !== 'string' || !title.trim()) return { error: 'Title required' };
  if (!PRIORITIES.includes(priority)) return { error: 'Invalid priority' };
  if (!HORIZONS.includes(horizon)) return { error: 'Invalid horizon' };
  const desc = typeof description === 'string' && description.trim() ? description.trim() : null;
  const owner = await resolveOwner(body);
  if ('error' in owner) return owner;

  const issue = await one<Issue>(sql()`
    insert into issues (meeting_id, team, title, description, owner, owner_id, priority, status, horizon, rank)
    values (${meetingId}, ${team}, ${title.trim().slice(0, 500)}, ${desc}, ${owner.owner}, ${owner.owner_id}, ${priority}, 'open', ${horizon},
      (select coalesce(max(rank), 0) + 1 from issues where team = ${team} and horizon = ${horizon}))
    returning *
  `);
  return { issue: issue! };
}
