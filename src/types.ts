export type MeetingStatus = 'draft' | 'minutes_draft' | 'approved' | 'distributed';

export type InputType = 'recording' | 'upload' | 'transcript' | 'text';

export type DecisionOutcome = 'approved' | 'rejected' | 'deferred' | 'noted';

export type ActionStatus = 'open' | 'completed' | 'overdue';

export type RockStatus = 'on_track' | 'off_track' | 'complete' | 'dropped';

export type TodoStatus = 'open' | 'done' | 'not_done' | 'dropped';

export type IssueStatus = 'open' | 'solved' | 'dropped';

export type IssuePriority = 'low' | 'medium' | 'high';

export type HeadlineType = 'customer' | 'employee' | 'general';

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
  meeting_rating: number | null;
  conclude_notes: string | null;
  eos_analyzed: boolean;
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

// ── EOS Types ──────────────────────────────────────────────────────────────

export interface Rock {
  id: string;
  title: string;
  owner: string | null;
  status: RockStatus;
  quarter: string | null;
  due_date: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MeetingRock {
  id: string;
  meeting_id: string;
  rock_id: string | null;
  title: string;
  owner: string | null;
  status: RockStatus;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface Todo {
  id: string;
  meeting_id: string;
  title: string;
  owner: string | null;
  status: TodoStatus;
  resolved_meeting_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: string;
  meeting_id: string;
  title: string;
  description: string | null;
  priority: IssuePriority;
  status: IssueStatus;
  resolution: string | null;
  resolved_in_meeting_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScorecardMetric {
  id: string;
  title: string;
  owner: string | null;
  goal: string | null;
  unit: string | null;
  frequency: 'weekly' | 'monthly' | 'quarterly';
  sort_order: number;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScorecardEntry {
  id: string;
  metric_id: string;
  meeting_id: string;
  value: string | null;
  on_track: boolean | null;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface Headline {
  id: string;
  meeting_id: string;
  type: HeadlineType;
  text: string;
  presenter: string | null;
  created_by: string;
  created_at: string;
}

// ── EOS PDF Analysis Result ────────────────────────────────────────────────

export interface EOSAnalysisResult {
  meeting_date: string | null;
  meeting_title: string | null;
  team_name: string | null;
  attendees: Attendee[];
  meeting_rating: number | null;
  conclude_notes: string | null;
  headlines: Array<{ type: HeadlineType; text: string; presenter?: string }>;
  cascading_messages: string[];
  rocks: Array<{ title: string; owner?: string; status: RockStatus; notes?: string }>;
  todos_new: Array<{ title: string; owner?: string }>;
  todos_reviewed: Array<{ title: string; owner?: string; status: TodoStatus }>;
  issues_solved: Array<{ title: string; resolution?: string }>;
  issues_new: Array<{ title: string; description?: string; priority?: IssuePriority }>;
  scorecard: Array<{ title: string; owner?: string; goal?: string; value?: string; on_track?: boolean }>;
  summary: string;
}
