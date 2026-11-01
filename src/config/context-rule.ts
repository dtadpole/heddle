import { RETAIN_RATIO, THRESHOLD_RATIO } from '../context/budget.ts'

/**
 * The context row's values, judged where they are written (issue #212).
 *
 * `resolveBudget` (src/context/budget.ts) refuses a budget whose retained tail is not below its trigger, but it runs
 * when a turn starts, so a settings write could save a value that failed every later turn on that server; and the TS
 * schema declares every number plain, so a negative or fractional window was saved where the Rust build refused it.
 * This is the context row's rule over the written configuration, run by `validateRows` through the row module's
 * `configProblems` export, so a Save and `config --validate` refuse it first. heddle-config's `context_rule.rs` is its
 * twin, word for word.
 *
 * The bounds live here rather than in the schema on purpose: the schema is also what a boot applies, and a bound there
 * would stop a server whose patch already holds such a value, which today still starts.
 *
 * The words are DSH's compaction-basic (`assertPositiveInteger`, `assertNonNegativeInteger`, `assertRatio`,
 * `validateRatioRetention`): a window is a positive integer, a token count a non-negative integer, a ratio a number in
 * (0, 1], and a retained ratio must be less than the resolved threshold ratio, whatever the window. Where only the window decides (a tail in tokens against a trigger by ratio, or a window too small for the
 * ratios), the sentence names each side by what was written and the configured `contextWindow` it was judged at; an
 * endpoint that declares its own window is budgeted against that window when a turn runs.
 *
 * Each scope is judged as `resolveBudget` merges it: the row's own fields, then each `policies[i]` that names any
 * budget field, field by field over the row's. Every problem starts with the field path it is about.
 */

/** The window the context row budgets against when it names none (src/context/service.ts `Config`). */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576

interface Scope {
  readonly thresholdRatio?: unknown
  readonly retainRatio?: unknown
  readonly thresholdTokens?: unknown
  readonly retainTokens?: unknown
}

const FIELDS = ['thresholdRatio', 'retainRatio', 'thresholdTokens', 'retainTokens'] as const

const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

type Row = Scope & {
  readonly contextWindow?: unknown
  readonly instructionsMaxBytes?: unknown
  readonly summarizeMaxTokens?: unknown
  readonly policies?: unknown
}

/** Every way the context row's values would fail a turn or a start; empty when they would not. */
export function contextConfigProblems(config: unknown): readonly string[] {
  const row = (config !== null && typeof config === 'object' ? config : {}) as Row
  const policies = (Array.isArray(row.policies) ? row.policies : []).map((entry) => (entry !== null && typeof entry === 'object' ? (entry as Scope) : null))
  // Every bound first, on the fields each scope writes; the budget is only judged over numbers it can use.
  const bounds: string[] = [
    ...positiveInteger('contextWindow', row.contextWindow),
    ...scopeBounds('', row),
    ...nonNegativeInteger('instructionsMaxBytes', row.instructionsMaxBytes),
    ...positiveInteger('summarizeMaxTokens', row.summarizeMaxTokens),
    ...policies.flatMap((entry, index) => (entry === null ? [] : scopeBounds(`policies[${index}].`, entry))),
  ]
  if (bounds.length > 0) return bounds

  const window = number(row.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const problems: string[] = [...scopeProblems('', row, window)]
  for (const [index, own] of policies.entries()) {
    if (own === null || !FIELDS.some((field) => own[field] !== undefined)) continue
    const merged: Scope = Object.fromEntries(FIELDS.map((field) => [field, own[field] ?? row[field]]))
    problems.push(...scopeProblems(`policies[${index}].`, merged, window))
  }
  return problems
}

/** DSH's `assertPositiveInteger`, for a field that is set. */
function positiveInteger(path: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? [] : [`${path} (${String(value)}) must be a positive integer`]
}

/** DSH's `assertNonNegativeInteger`, for a field that is set. */
function nonNegativeInteger(path: string, value: unknown): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? [] : [`${path} (${String(value)}) must be a non-negative integer`]
}

/** One scope's own fields: its ratios in (0, 1] (DSH's `assertRatio`) and its token counts whole. */
function scopeBounds(prefix: string, own: Scope): readonly string[] {
  const problems: string[] = []
  for (const field of ['thresholdRatio', 'retainRatio'] as const) {
    const value = own[field]
    if (value === undefined) continue
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1)) problems.push(`${prefix}${field} (${String(value)}) must be a number in (0, 1]`)
  }
  for (const field of ['thresholdTokens', 'retainTokens'] as const) problems.push(...nonNegativeInteger(`${prefix}${field}`, own[field]))
  return problems
}

/** One scope's merged budget: the retained tail below its trigger. */
function scopeProblems(prefix: string, merged: Scope, window: number): readonly string[] {
  const thresholdTokens = number(merged.thresholdTokens)
  const retainTokens = number(merged.retainTokens)
  const thresholdRatio = number(merged.thresholdRatio) ?? THRESHOLD_RATIO
  const retainRatio = number(merged.retainRatio) ?? RETAIN_RATIO
  if (thresholdTokens === undefined && retainTokens === undefined) {
    if (retainRatio >= thresholdRatio) return [`${prefix}retainRatio (${retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`]
  } else if (thresholdTokens !== undefined && retainTokens !== undefined) {
    if (retainTokens >= thresholdTokens) return [`${prefix}retainTokens (${retainTokens}) must be less than thresholdTokens (${thresholdTokens})`]
    return []
  }
  const threshold = thresholdTokens ?? Math.floor(window * thresholdRatio)
  const retain = retainTokens ?? Math.floor(window * retainRatio)
  if (retain < threshold) return []
  const tail = retainTokens !== undefined ? `retainTokens (${retainTokens})` : `retainRatio (${retainRatio}) of contextWindow ${window} is ${retain} tokens, which`
  const trigger =
    thresholdTokens !== undefined ? `thresholdTokens (${thresholdTokens})` : `the threshold tokens (${threshold} = thresholdRatio ${thresholdRatio} of contextWindow ${window})`
  return [`${prefix}${tail} must be less than ${trigger}`]
}
