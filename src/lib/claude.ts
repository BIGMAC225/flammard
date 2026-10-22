import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { env } from './env';
import { chatCompletion, extractJson, selectProvider } from './openai-compat';
import type { AiProvider, ChatEndpoint } from './openai-compat';
import type { MeetingAnalysis, ProposedRoadmap, ProposedStep, ScorecardExtraction, ScorecardMetric } from '../types';

export type { AiProvider } from './openai-compat';

const MODEL = 'claude-opus-5';

// ── Provider ──────────────────────────────────────────────────────────────
// Every AI step returns JSON checked against a zod schema. Three providers:
//   Z.ai GLM (OpenAI-compatible) when ZAI_API_KEY is set,
//   NVIDIA (build.nvidia.com, OpenAI-compatible) when NVIDIA_API_KEY is set,
//   Anthropic Claude when ANTHROPIC_API_KEY is set.
// AI_PROVIDER=zai|nvidia|anthropic picks one when several keys exist
// (default zai, then nvidia, then anthropic).
// ZAI_MODEL overrides the Z.ai model (default glm-5.3), ZAI_BASE_URL the API
// root (default https://api.z.ai/api/paas/v4) and ZAI_MAX_TOKENS the reply
// cap (default 16000). NVIDIA_MODEL overrides the NVIDIA model (default
// nvidia/nemotron-3-super-120b-a12b; the previous default, moonshotai/kimi-k3,
// was retired by NVIDIA on 2026-10-15).
// The step breakdown must answer inside a normal 60s page request, so it has
// its own model: ZAI_BREAKDOWN_MODEL (default glm-5.3-flash, below),
// NVIDIA_BREAKDOWN_MODEL (default nemotron-3-super, below) or
// ANTHROPIC_BREAKDOWN_MODEL (default the Claude model above).

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
// Kimi K3 (the old default, since retired) took 163–250s per breakdown on the
// free API (2026-10-06); this one took 3–16s at every detail level with
// schema-valid output.
const NVIDIA_BREAKDOWN_DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
const ZAI_DEFAULT_MODEL = 'glm-5.3';
const ZAI_BREAKDOWN_DEFAULT_MODEL = 'glm-5.3-flash';

let _client: Anthropic | null = null;
function client(): Anthropic {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return (_client ??= new Anthropic({ apiKey }));
}

/** Which provider will run, or null when no key is configured. */
export function aiProvider(): AiProvider | null {
  return selectProvider(env);
}

interface StructuredCall {
  system: string;
  user: string;
  maxTokens: number;
  effort: 'low' | 'medium';
  /** Used in error messages, e.g. "The analysis". */
  label: string;
  /**
   * Overrides the provider's model for this call (an id for whichever
   * provider is active). Unset = the provider default.
   */
  model?: string;
  /**
   * Wall-clock limit for the whole call, every attempt and retry included.
   * Set it for calls made inside a normal page request, which Netlify kills
   * at 60s; leave it unset for calls in the background function.
   */
  deadlineMs?: number;
  /** Shown when the deadline passes. */
  timeoutMessage?: string;
}

async function structured<S extends z.ZodType>(schema: S, call: StructuredCall): Promise<z.infer<S>> {
  const provider = aiProvider();
  if (!provider) throw new Error('No AI key is configured: set ZAI_API_KEY (or NVIDIA_API_KEY / ANTHROPIC_API_KEY) in Netlify');

  const run = (signal?: AbortSignal) =>
    provider === 'anthropic'
      ? anthropicStructured(schema, call, signal)
      : openaiStructured(schema, call, provider === 'zai' ? zaiEndpoint(call) : nvidiaEndpoint(schema, call), signal);
  if (!call.deadlineMs) return run();

  // One deadline over everything: the SDK's timeout is per attempt and NVIDIA's
  // path makes up to three requests, so neither bounds the total on its own.
  const timeoutMessage = call.timeoutMessage ?? `${call.label} took too long. Try again.`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, call.deadlineMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } catch (err) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function anthropicStructured<S extends z.ZodType>(
  schema: S,
  call: StructuredCall,
  signal?: AbortSignal
): Promise<z.infer<S>> {
  const model = call.model || MODEL;
  // `create`, not `parse`: `parse` validates the JSON before stop_reason can be
  // checked, so a cut-off answer would surface as a JSON syntax error
  const format = zodOutputFormat(schema as any);
  const response = await client().messages.create(
    {
      model,
      max_tokens: call.maxTokens,
      // Haiku 4.5 rejects `effort`
      output_config: { ...(model.startsWith('claude-haiku') ? {} : { effort: call.effort }), format },
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
    },
    // With a deadline, one retry at most: the deadline is the real bound
    signal ? { signal, maxRetries: 1 } : undefined
  );
  if (response.stop_reason === 'refusal') throw new Error(`${call.label} was declined by the model`);
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`${call.label} was cut off (Claude max_tokens ${call.maxTokens})`);
  }
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) throw new Error(`Could not parse ${call.label.toLowerCase()}`);
  return format.parse(text) as z.infer<S>;
}

