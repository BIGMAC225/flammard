import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env';
import type { MeetingAnalysis, ProposedRoadmap, ProposedStep, ScorecardExtraction, ScorecardMetric } from '../types';

const MODEL = 'claude-opus-5';

// ── Provider ──────────────────────────────────────────────────────────────
// Every AI step returns JSON checked against a zod schema. Two providers:
//   NVIDIA (build.nvidia.com, OpenAI-compatible) when NVIDIA_API_KEY is set,
//   Anthropic Claude when ANTHROPIC_API_KEY is set.
// AI_PROVIDER=nvidia|anthropic picks one when both keys exist (default nvidia).
// NVIDIA_MODEL overrides the model (default moonshotai/kimi-k3).

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_DEFAULT_MODEL = 'moonshotai/kimi-k3';

let _client: Anthropic | null = null;
function client(): Anthropic {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return (_client ??= new Anthropic({ apiKey }));
}

/** Which provider will run, or null when no key is configured. */
export function aiProvider(): 'nvidia' | 'anthropic' | null {
  const nvidia = Boolean(env('NVIDIA_API_KEY'));
  const anthropic = Boolean(env('ANTHROPIC_API_KEY'));
  const pick = (env('AI_PROVIDER') ?? '').toLowerCase();
  if (pick === 'anthropic' && anthropic) return 'anthropic';
  if (pick === 'nvidia' && nvidia) return 'nvidia';
  return nvidia ? 'nvidia' : anthropic ? 'anthropic' : null;
}

interface StructuredCall {
  system: string;
  user: string;
  maxTokens: number;
  effort: 'low' | 'medium';
  /** Used in error messages, e.g. "The analysis". */
  label: string;
}

async function structured<S extends z.ZodType>(schema: S, call: StructuredCall): Promise<z.infer<S>> {
  const provider = aiProvider();
  if (!provider) throw new Error('No AI key is configured: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in Netlify');

  if (provider === 'anthropic') {
    const response = await client().messages.parse({
      model: MODEL,
      max_tokens: call.maxTokens,
      output_config: { effort: call.effort, format: zodOutputFormat(schema as any) },
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
    });
    if (response.stop_reason === 'refusal') throw new Error(`${call.label} was declined by the model`);
    const parsed = response.parsed_output as z.infer<S> | null;
    if (!parsed) throw new Error(`Could not parse ${call.label.toLowerCase()}`);
    return parsed;
  }

  return nvidiaStructured(schema, call);
}

/**
 * Pulls the first complete JSON object out of a chat reply. Tolerates
 * reasoning blocks, code fences and prose before or after the object.
 */
function extractJson(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  let start = body.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          break; // not valid JSON from here; try the next "{"
        }
      }
    }
    start = body.indexOf('{', start + 1);
  }
  throw new Error('no JSON object in the reply');
}

