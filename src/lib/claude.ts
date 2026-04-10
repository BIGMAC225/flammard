import Anthropic from '@anthropic-ai/sdk';
import type { Decision, ActionItem, DiscussionPoint } from '../types';

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
