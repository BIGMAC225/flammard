// Netlify background function: runs one meeting's transcript analysis.
// Background functions answer 202 at once and may run up to 15 minutes,
// so slow models (NVIDIA Kimi K3 on a long transcript) finish instead of
// being cut off at the 60s limit of normal page requests.
//
// Called only by POST /api/meetings/[id]/analyze with a signature derived
// from SESSION_SECRET; the result (or the error) is saved on the meeting and
// the page polls GET /api/meetings/[id]/analyze for it.

import { runMeetingAnalysis, verifyJob } from '../../src/lib/analyze-meeting';

interface HandlerEvent {
  body: string | null;
  headers: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event: HandlerEvent) => {
  let meetingId = '';
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body ?? '';
    meetingId = String((JSON.parse(raw || '{}') as { meeting_id?: unknown }).meeting_id ?? '');
  } catch {
    /* handled below */
  }
  if (!UUID.test(meetingId)) {
    console.log('[analyze-job] rejected: bad meeting id');
    return;
  }
  const signature = event.headers['x-flammard-job'] ?? event.headers['X-Flammard-Job'];
  if (!verifyJob(meetingId, signature)) {
    console.log('[analyze-job] rejected: bad signature');
    return;
  }

  const started = Date.now();
  try {
    await runMeetingAnalysis(meetingId);
    console.log(`[analyze-job] ${meetingId} done in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.log(`[analyze-job] ${meetingId} failed after ${Math.round((Date.now() - started) / 1000)}s: ${err instanceof Error ? err.message : err}`);
  }
};
