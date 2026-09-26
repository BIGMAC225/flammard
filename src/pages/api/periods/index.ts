import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';
import { isIsoDate } from '../../../lib/dates';

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { name, start_date, end_date } = await readBody(request);
  if (typeof name !== 'string' || !name.trim()) return json({ error: 'Name required' }, 400);
  if (!isIsoDate(start_date) || !isIsoDate(end_date) || end_date < start_date) return json({ error: 'Valid start and end dates required' }, 400);

  const team = currentTeam(cookies);
  try {
    const period = await one(sql()`
      insert into periods (team, name, start_date, end_date) values (${team}, ${name.trim()}, ${start_date}, ${end_date})
      returning id, team, name, start_date::text as start_date, end_date::text as end_date, created_at
    `);
    return json({ period });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/periods_team_name_key/.test(message)) return json({ error: 'A period with that name already exists' }, 409);
    return json({ error: message || 'Could not create period' }, 500);
  }
};
