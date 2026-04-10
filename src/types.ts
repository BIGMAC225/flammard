export type MeetingStatus = 'draft' | 'minutes_draft' | 'approved' | 'distributed';

export type InputType = 'recording' | 'upload' | 'transcript' | 'text';

export type DecisionOutcome = 'approved' | 'rejected' | 'deferred' | 'noted';

export type ActionStatus = 'open' | 'completed' | 'overdue';

export interface Attendee {
  name: string;
  email?: string;
  role?: string;
}

export interface Decision {
  id: string;
  text: string;
  mover?: string;
  outcome: DecisionOutcome;
}

export interface ActionItem {
  id: string;
  text: string;
  owner?: string;
  due_date?: string;
  status: ActionStatus;
}

export interface DiscussionPoint {
  topic: string;
  notes: string;
}

export interface Meeting {
  id: string;
  org_id: string | null;
  title: string;
  date: string;
  location: string | null;
  attendees: Attendee[];
  input_type: InputType | null;
  transcript: string | null;
  recording_path: string | null;
  status: MeetingStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Minutes {
  id: string;
  meeting_id: string;
  summary: string | null;
  decisions: Decision[];
  actions: ActionItem[];
  discussion: DiscussionPoint[];
  version: number;
  content_hash: string | null;
  sealed_at: string | null;
  sealed_by: string | null;
  pdf_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  minutes_id: string;
  approved_by: string;
  approved_by_email: string;
  hash_at_approval: string;
  notes: string | null;
  approved_at: string;
}

export interface Distribution {
  id: string;
  minutes_id: string;
  meeting_id: string;
  recipient_email: string;
  recipient_name: string | null;
  token: string;
  sent_at: string;
  acknowledged_at: string | null;
  acknowledged_ip: string | null;
}

export interface AuditEvent {
  id: string;
  meeting_id: string;
  event_type: string;
  actor_id: string | null;
  actor_email: string | null;
  payload: Record<string, unknown> | null;
  prev_event_id: string | null;
  event_hash: string;
  created_at: string;
}
