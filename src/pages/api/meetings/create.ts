import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import type { Attendee } from '../../../types';

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, date, location, attendees } = (await request.json()) as {
    title: string;
    date: string;
    location?: string;
    attendees: Attendee[];
  };
  if (!title?.trim() || !date) return json({ error: 'Title and date are required' }, 400);

  const row = await one<{ id: string }>(sql()`
    insert into meetings (title, date, location, attendees)
    values (${title.trim()}, ${date}, ${location?.trim() || null}, ${JSON.stringify(attendees ?? [])}::jsonb)
    returning id
  `);
  return json({ id: row!.id });
};
