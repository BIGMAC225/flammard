import Anthropic from '@anthropic-ai/sdk';
import type { Decision, ActionItem, DiscussionPoint, EOSAnalysisResult } from '../types';

const client = new Anthropic({
  apiKey: import.meta.env.ANTHROPIC_API_KEY,
});

export interface DraftedMinutes {
  summary: string;
  decisions: Decision[];
  actions: ActionItem[];
  discussion: DiscussionPoint[];
}

export async function draftMinutes(
  input: string,
  context: {
    title: string;
    date: string;
    attendees?: string[];
  }
): Promise<DraftedMinutes> {
  const attendeeList = context.attendees?.length
    ? `Attendees: ${context.attendees.join(', ')}`
    : '';

  const systemPrompt = `You are a professional meeting secretary with expertise in corporate governance and formal meeting records. Your job is to extract structured, formal minutes from meeting content — not to summarize, but to produce an accurate record.`;

  const userPrompt = `Extract formal meeting minutes from the following content.

Meeting: ${context.title}
Date: ${context.date}
${attendeeList}

--- MEETING CONTENT ---
${input}
--- END ---

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "summary": "2-3 sentence executive summary of the meeting purpose and key outcomes",
  "decisions": [
    {
      "id": "d1",
      "text": "Precise statement of what was formally decided",
      "mover": "Name of person who proposed (omit key if not mentioned)",
      "outcome": "approved"
    }
  ],
  "actions": [
    {
      "id": "a1",
      "text": "Clear, actionable description of the task",
      "owner": "Name of responsible person (omit key if not mentioned)",
      "due_date": "YYYY-MM-DD (omit key if not mentioned)",
      "status": "open"
    }
  ],
  "discussion": [
    {
      "topic": "Discussion topic heading",
      "notes": "Key points raised, positions taken, context provided"
    }
  ]
}

Decision outcomes must be one of: "approved", "rejected", "deferred", "noted"
Action statuses must be: "open"
Only include content that was actually discussed — do not invent or embellish.
IDs should be d1, d2, d3... for decisions and a1, a2, a3... for actions.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response from Claude');

  // Strip markdown code fences if Claude wraps anyway
  const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(raw) as DraftedMinutes;
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${raw.slice(0, 200)}`);
  }
}

export async function analyzeEOSDocument(pdfText: string): Promise<EOSAnalysisResult> {
  const systemPrompt = `You are an expert in the Entrepreneurial Operating System (EOS) L10 meeting format used by companies running on EOS/Traction. You specialize in extracting structured data from Ninety.io meeting recap documents and similar EOS meeting reports.

EOS L10 meetings follow this structure:
1. Segue / Headlines (customer wins, employee wins, good news)
2. Scorecard review (weekly measurables with goals and actuals)
3. Rock review (quarterly goals: on track / off track)
4. Customer/Employee Headlines
5. To-Do list review (previous week's 7-day action items: done / not done)
6. IDS - Issues, Discuss, Solve (problems identified and resolved)
7. Conclude (new to-dos, cascading messages, meeting rating)`;

  const userPrompt = `Analyze the following EOS meeting recap document and extract all structured data.

--- DOCUMENT ---
${pdfText}
--- END ---

Return ONLY a valid JSON object matching this exact structure (no markdown, no explanation):
{
  "meeting_date": "YYYY-MM-DD or null",
  "meeting_title": "Title of the meeting or null",
  "team_name": "Team/company name or null",
  "attendees": [{"name": "Full Name", "email": "optional@email.com", "role": "optional role"}],
  "meeting_rating": 8.5,
  "conclude_notes": "Any conclude/closing notes or null",
  "headlines": [
    {"type": "customer", "text": "Headline text", "presenter": "Name or omit"}
  ],
  "cascading_messages": ["message 1", "message 2"],
  "rocks": [
    {"title": "Rock title", "owner": "Name", "status": "on_track", "notes": "optional notes"}
  ],
  "todos_new": [
    {"title": "New to-do created at this meeting", "owner": "Name"}
  ],
  "todos_reviewed": [
    {"title": "To-do reviewed from last week", "owner": "Name", "status": "done"}
  ],
  "issues_solved": [
    {"title": "Issue title", "resolution": "How it was resolved"}
  ],
  "issues_new": [
    {"title": "New issue raised", "description": "optional details", "priority": "medium"}
  ],
  "scorecard": [
    {"title": "Metric name", "owner": "Name", "goal": "target value", "value": "actual value", "on_track": true}
  ],
  "summary": "2-3 sentence summary of the meeting's key outcomes and decisions"
}

Rules:
- Rock status must be one of: "on_track", "off_track", "complete", "dropped"
- Todo status must be one of: "open", "done", "not_done", "dropped"
- Issue priority must be one of: "low", "medium", "high"
- Headline type must be one of: "customer", "employee", "general"
- If a section has no items, use an empty array []
- Only extract what is explicitly in the document — do not invent data
- For meeting_rating, extract the average/overall rating if shown, or null`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response from Claude');

  const raw = block.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(raw) as EOSAnalysisResult;
  } catch {
    throw new Error(`Failed to parse EOS analysis response: ${raw.slice(0, 300)}`);
  }
}