async function nvidiaStructured<S extends z.ZodType>(schema: S, call: StructuredCall): Promise<z.infer<S>> {
  const key = env('NVIDIA_API_KEY')!;
  const model = env('NVIDIA_MODEL') || NVIDIA_DEFAULT_MODEL;
  const jsonSchema = z.toJSONSchema(schema);
  const system =
    `${call.system}\n\nReply with ONE JSON object and nothing else (no prose, no code fences). ` +
    `It must match this JSON Schema exactly; include every property, using null where a value is unknown:\n${JSON.stringify(jsonSchema)}`;
  const maxTokens = Math.min(call.maxTokens, Number(env('NVIDIA_MAX_TOKENS')) || 8192);

  // `guided` = the first try: low temperature plus constrained JSON decoding.
  // Some hosted models reject either (fixed sampling, no nvext), so a 400/422
  // falls back to a bare request with only the prompt's JSON instructions.
  const ask = async (messages: Array<{ role: string; content: string }>, guided: boolean) => {
    const res = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
        ...(guided ? { temperature: 0.1, nvext: { guided_json: jsonSchema } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`NVIDIA API ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }> };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error(`${call.label} was cut off (NVIDIA max_tokens ${maxTokens})`);
    return choice?.message?.content ?? '';
  };

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: call.user },
  ];

  let guided = true;
  let reply: string;
  try {
    reply = await ask(messages, guided);
  } catch (err) {
    // Some hosted models reject nvext; fall back to plain JSON prompting
    if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 422) {
      guided = false;
      reply = await ask(messages, guided);
    } else {
      throw err;
    }
  }

  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = schema.safeParse(extractJson(reply));
      if (result.success) return result.data;
      problem = result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
    } catch (err) {
      problem = err instanceof Error ? err.message : 'invalid JSON';
    }
    if (attempt === 0) {
      reply = await ask(
        [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: `That reply did not match the schema (${problem}). Send the corrected JSON object only.` },
        ],
        guided
      );
    }
  }
  throw new Error(`Could not parse ${call.label.toLowerCase()} from ${model}: ${problem}`);
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

  const parsed = await structured(MeetingAnalysisSchema, { system, user, maxTokens: 16000, effort: 'medium', label: 'The analysis' });

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

  const parsed = await structured(BreakdownSchema, { system, user, maxTokens: 4000, effort: 'low', label: 'The breakdown' });
  return parsed.steps
    .map((s) => ({ title: s.title.trim(), substeps: s.substeps.map((x) => x.trim()).filter(Boolean) }))
    .filter((s) => s.title);
}

// ── Multi-year plan (pasted or from a deck) → periods, rocks, steps ───────

const ProposedRockSchema = z.object({
  title: z.string(),
  owner: z.string().nullable(),
  notes: z.string().nullable(),
  steps: z.array(z.object({ title: z.string(), substeps: z.array(z.string()) })),
});

const RoadmapSchema = z.object({
  periods: z.array(
    z.object({
      name: z.string(),
      start_date: z.string(),
      end_date: z.string(),
      rocks: z.array(ProposedRockSchema),
    })
  ),
  unplaced: z.array(ProposedRockSchema),
});

export async function extractRoadmap(
  planText: string,
  context: { team: string; existingPeriods: Array<{ name: string; start_date: string; end_date: string }>; today: string }
): Promise<ProposedRoadmap> {
  const system = `You turn a CPA firm's multi-year plan into an EOS roadmap: planning periods, the 2–3 rocks (big goals) committed to in each period, and the milestones under each rock. The firm plans in custom periods rather than calendar quarters (for example Aug–Nov). Keep the team's own wording for names and titles; don't invent rocks or milestones that aren't in the plan.`;

  const existing = context.existingPeriods.length
    ? `Periods already defined (reuse these names and dates when the plan refers to the same span):\n${context.existingPeriods
        .map((p) => `- ${p.name}: ${p.start_date} → ${p.end_date}`)
        .join('\n')}\n\n`
    : '';

  const user = `Team: ${context.team}
Today: ${context.today}

${existing}How to fill it in:
- periods: every planning period the plan lays out, in order. name as the plan calls it (e.g. "Aug–Nov 2026"); start_date/end_date as YYYY-MM-DD covering the whole span (first day of the first month to last day of the last month). Work out the year from the plan's own headings; if a period only gives months, place it in the year that keeps the sequence moving forward from the first dated one.
- rocks: the big goals for that period, with owner when named and notes for any detail that isn't a step.
- steps: the milestones/tasks listed under a rock, in order; put finer bullets under a milestone as substeps.
- unplaced: rocks the plan mentions without tying them to a period.

--- PLAN ---
${planText}
--- END ---`;

  const parsed = await structured(RoadmapSchema, { system, user, maxTokens: 16000, effort: 'medium', label: 'The plan' });

  const clean = (r: z.infer<typeof ProposedRockSchema>) => ({
    title: r.title.trim(),
    owner: r.owner?.trim() || null,
    notes: r.notes?.trim() || null,
    steps: r.steps
      .map((s) => ({ title: s.title.trim(), substeps: s.substeps.map((x) => x.trim()).filter(Boolean) }))
      .filter((s) => s.title),
  });
  return {
    periods: parsed.periods
      .map((p) => ({ ...p, name: p.name.trim(), rocks: p.rocks.map(clean).filter((r) => r.title) }))
      .filter((p) => p.name),
    unplaced: parsed.unplaced.map(clean).filter((r) => r.title),
  };
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
  const system = `You read exported TaxDome reports: either CSV files (one per report tile, each under a "=== File: name ===" line, with the filters and date range in the header lines) or text extracted from a PDF (tables may be flattened) and pull out the numbers a CPA firm tracks on its EOS scorecard. Only report a value when the report clearly contains it; leave a metric out rather than guess.`;

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

For each metric found, return its id and the value as it appears (keep currency symbols and % signs). Set on_track by comparing to the goal when both are numeric, otherwise null. Put any other headline figures from the report that don't map to a metric in "unmatched" (label + value) so they can be reviewed. Values in CSV files are unrounded; round currency to whole dollars and percentages to one decimal. Dates as YYYY-MM-DD; period_end is the last day the report covers (for CSVs, the end of the "Last 7 Days" or "Last 1 Week" range).

--- REPORT ---
${reportText}
--- END ---`;

  const parsed = await structured(ScorecardExtractionSchema, { system, user, maxTokens: 8000, effort: 'low', label: 'The extraction' });

  // Drop anything that points at a metric we didn't ask about
  const known = new Set(metrics.map((m) => m.id));
  // …and anything the report didn't actually contain (blank values)
  return {
    ...parsed,
    values: parsed.values.filter((v) => known.has(v.metric_id) && String(v.value ?? '').trim() !== ''),
  };
}
