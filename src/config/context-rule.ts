import { RETAIN_RATIO, THRESHOLD_RATIO } from '../context/budget.ts'

/**
 * The context row's budget rule, judged where a value is written (issue #212).
 *
 * `resolveBudget` (src/context/budget.ts) refuses a budget whose retained tail is not below its trigger, but it runs
 * when a turn starts, so a settings write could save a value that failed every later turn on that server. This is the
 * same rule over the written configuration, run by `validateRows` through the row module's `configProblems` export, so
 * a Save and `config --validate` refuse it first. heddle-config's `context_rule.rs` is its twin, word for word.
 *
 * The words are DSH's compaction-basic where it has a rule of the same shape (`assertRatio`, `validateRatioRetention`):
 * a ratio is a number in (0, 1], and a retained ratio must be less than the resolved threshold ratio, whatever the
 * window. Where only the window decides (a tail in tokens against a trigger by ratio, or a window too small for the
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

/** Every way the context row's budget fields would fail a turn; empty when they would not. */
export function contextConfigProblems(config: unknown): readonly string[] {
  const row = (config !== null && typeof config === 'object' ? config : {}) as Scope & { readonly contextWindow?: unknown; readonly policies?: unknown }
  const window = number(row.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const problems: string[] = [...scopeProblems('', row, row, window)]
  const policies = Array.isArray(row.policies) ? row.policies : []
  for (const [index, entry] of policies.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const own = entry as Scope
    if (!FIELDS.some((field) => own[field] !== undefined)) continue
    const merged: Scope = Object.fromEntries(FIELDS.map((field) => [field, own[field] ?? row[field]]))
    problems.push(...scopeProblems(`policies[${index}].`, own, merged, window))
  }
  return problems
}

/** One scope: its own ratios in range, then the merged budget's tail below its trigger. */
function scopeProblems(prefix: string, own: Scope, merged: Scope, window: number): readonly string[] {
  const problems: string[] = []
  for (const field of ['thresholdRatio', 'retainRatio'] as const) {
    const value = number(own[field])
    if (value !== undefined && (value <= 0 || value > 1)) problems.push(`${prefix}${field} (${value}) must be a number in (0, 1]`)
  }
  if (problems.length > 0) return problems

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
