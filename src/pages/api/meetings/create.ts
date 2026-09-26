import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam, isTeam } from '../../../lib/teams';
import type { Attendee } from '../../../types';

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, date, location, attendees, team: postedTeam } = (await request.json()) as {
    title: string;
    date: string;
    location?: string;
    attendees: Attendee[];
    team?: string;
  };
  if (!title?.trim() || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Title and date are required' }, 400);

  // The form posts the team the page showed, so a switch in another tab can't misfile it
  const team = isTeam(postedTeam) ? postedTeam : currentTeam(cookies);
  const row = await one<{ id: string }>(sql()`
    insert into meetings (team, title, date, location, attendees)
    values (${team}, ${title.trim()}, ${date}, ${location?.trim() || null}, ${JSON.stringify(attendees ?? [])}::jsonb)
    returning id
  `);
  return json({ id: row!.id });
};
