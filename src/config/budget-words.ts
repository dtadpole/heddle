/**
 * The sentence for a budget whose retained tail is not below its trigger, naming each side by what was written (#212).
 *
 * One sentence for both places that judge the rule: the context row's write-time rule (`context-rule.ts`) and
 * `resolveBudget` when a turn starts (src/context/budget.ts), so a refusal at Save and a failure at a turn read alike.
 * heddle-config's `context_rule.rs` `retain_not_below` is its twin, word for word. A side set in tokens is named by its
 * field; a side from a ratio is named by the ratio, the window it was taken of, and the tokens that came to.
 */
export interface RetainNotBelow {
  /** `''` for the row, `policies[i].` for an endpoint's policy. */
  readonly prefix: string
  /** What the window is called: `contextWindow`, or `endpoint 'name' window` when the endpoint declares it. */
  readonly windowName: string
  readonly window: number
  /** Set when the trigger is written in tokens. */
  readonly thresholdTokens: number | undefined
  /** Set when the tail is written in tokens. */
  readonly retainTokens: number | undefined
  /** The resolved ratios, the defaults filled in. */
  readonly thresholdRatio: number
  readonly retainRatio: number
  /** The resolved token counts. */
  readonly threshold: number
  readonly retain: number
}

export function retainNotBelow(budget: RetainNotBelow): string {
  const { prefix, windowName, window, thresholdTokens, retainTokens, thresholdRatio, retainRatio, threshold, retain } = budget
  if (thresholdTokens !== undefined && retainTokens !== undefined) {
    return `${prefix}retainTokens (${retainTokens}) must be less than thresholdTokens (${thresholdTokens})`
  }
  if (thresholdTokens === undefined && retainTokens === undefined && retainRatio >= thresholdRatio) {
    return `${prefix}retainRatio (${retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`
  }
  const tail = retainTokens !== undefined ? `retainTokens (${retainTokens})` : `retainRatio (${retainRatio}) of ${windowName} ${window} is ${retain} tokens, which`
  const trigger =
    thresholdTokens !== undefined ? `thresholdTokens (${thresholdTokens})` : `the threshold tokens (${threshold} = thresholdRatio ${thresholdRatio} of ${windowName} ${window})`
  return `${prefix}${tail} must be less than ${trigger}`
}
