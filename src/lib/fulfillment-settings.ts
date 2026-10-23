// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally;
// it is pure (no imports at all), so nothing else needs the .ts treatment.
//
// The fulfillment settings page's pure core: the stage-title classifier that
// seeded the draft stage_type_map, the posted-form parser the API validates
// with, and the page-model shaper. The page (src/pages/fulfillment/settings.
// astro) loads the rows; the API (src/pages/api/fulfillment/settings.ts)
// parses, validates and writes — both through here:
//   node --test tests/fulfillment-settings.test.mjs

// ── classifyStage ──────────────────────────────────────────────────────────

/** What classifyStage says one stage title is (thresholds and owner). */
export interface StageClassification {
  stage_type: string;
  warn_days: number;
  stuck_days: number;
  ball_with: 'firm' | 'client' | 'government';
}

/**
 * The classification rules, first match wins in this order. warn_days is the
 * amber threshold (overrides stall_rules.stuck_days), stuck_days the red one
 * (overrides stall_rules.critical_days); see the migration's SQL comment.
 */
const RULES: ReadonlyArray<{ any: readonly string[]; type: string; warn: number; stuck: number; ball: StageClassification['ball_with'] }> = [
  { any: ['organizer', 'waiting for client', 'waiting on client'], type: 'documents', warn: 14, stuck: 30, ball: 'client' },
  { any: ['missing info'], type: 'missing_info', warn: 14, stuck: 30, ball: 'client' },
  { any: ['signature', 'e-sign', 'esign'], type: 'client_review_sign', warn: 14, stuck: 30, ball: 'client' },
  { any: ['irs', 'government', 'notice response', 'waiting for irs', 'waiting for state'], type: 'government_wait', warn: 30, stuck: 60, ball: 'government' },
  { any: ['review'], type: 'review', warn: 5, stuck: 10, ball: 'firm' },
  { any: ['prep', 'preparation'], type: 'preparation', warn: 7, stuck: 14, ball: 'firm' },
  { any: ['e-filing', 'efile', 'filing'], type: 'filing', warn: 3, stuck: 7, ball: 'firm' },
  { any: ['delivery', 'complete'], type: 'delivery', warn: 3, stuck: 7, ball: 'firm' },
  { any: ['to do', 'assign', 'intake'], type: 'intake', warn: 3, stuck: 7, ball: 'firm' },
];

/** Case-insensitive first-match classification of a stage title; null = unmapped. */
export function classifyStage(title: string): StageClassification | null {
  const t = title.toLowerCase();
  for (const rule of RULES) {
    if (rule.any.some((keyword) => t.includes(keyword))) {
      return { stage_type: rule.type, warn_days: rule.warn, stuck_days: rule.stuck, ball_with: rule.ball };
    }
  }
  return null;
}

// ── parseSettingsForm ──────────────────────────────────────────────────────

/** One posted stage row, ids kept as the digit strings the form sent. */
export interface ParsedStage {
  pipeline_id: string;
  stage_id: string;
  /** Blank (unmapped) parsed as null; the API deletes the map row for those. */
  stage_type: string | null;
  warn_days: number | null;
  stuck_days: number | null;
  ball_with: string | null;
}

/** What parseSettingsForm makes of a posted settings form. */
export interface ParsedSettingsForm {
  /** Keyed by pipeline id (digit string); true = hidden. */
  hidden: Record<string, boolean>;
  stages: ParsedStage[];
  /** One human-readable line per problem; the form never throws instead. */
  errors: string[];
}

const DIGITS = /^[0-9]+$/;
const BALL_WITH = new Set(['firm', 'client', 'government', 'none']);
const DAYS_MAX = 365;

/** Every value of a field, from FormData, URLSearchParams or a plain object. */
function getAll(form: unknown, name: string): string[] {
  if (form instanceof FormData || form instanceof URLSearchParams) return form.getAll(name).map(String);
  if (form != null && typeof form === 'object') {
    const value = (form as Record<string, unknown>)[name];
    if (Array.isArray(value)) return value.map(String);
    return value == null ? [] : [String(value)];
  }
  return [];
}

/** Blank -> null; an integer 1..365 -> the number; anything else -> null + an error. */
function parseDays(value: string, label: string, errors: string[]): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) {
    errors.push(`${label} must be a whole number of days`);
    return null;
  }
  const n = Number(trimmed);
  if (n < 1 || n > DAYS_MAX) {
    errors.push(`${label} must be between 1 and ${DAYS_MAX}`);
    return null;
  }
  return n;
}

/**
 * Parses the settings page's posted fields into the shape the API writes:
 *   pipeline  one per pipeline row (digit-string id)
 *   hide      checkbox values, the pipeline ids to hide
 *   stage     one per stage row, "<pipeline_id>:<stage_id>"
 *   type_<pipeline_id>_<stage_id>, warn_…, stuck_…, ball_…
 * Validates ids (digit strings), stage_type (blank or in allowedTypes), days
 * (blank or 1..365), ball_with (blank or firm/client/government/none) and
 * warn <= stuck; every problem lands in errors instead of throwing.
 */
