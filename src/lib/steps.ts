import { many, one, sql } from './db';
import type { Step, StepParentType } from '../types';

export const STEP_PARENTS: StepParentType[] = ['todo', 'issue', 'rock'];
const TABLE: Record<StepParentType, string> = { todo: 'todos', issue: 'issues', rock: 'rocks' };

/** The parent row a step hangs off, with the fields the AI breakdown needs. */
export async function loadStepParent(type: StepParentType, id: string) {
  const db = sql();
  if (type === 'rock') {
    return one<{ id: string; title: string; description: string | null; owner: string | null; team: string; meeting: string | null }>(
      db`select id, title, notes as description, owner, team, null::text as meeting from rocks where id = ${id}`
    );
  }
  const table = TABLE[type];
  return one<{ id: string; title: string; description: string | null; owner: string | null; team: string; meeting: string | null }>(
    db.query(
      `select x.id, x.title, ${type === 'issue' ? 'x.description' : 'null::text as description'}, x.owner,
              x.team, m.title || ' · ' || m.date::text as meeting
       from ${table} x left join meetings m on m.id = x.meeting_id where x.id = $1`,
      [id]
    )
  );
}

export function stepsFor(type: StepParentType, id: string): Promise<Step[]> {
  return many<Step>(sql()`select * from steps where parent_type = ${type} and parent_id = ${id} order by sort_order, created_at`);
}

/** Steps for many parents at once (list pages), grouped by parent id. */
export async function stepsForMany(type: StepParentType, ids: string[]): Promise<Record<string, Step[]>> {
  if (!ids.length) return {};
  const rows = await many<Step>(
    sql()`select * from steps where parent_type = ${type} and parent_id = any(${ids}::uuid[]) order by sort_order, created_at`
  );
  const grouped: Record<string, Step[]> = {};
  for (const s of rows) (grouped[s.parent_id] ??= []).push(s);
  return grouped;
}
