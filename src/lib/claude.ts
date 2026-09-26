import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env';
import type { MeetingAnalysis, ProposedStep, ScorecardExtraction, ScorecardMetric } from '../types';

const MODEL = 'claude-opus-5';

let _client: Anthropic | null = null;
function client(): Anthropic {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return (_client ??= new Anthropic({ apiKey }));
}

// ── Transcript → EOS meeting data ─────────────────────────────────────────

const MeetingAnalysisSchema = z.object({
  summary: z.string(),
  decisions: z.array(
    z.object({
      text: z.string(),
      mover: z.string().nullable(),
      outcome: z.enum(['approved', 'rejected', 'deferred', 'noted']),
    })
  ),
  actions: z.array(
    z.object({
      text: z.string(),
      owner: z.string().nullable(),
      due_date: z.string().nullable(),
    })
  ),
  discussion: z.array(z.object({ topic: z.string(), notes: z.string() })),
  headlines: z.array(
    z.object({
      type: z.enum(['customer', 'employee', 'general']),
      text: z.string(),
      presenter: z.string().nullable(),
    })
  ),
  rocks: z.array(
    z.object({
      title: z.string(),
      owner: z.string().nullable(),
      status: z.enum(['on_track', 'off_track', 'complete', 'dropped']),
      notes: z.string().nullable(),
    })
  ),
  todos_new: z.array(z.object({ title: z.string(), owner: z.string().nullable() })),
  todos_reviewed: z.array(
    z.object({ title: z.string(), status: z.enum(['open', 'done', 'not_done', 'dropped']) })
  ),
  issues_new: z.array(
    z.object({
      title: z.string(),
      description: z.string().nullable(),
      priority: z.enum(['low', 'medium', 'high']),
    })
  ),
  issues_solved: z.array(z.object({ title: z.string(), resolution: z.string().nullable() })),
  meeting_rating: z.number().nullable(),
  conclude_notes: z.string().nullable(),
});

export async function analyzeTranscript(
  transcript: string,
  context: {
    title: string;
    date: string;
    attendees: string[];
    openTodos: Array<{ title: string; owner: string | null }>;
    openIssues: Array<{ title: string }>;
    rocks: Array<{ title: string; owner: string | null; status: string }>;
  }
): Promise<MeetingAnalysis> {
  const system = `You turn transcripts of EOS Level 10 (L10) meetings into the team's official record. The transcript comes from speech-to-text, so names and numbers may be misheard — use the attendee list and the existing rocks, to-dos and issues to correct them when the intent is clear. Record only what was actually said; never invent items. Prefer fewer, well-phrased items over many fragments.`;

  const existing = [
    context.rocks.length
      ? `Existing rocks:\n${context.rocks.map((r) => `- ${r.title} (${r.owner ?? 'no owner'}, ${r.status})`).join('\n')}`
      : '',
    context.openTodos.length
      ? `Open to-dos from previous meetings:\n${context.openTodos.map((t) => `- ${t.title}${t.owner ? ` (${t.owner})` : ''}`).join('\n')}`
      : '',
    context.openIssues.length
      ? `Open issues:\n${context.openIssues.map((i) => `- ${i.title}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const user = `Meeting: ${context.title}
Date: ${context.date}
Attendees: ${context.attendees.join(', ') || 'unknown'}

${existing}

How to fill each field:
- summary: 2–4 sentences on purpose and key outcomes.
- decisions: things formally decided. outcome is approved / rejected / deferred / noted.
- actions: commitments that are not 7-day EOS to-dos (longer-running follow-ups). due_date as YYYY-MM-DD when stated.
- discussion: one entry per topic discussed, with the positions taken.
- headlines: customer/employee wins and good news from the segue.
- rocks: every rock that was reviewed, with the status stated in the meeting. Use the existing rock's exact title when it is the same rock.
- todos_new: 7-day to-dos created in this meeting.
- todos_reviewed: previous to-dos that were reviewed, using the exact title from the open to-do list, with done / not_done / dropped.
- issues_new: issues raised and not solved. issues_solved: issues that were solved (IDS), including previously open ones, with the resolution.
- meeting_rating: the average rating given at the end, or null. conclude_notes: cascading messages and closing notes, or null.

--- TRANSCRIPT ---
${transcript}
--- END ---`;

  const response = await client().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: zodOutputFormat(MeetingAnalysisSchema) },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Analysis was declined by the model');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Could not parse the analysis response');

  return {
    ...parsed,
    decisions: parsed.decisions.map((d, i) => ({
      id: `d${i + 1}`,
      text: d.text,
      outcome: d.outcome,
      ...(d.mover ? { mover: d.mover } : {}),
    })),
    actions: parsed.actions.map((a, i) => ({
      id: `a${i + 1}`,
      text: a.text,
      status: 'open' as const,
      ...(a.owner ? { owner: a.owner } : {}),
      ...(a.due_date ? { due_date: a.due_date } : {}),
    })),
  };
}