export function parseSettingsForm(form: unknown, allowedTypes: readonly string[]): ParsedSettingsForm {
  const errors: string[] = [];
  const allowed = new Set(allowedTypes);
  const hidden: Record<string, boolean> = {};
  const stages: ParsedStage[] = [];
  try {
    const hideIds = new Set(getAll(form, 'hide'));
    for (const id of getAll(form, 'pipeline')) {
      if (!DIGITS.test(id)) {
        errors.push(`Pipeline id "${id}" is not a number`);
        continue;
      }
      hidden[id] = hideIds.has(id);
    }
    for (const value of getAll(form, 'stage')) {
      const [pipelineId, stageId, ...extra] = value.split(':');
      if (!DIGITS.test(pipelineId) || !DIGITS.test(stageId) || extra.length) {
        errors.push(`Stage "${value}" is not a pipeline and stage id pair`);
        continue;
      }
      const suffix = `${pipelineId}_${stageId}`;
      const rawType = (getAll(form, `type_${suffix}`)[0] ?? '').trim();
      let stageType: string | null = null;
      if (rawType) {
        if (!allowed.has(rawType)) {
          errors.push(`Unknown stage type "${rawType}"`);
        } else {
          stageType = rawType;
        }
      }
      const rawBall = (getAll(form, `ball_${suffix}`)[0] ?? '').trim();
      let ballWith: string | null = null;
      if (rawBall) {
        if (!BALL_WITH.has(rawBall)) {
          errors.push(`Ball with must be firm, client, government or none, not "${rawBall}"`);
        } else {
          ballWith = rawBall;
        }
      }
      const warn = parseDays(getAll(form, `warn_${suffix}`)[0] ?? '', 'Warn days', errors);
      const stuck = parseDays(getAll(form, `stuck_${suffix}`)[0] ?? '', 'Stuck days', errors);
      if (warn != null && stuck != null && warn > stuck) {
        errors.push('Warn days must not be after stuck days');
      }
      stages.push({ pipeline_id: pipelineId, stage_id: stageId, stage_type: stageType, warn_days: warn, stuck_days: stuck, ball_with: ballWith });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Could not read the posted form');
  }
  return { hidden, stages, errors };
}

// ── shapeSettings ──────────────────────────────────────────────────────────

/** A td_pipelines row as the settings page loads it. */
export interface SettingsPipeline {
  id: number | string;
  title: string;
  hidden: boolean | null;
}

/** A td_pipeline_stages row as the settings page loads it. */
export interface SettingsStage {
  id: number | string;
  pipeline_id: number | string;
  title: string;
  stage_order: number | null;
}

/** A stage_type_map row as the settings page loads it. */
export interface SettingsStageMap {
  pipeline_id: number | string;
  stage_id: number | string;
  stage_type: string;
  warn_days: number | null;
  stuck_days: number | null;
  ball_with: string | null;
}

/** Active-job counts per pipeline (latest snapshot per job, kind 'active'). */
export interface SettingsActiveCount {
  pipeline_id: number | string;
  n: number;
}

/** One stage row of the page model: the stage plus its current map values. */
export interface SettingsStageModel {
  id: number | string;
  title: string;
  stage_order: number | null;
  stage_type: string | null;
  warn_days: number | null;
  stuck_days: number | null;
  ball_with: string | null;
}

/** One pipeline of the page model, with its stages in stage_order. */
export interface SettingsPipelineModel {
  id: number | string;
  title: string;
  hidden: boolean;
  active_jobs: number;
  stages: SettingsStageModel[];
}

/** stage_order ascending with nulls last, then title — the views' ordering. */
function byOrderThenTitle(a: SettingsStage, b: SettingsStage): number {
  if (a.stage_order != null && b.stage_order != null && a.stage_order !== b.stage_order) return a.stage_order - b.stage_order;
  if (a.stage_order == null && b.stage_order != null) return 1;
  if (a.stage_order != null && b.stage_order == null) return -1;
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}

/**
 * Builds the settings page model: pipelines sorted visible first then by
 * title, each with its hidden flag, active job count and its stages in
 * stage_order carrying the current stage_type_map values (null stage_type =
 * no map row = unmapped). Ids are compared via String(), never ===, because
 * the Neon driver may return bigints as strings.
 */
export function shapeSettings(
  pipelines: SettingsPipeline[],
  stages: SettingsStage[],
  maps: SettingsStageMap[],
  activeCounts: SettingsActiveCount[]
): SettingsPipelineModel[] {
  const mapByStage = new Map(maps.map((m) => [`${String(m.pipeline_id)}:${String(m.stage_id)}`, m]));
  const activeByPipeline = new Map(activeCounts.map((c) => [String(c.pipeline_id), Number(c.n)]));
  const stagesByPipeline = new Map<string, SettingsStageModel[]>();
  for (const stage of [...stages].sort(byOrderThenTitle)) {
    const key = String(stage.pipeline_id);
    const map = mapByStage.get(`${key}:${String(stage.id)}`);
    let list = stagesByPipeline.get(key);
    if (!list) stagesByPipeline.set(key, (list = []));
    list.push({
      id: stage.id,
      title: stage.title,
      stage_order: stage.stage_order,
      stage_type: map?.stage_type ?? null,
      warn_days: map?.warn_days ?? null,
      stuck_days: map?.stuck_days ?? null,
      ball_with: map?.ball_with ?? null,
    });
  }
  return pipelines
    .map((p) => ({
      id: p.id,
      title: p.title,
      hidden: p.hidden === true,
      active_jobs: activeByPipeline.get(String(p.id)) ?? 0,
      stages: stagesByPipeline.get(String(p.id)) ?? [],
    }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
