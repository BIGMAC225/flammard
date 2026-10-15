import type { APIRoute } from 'astro';
import { getMeeting, notFound, requireAuth } from '../../../../lib/api';
import { buildFiveLines } from '../../../../lib/l10';

// The meeting as five lines of markdown (rating, rocks, to-dos, issues,
// cascading messages) for pasting into chat or email. `?download=1` sends it
// as a file.
export const GET: APIRoute = async ({ params, cookies, url }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string; team: string; date: string }>(params.id, 'id, team, date::text as date');
  if (!meeting) return notFound();

  const markdown = await buildFiveLines(meeting);
  const headers: Record<string, string> = { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' };
  if (url.searchParams.get('download')) headers['Content-Disposition'] = `attachment; filename="l10-${meeting.date}.md"`;
  return new Response(markdown, { headers });
};
