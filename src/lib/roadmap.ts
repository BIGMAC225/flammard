import { todayLocal } from './dates';
import { many, sql } from './db';
import type { Period, Rock, TeamId } from '../types';

/**
 * A planned rock becomes "on track" the day its period starts. Run before
 * anything that only looks at active rocks (roadmap, rocks page, dashboard,
 * the analyzer's context).
 */
export async function activateDueRocks(team: TeamId): Promise<void> {
  await sql()`
    update rocks r set status = 'on_track', updated_at = now()
    from periods p
    where r.period_id = p.id and r.team = ${team} and r.status = 'planned' and p.start_date <= ${todayLocal()}::date
  `;
}

export interface RoadmapRock extends Rock {
  steps_total: number;
  steps_done: number;
}

export interface RoadmapPeriod extends Period {
  rocks: RoadmapRock[];
  /** 'past' | 'current' | 'future' relative to today */
  when: 'past' | 'current' | 'future';
}

/** Periods (with their rocks and step progress) for a team, oldest first. */
export async function loadRoadmap(team: TeamId): Promise<{ periods: RoadmapPeriod[]; unplaced: RoadmapRock[] }> {
  await activateDueRocks(team);
  const db = sql();
  const [periods, rocks] = await Promise.all([
    many<Period>(db`
      select id, team, name, start_date::text as start_date, end_date::text as end_date, created_at
      from periods where team = ${team} order by start_date, name
    `),
    many<RoadmapRock>(db`
      select r.*, r.due_date::text as due_date,
             (select count(*)::int from steps s where s.parent_type = 'rock' and s.parent_id = r.id) as steps_total,
             (select count(*)::int from steps s where s.parent_type = 'rock' and s.parent_id = r.id and s.done) as steps_done
      from rocks r where r.team = ${team}
      order by r.status = 'dropped', r.created_at
    `),
  ]);

  const today = todayLocal();
  const byPeriod = new Map<string, RoadmapRock[]>();
  const unplaced: RoadmapRock[] = [];
  for (const r of rocks) {
    if (r.period_id) (byPeriod.get(r.period_id) ?? byPeriod.set(r.period_id, []).get(r.period_id)!).push(r);
    else unplaced.push(r);
  }

  return {
    periods: periods.map((p) => ({
      ...p,
      rocks: byPeriod.get(p.id) ?? [],
      when: p.end_date < today ? 'past' : p.start_date > today ? 'future' : 'current',
    })),
    unplaced,
  };
}
