import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth } from '../../../lib/api';
import { breakDownItem } from '../../../lib/claude';
import { STEP_PARENTS, loadStepParent, stepsFor } from '../../../lib/steps';
import { streamJSON } from '../../../lib/stream-json';
import type { StepParentType } from '../../../types';

// Proposes steps for a to-do / issue / rock. Nothing is saved — the page
// shows the proposal with checkboxes and posts the accepted ones to /api/steps.
//   POST { type, id, detail: 1|2|3, note? }
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { type, id, detail, note } = await readBody(request);
  if (!STEP_PARENTS.includes(type) || !isUuid(id)) return json({ error: 'Invalid item' }, 400);
  const level = detail === 1 || detail === 3 ? detail : 2;

  const parent = await loadStepParent(type as StepParentType, id);
  if (!parent) return json({ error: 'Item not found' }, 404);
  const existing = await stepsFor(type as StepParentType, id);

  return streamJSON(async () => {
    const steps = await breakDownItem(
      {
        kind: type === 'todo' ? 'to-do' : type,
        title: parent.title,
        description: parent.description,
        owner: parent.owner,
        team: parent.team,
        meeting: parent.meeting,
        existingSteps: existing.filter((s) => !s.parent_step_id).map((s) => s.title),
      },
      level,
      typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null
    );
    return { steps };
  });
};
