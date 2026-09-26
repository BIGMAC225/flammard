import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, requireAuth } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { minutesPdf } from '../../../../lib/blobs';

export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; title: string }>(params.id, 'id, title');
  if (!meeting) return notFound();

  const minutes = await one<{ pdf_path: string | null }>(sql()`select pdf_path from minutes where meeting_id = ${meeting.id}`);
  if (!minutes?.pdf_path) return json({ error: 'PDF not found' }, 404);

  const file = await minutesPdf().get(minutes.pdf_path, { type: 'arrayBuffer' });
  if (!file) return json({ error: 'Failed to retrieve PDF' }, 500);

  const fileName = `${meeting.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-minutes.pdf`;
  return new Response(file, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
};
