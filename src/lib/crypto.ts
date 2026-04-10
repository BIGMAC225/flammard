import type { Decision, ActionItem, DiscussionPoint } from '../types';

export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalMinutesContent(content: {
  summary: string | null;
  decisions: Decision[];
  actions: ActionItem[];
  discussion: DiscussionPoint[];
}): string {
  // Deterministic serialization — any post-approval change will produce a different hash
  return JSON.stringify(
    {
      summary: content.summary ?? '',
      decisions: content.decisions,
      actions: content.actions,
      discussion: content.discussion,
    },
    null,
    0
  );
}

export async function hashMinutes(content: Parameters<typeof canonicalMinutesContent>[0]): Promise<string> {
  return sha256(canonicalMinutesContent(content));
}

export async function hashAuditEvent(event: {
  meeting_id: string;
  event_type: string;
  actor_email: string | null;
  payload: unknown;
  prev_event_hash: string | null;
  timestamp: string;
}): Promise<string> {
  return sha256(JSON.stringify(event, null, 0));
}