// ── Break a to-do / issue / rock into steps ───────────────────────────────

const BreakdownSchema = z.object({
  steps: z.array(z.object({ title: z.string(), substeps: z.array(z.string()) })),
});

const DETAIL_GUIDE: Record<1 | 2 | 3, string> = {
  1: '3–5 broad steps, no sub-steps. Each step is a meaningful chunk of work someone could own for a day or more.',
  2: '4–8 concrete steps; add 2–4 sub-steps under a step only where it genuinely has parts. Each sub-step is a single sitting of work.',
  3: 'A full checklist: 5–10 steps, most with 2–5 sub-steps down to individual actions (a call, an email, a file to open). Nothing left implicit.',
};

export async function breakDownItem(
  item: {
    kind: 'to-do' | 'issue' | 'rock';
    title: string;
    description: string | null;
    owner: string | null;
    team: string;
    meeting: string | null;
    existingSteps: string[];
  },
  detail: 1 | 2 | 3,
  note: string | null
): Promise<ProposedStep[]> {
  const system = `You help a CPA firm's leadership and management teams turn EOS ${item.kind}s into concrete next steps. The firm does tax, accounting and advisory work. Write steps as short imperative sentences that the owner could start on today, in the order they should happen. Don't pad; don't restate the item as a step.`;

  const lines = [
    `${item.kind[0].toUpperCase() + item.kind.slice(1)}: ${item.title}`,
    item.description ? `Details: ${item.description}` : '',
    item.owner ? `Owner: ${item.owner}` : '',
    `Team: ${item.team}`,
    item.meeting ? `Raised in: ${item.meeting}` : '',
    item.existingSteps.length
      ? `\nSteps already listed (don't repeat these):\n${item.existingSteps.map((s) => `- ${s}`).join('\n')}`
      : '',
    note ? `\nExtra context from the owner: ${note}` : '',
    `\nLevel of detail: ${DETAIL_GUIDE[detail]}`,
  ];
  const user = lines.filter(Boolean).join('\n');

  const response = await client().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(BreakdownSchema) },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') throw new Error('The breakdown was declined by the model');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Could not parse the breakdown response');
  return parsed.steps
    .map((s) => ({ title: s.title.trim(), substeps: s.substeps.map((x) => x.trim()).filter(Boolean) }))
    .filter((s) => s.title);
}

// ── TaxDome report → scorecard values ─────────────────────────────────────

const ScorecardExtractionSchema = z.object({
  report_title: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  values: z.array(
    z.object({
      metric_id: z.string(),
      value: z.string(),
      on_track: z.boolean().nullable(),
      notes: z.string().nullable(),
    })
  ),
  unmatched: z.array(z.object({ label: z.string(), value: z.string() })),
});

export async function extractScorecardFromReport(
  reportText: string,
  metrics: Pick<ScorecardMetric, 'id' | 'title' | 'goal' | 'unit' | 'frequency' | 'description'>[]
): Promise<ScorecardExtraction> {
  const system = `You read exported TaxDome reports (text extracted from PDF, so tables may be flattened) and pull out the numbers a CPA firm tracks on its EOS scorecard. Only report a value when the report clearly contains it; leave a metric out rather than guess.`;

  const metricList = metrics
    .map((m) => {
      const bits = [m.unit && `unit: ${m.unit}`, m.goal && `goal: ${m.goal}`, `frequency: ${m.frequency}`]
        .filter(Boolean)
        .join(', ');
      return `- id ${m.id}: "${m.title}" (${bits})${m.description ? `\n  where to find it: ${m.description}` : ''}`;
    })
    .join('\n');

  const user = `Scorecard metrics to look for:
${metricList}

For each metric found, return its id and the value as it appears (keep currency symbols and % signs). Set on_track by comparing to the goal when both are numeric, otherwise null. Put any other headline figures from the report that don't map to a metric in "unmatched" (label + value) so they can be reviewed. Dates as YYYY-MM-DD; period_end is the last day the report covers.

--- REPORT ---
${reportText}
--- END ---`;

  const response = await client().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low', format: zodOutputFormat(ScorecardExtractionSchema) },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Extraction was declined by the model');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Could not parse the extraction response');

  // Drop anything that points at a metric we didn't ask about
  const known = new Set(metrics.map((m) => m.id));
  return { ...parsed, values: parsed.values.filter((v) => known.has(v.metric_id)) };
}
