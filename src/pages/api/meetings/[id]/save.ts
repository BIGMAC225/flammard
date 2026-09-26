import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import type { Decision, ActionItem, DiscussionPoint } from '../../../../types';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; status: string }>(params.id, 'id, status');
  if (!meeting) return notFound();

  const { summary, decisions, actions, discussion } = (await request.json()) as {
    summary: string;
    decisions: Decision[];
    actions: ActionItem[];
    discussion: DiscussionPoint[];
  };

  const db = sql();
  // Upsert — creates on first save, updates on subsequent saves
  await db`
    insert into minutes (meeting_id, summary, decisions, actions, discussion)
    values (${meeting.id}, ${summary ?? null}, ${JSON.stringify(decisions ?? [])}::jsonb,
            ${JSON.stringify(actions ?? [])}::jsonb, ${JSON.stringify(discussion ?? [])}::jsonb)
    on conflict (meeting_id) do update set
      summary = excluded.summary, decisions = excluded.decisions,
      actions = excluded.actions, discussion = excluded.discussion, updated_at = now()
  `;

  // Advance status to minutes_draft if still in draft
  if (meeting.status === 'draft') {
    await db`update meetings set status = 'minutes_draft', updated_at = now() where id = ${meeting.id}`;
  }
  return json({ ok: true });
};
