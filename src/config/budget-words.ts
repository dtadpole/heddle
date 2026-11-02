/**
 * The sentence for a budget whose retained tail is not below its trigger, naming each side by what was written (#212).
 *
 * One sentence for both places that judge the rule: the context row's write-time rule (`context-rule.ts`) and
 * `resolveBudget` when a turn starts (src/context/budget.ts), so a refusal at Save and a failure at a turn read alike.
 * heddle-config's `context_rule.rs` `retain_not_below` is its twin, word for word. A side set in tokens is named by its
 * field; a side from a ratio is named by the ratio, the window it was taken of, and the tokens that came to. Each side's
 * field carries the prefix of where it was written: `policies[i].` for an endpoint's policy, nothing for the row or a
 * default nobody wrote.
 */
export interface RetainNotBelow {
  /** Where the trigger's field was written: `''` for the row or the default, `policies[i].` for a policy. */
  readonly thresholdFrom: string
  /** Where the tail's field was written, the same way. */
  readonly retainFrom: string
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
  const { thresholdFrom: t, retainFrom: r, windowName, window, thresholdTokens, retainTokens, thresholdRatio, retainRatio, threshold, retain } = budget
  if (thresholdTokens !== undefined && retainTokens !== undefined) {
    return `${r}retainTokens (${retainTokens}) must be less than ${t}thresholdTokens (${thresholdTokens})`
  }
  if (thresholdTokens === undefined && retainTokens === undefined && retainRatio >= thresholdRatio) {
    return `${r}retainRatio (${retainRatio}) must be less than the resolved ${t}thresholdRatio (${thresholdRatio})`
  }
  const tail = retainTokens !== undefined ? `${r}retainTokens (${retainTokens})` : `${r}retainRatio (${retainRatio}) of ${windowName} ${window} is ${retain} tokens, which`
  const trigger =
    thresholdTokens !== undefined ? `${t}thresholdTokens (${thresholdTokens})` : `the threshold tokens (${threshold} = ${t}thresholdRatio ${thresholdRatio} of ${windowName} ${window})`
  return `${tail} must be less than ${trigger}`
}

/** Where a side's field was written: the policy when it names that field, else the row or the default. */
export function writtenAt(policyPrefix: string, policy: Readonly<Record<string, unknown>> | undefined, field: string): string {
  return policy !== undefined && policy[field] !== undefined ? policyPrefix : ''
}
