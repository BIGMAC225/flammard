import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { extractRoadmap } from '../../../lib/claude';
import { many, sql } from '../../../lib/db';
import { fileToText } from '../../../lib/extract-text';
import { streamJSON } from '../../../lib/stream-json';
import { currentTeam } from '../../../lib/teams';
import { todayLocal } from '../../../lib/dates';

const MAX_BYTES = 15 * 1024 * 1024;

// Turns an uploaded plan (.pptx/.docx/.txt/.md/.csv) or pasted text into a
// proposed roadmap. Nothing is saved — the page reviews it and posts the
// accepted parts to /api/roadmap/commit.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  let text = '';
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return json({ error: 'No file uploaded' }, 400);
      if (file.size > MAX_BYTES) return json({ error: 'File is too large (15 MB max)' }, 413);
      text = await fileToText(file.name, await file.arrayBuffer());
    } else {
      const body = (await request.json()) as { text?: string };
      text = typeof body.text === 'string' ? body.text : '';
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not read the plan' }, 400);
  }

  text = text.trim();
  if (text.length < 40) return json({ error: 'Nothing readable in that plan — try pasting the text instead' }, 422);
  if (text.length > 120_000) text = text.slice(0, 120_000);

  const team = currentTeam(cookies);
  const existingPeriods = await many<{ name: string; start_date: string; end_date: string }>(
    sql()`select name, start_date::text as start_date, end_date::text as end_date from periods where team = ${team} order by start_date`
  );

  return streamJSON(async () => {
    const roadmap = await extractRoadmap(text, { team, existingPeriods, today: todayLocal() });
    return { roadmap, chars: text.length };
  });
};