/** Models that answered the guided request with a 400/422 (per warm instance). */
const UNGUIDED_MODELS = new Set<string>();

function nvidiaEndpoint(schema: z.ZodType, call: StructuredCall): ChatEndpoint {
  return {
    name: 'NVIDIA',
    url: NVIDIA_URL,
    key: env('NVIDIA_API_KEY')!,
    model: call.model || env('NVIDIA_MODEL') || NVIDIA_DEFAULT_MODEL,
    requestTimeoutMs: 180_000,
    guidedBody: {
      temperature: 0.1,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: z.toJSONSchema(schema) } },
    },
  };
}

function zaiEndpoint(call: StructuredCall): ChatEndpoint {
  const base = (env('ZAI_BASE_URL') || ZAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    name: 'Z.ai',
    url: `${base}/chat/completions`,
    key: env('ZAI_API_KEY')!,
    model: call.model || env('ZAI_MODEL') || ZAI_DEFAULT_MODEL,
    requestTimeoutMs: 300_000,
    extraBody: { thinking: { type: call.effort === 'low' ? 'disabled' : 'enabled' } },
    guidedBody: { temperature: 0.1, response_format: { type: 'json_object' } },
  };
}

async function openaiStructured<S extends z.ZodType>(
  schema: S,
  call: StructuredCall,
  endpoint: ChatEndpoint,
  signal?: AbortSignal
): Promise<z.infer<S>> {
  const jsonSchema = z.toJSONSchema(schema);
  const system =
    `${call.system}\n\nReply with ONE JSON object and nothing else (no prose, no code fences). ` +
    `It must match this JSON Schema exactly; include every property, using null where a value is unknown:\n${JSON.stringify(jsonSchema)}`;
  const zai = endpoint.name === 'Z.ai';
  const maxTokens = Math.min(call.maxTokens, Number(env(zai ? 'ZAI_MAX_TOKENS' : 'NVIDIA_MAX_TOKENS')) || (zai ? 16_000 : 8_192));

  // `guided` = the first try: low temperature plus constrained JSON decoding
  // through the OpenAI-standard `response_format`. (The older
  // `nvext.guided_json` is rejected as an unknown field by most hosted models,
  // and the 400 can take as long as a full answer to come back.) A model that
  // still rejects it gets a 400/422, falls back to a bare request with only
  // the prompt's JSON instructions, and is remembered so later calls in this
  // instance skip the wasted round trip.
  const ask = async (messages: Array<{ role: string; content: string }>, guided: boolean) => {
    const { text, finishReason } = await chatCompletion(endpoint, messages, maxTokens, guided, signal);
    if (finishReason === 'length') throw new Error(`${call.label} was cut off (${endpoint.name} max_tokens ${maxTokens})`);
    return text;
  };

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: call.user },
  ];

  const unguidedKey = `${endpoint.name}:${endpoint.model}`;
  let guided = !UNGUIDED_MODELS.has(unguidedKey);
  let reply: string;
  try {
    reply = await ask(messages, guided);
  } catch (err) {
    // Some hosted models reject response_format or temperature; fall back to plain JSON prompting
    if (guided && ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 422)) {
      UNGUIDED_MODELS.add(unguidedKey);
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
      const snippet = reply.trim().slice(0, 120).replace(/\s+/g, ' ');
      problem = `${err instanceof Error ? err.message : 'invalid JSON'} (reply was ${reply.length} chars${snippet ? `: "${snippet}…"` : ''})`;
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
  throw new Error(`Could not parse ${call.label.toLowerCase()} from ${endpoint.model}: ${problem}`);
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
      rock_id: z.string().nullable(),
      title: z.string(),
      owner: z.string().nullable(),
      status: z.enum(['on_track', 'off_track', 'complete', 'dropped']),
      notes: z.string().nullable(),
    })
  ),
  todos_new: z.array(z.object({ title: z.string(), owner: z.string().nullable() })),
  todos_reviewed: z.array(
    z.object({ todo_id: z.string().nullable(), title: z.string(), status: z.enum(['open', 'done', 'not_done', 'dropped']) })
  ),
  issues_new: z.array(
    z.object({
      title: z.string(),
      description: z.string().nullable(),
      priority: z.enum(['low', 'medium', 'high']),
    })
  ),
  issues_solved: z.array(z.object({ issue_id: z.string().nullable(), title: z.string(), resolution: z.string().nullable() })),
  meeting_rating: z.number().nullable(),
  conclude_notes: z.string().nullable(),
});

