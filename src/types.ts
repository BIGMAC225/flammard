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

export type TeamId = 'leadership' | 'management';

export interface Meeting {
  id: string;
  team: TeamId;
  title: string;
  date: string;
  location: string | null;
  attendees: Attendee[];
  input_type: InputType | null;
  transcript: string | null;
  recording_path: string | null;
  recording_parts: number | null;
  recording_mime: string | null;
  transcript_path: string | null;
  analysis: MeetingAnalysis | null;
  analysis_status: AnalysisStatus;
  analyzed_at: string | null;
  status: MeetingStatus;
  meeting_rating: number | null;
  conclude_notes: string | null;
  eos_analyzed: boolean;
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
  pdf_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  minutes_id: string;
  approved_by: string;
  hash_at_approval: string;
  notes: string | null;
  approved_at: string;
}

// ── EOS Types ──────────────────────────────────────────────────────────────

export interface Rock {
  id: string;
  team: TeamId;
  title: string;
  owner: string | null;
  status: RockStatus;
  quarter: string | null;
  due_date: string | null;
  notes: string | null;
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
  created_at: string;
}

export interface Todo {
  id: string;
  meeting_id: string;
  title: string;
  owner: string | null;
  status: TodoStatus;
  resolved_meeting_id: string | null;
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
  created_at: string;
  updated_at: string;
}

export interface ScorecardMetric {
  id: string;
  team: TeamId;
  title: string;
  owner: string | null;
  goal: string | null;
  unit: string | null;
  frequency: 'weekly' | 'monthly' | 'quarterly';
  description: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScorecardEntry {
  id: string;
  metric_id: string;
  period_date: string;
  source: 'manual' | 'taxdome';
  import_id: string | null;
  value: string | null;
  on_track: boolean | null;
  notes: string | null;
  created_at: string;
}

export interface Headline {
  id: string;
  meeting_id: string;
  type: HeadlineType;
  text: string;
  presenter: string | null;
  created_at: string;
}

// ── Meeting session analysis (transcript → structured EOS data) ────────────

export type AnalysisStatus = 'none' | 'ready' | 'committed';

export interface MeetingAnalysis {
  summary: string;
  decisions: Decision[];
  actions: ActionItem[];
  discussion: DiscussionPoint[];
  headlines: Array<{ type: HeadlineType; text: string; presenter: string | null }>;
  rocks: Array<{ title: string; owner: string | null; status: RockStatus; notes: string | null }>;
  todos_new: Array<{ title: string; owner: string | null }>;
  todos_reviewed: Array<{ title: string; status: TodoStatus }>;
  issues_new: Array<{ title: string; description: string | null; priority: IssuePriority }>;
  issues_solved: Array<{ title: string; resolution: string | null }>;
  meeting_rating: number | null;
  conclude_notes: string | null;
}

// ── TaxDome report import ──────────────────────────────────────────────────

export interface ScorecardExtraction {
  report_title: string | null;
  period_start: string | null;
  period_end: string | null;
  values: Array<{ metric_id: string; value: string; on_track: boolean | null; notes: string | null }>;
  unmatched: Array<{ label: string; value: string }>;
}

export interface TaxDomeImport {
  id: string;
  team: TeamId;
  received_at: string;
  file_name: string | null;
  report_title: string | null;
  period_start: string | null;
  period_end: string | null;
  raw_text: string | null;
  extracted: ScorecardExtraction | null;
  status: 'processed' | 'failed';
  error: string | null;
  entries_written: number;
}
