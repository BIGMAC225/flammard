import { todayLocal } from './dates';
import { many, sql } from './db';
import type { Period, Rock, TeamId } from '../types';

// A rock on the roadmap stays 'planned' (a candidate) until the team adopts
// it as a Rock at the quarterly session: "Adopt as Rock" on the roadmap and
// rocks pages (PATCH /api/rocks/[id] with status on_track, an owner and a
// due date). Nothing switches a rock on by itself.

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