export async function analyzeTranscript(
  transcript: string,
  context: {
    title: string;
    date: string;
    attendees: string[];
    openTodos: Array<{ id: string; title: string; owner: string | null }>;
    openIssues: Array<{ id: string; title: string }>;
    rocks: Array<{ id: string; title: string; owner: string | null; status: string }>;
  }
): Promise<MeetingAnalysis> {
  const system = `You turn transcripts of EOS Level 10 (L10) meetings into the team's official record. The transcript comes from speech-to-text, so names and numbers may be misheard — use the attendee list and the existing rocks, to-dos and issues to correct them when the intent is clear. Record only what was actually said; never invent items. Prefer fewer, well-phrased items over many fragments.`;

  // Each existing item carries its id so the model can point at it exactly
  // (the commit matches by id, never by title)
  const existing = [
    context.rocks.length
      ? `Existing rocks (id — title):\n${context.rocks.map((r) => `- ${r.id} — ${r.title} (${r.owner ?? 'no owner'}, ${r.status})`).join('\n')}`
      : '',
    context.openTodos.length
      ? `Open to-dos from previous meetings (id — title):\n${context.openTodos.map((t) => `- ${t.id} — ${t.title}${t.owner ? ` (${t.owner})` : ''}`).join('\n')}`
      : '',
    context.openIssues.length
      ? `Open issues (id — title):\n${context.openIssues.map((i) => `- ${i.id} — ${i.title}`).join('\n')}`
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
- rocks: every rock that was reviewed, with the status stated in the meeting. When it is an existing rock, copy its id into rock_id and use its exact title; rock_id is null only for a rock that is genuinely new.
- todos_new: 7-day to-dos created in this meeting.
- todos_reviewed: previous to-dos that were reviewed, with done / not_done / dropped. Copy the to-do's id into todo_id and use its exact title from the open to-do list.
- issues_new: issues raised and not solved. issues_solved: issues that were solved (IDS), with the resolution. For a previously open issue copy its id into issue_id; issue_id is null for an issue raised and solved in the same meeting.
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
  const system = `You help a CPA firm's leadership and management teams turn EOS ${item.kind}s into concrete next steps. The firm does tax, accounting and advisory work. Write steps as short imperative sentences that the owner could start on today, in the order they should happen. Don't pad; don't restate the item as a step.

Thinking adds latency and should only be used when it will meaningfully improve answer quality. When in doubt, respond directly.`;

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

  // Runs inside the page request (Netlify kills it at 60s, DB reads included),
  // so it gets a hard 45s budget and a message the owner can act on
  const provider = aiProvider();
  const parsed = await structured(BreakdownSchema, {
    system,
    user,
    maxTokens: 16000,
    effort: 'low',
    label: 'The breakdown',
    model:
      provider === 'anthropic'
        ? env('ANTHROPIC_BREAKDOWN_MODEL')?.trim() || undefined
        : provider === 'zai'
          ? env('ZAI_BREAKDOWN_MODEL')?.trim() || ZAI_BREAKDOWN_DEFAULT_MODEL
          : env('NVIDIA_BREAKDOWN_MODEL')?.trim() || NVIDIA_BREAKDOWN_DEFAULT_MODEL,
    deadlineMs: 45_000,
    timeoutMessage: 'The AI took too long to answer (45s). Try again, or pick a lower level of detail.',
  });
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
      // null when the model lists a metric it could not find; dropped below
      value: z.string().nullable(),
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
    values: parsed.values.filter(
      (v): v is typeof v & { value: string } => known.has(v.metric_id) && typeof v.value === 'string' && v.value.trim() !== ''
    ),
  };
}
