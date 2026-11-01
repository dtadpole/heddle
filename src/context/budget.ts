/**
 * The context budget: how large the window is, when to compact, and how much to keep.
 *
 * DSH resolves this at load and again per routed model, and two of its rules are
 * the reason this is a separate module from the assembler that spends it:
 *
 * - **The endpoint's own window beats the configured one.** An adapter that
 *   declares a window knows its model; a number in a config file is one guess
 *   covering every endpoint.
 * - **Retention must sit strictly below the trigger.** A retained tail at least
 *   as large as the threshold means compaction cannot bring the surface back
 *   under it, so DSH refuses such a policy at load, and this refuses it here
 *   instead of looping a summariser that cannot make progress.
 */

import { retainNotBelow } from '../config/budget-words.ts'

/** Compact when the estimate reaches this fraction of the window. DSH's default. */
export const THRESHOLD_RATIO = 0.8
/** Keep this fraction of the window as recent history, uncompacted. DSH's default. */
export const RETAIN_RATIO = 0.16

/**
 * A budget that cannot be resolved, with the code attached.
 *
 * The code is the part callers branch on: an endpoint with no declared window is
 * a configuration gap a caller may fall back from, while a retention policy that
 * is not below its threshold is a policy bug that must not be silently repaired.
 */
export class BudgetError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
  }
}

/** The ratios and absolute numbers a caller may override, per plugin or per endpoint. */
export interface BudgetPolicy {
  /** Compact at this fraction of the window; the ratio behind `thresholdTokens`. */
  readonly thresholdRatio?: number
  /** Retain this fraction of the window; the ratio behind `retainTokens`. */
  readonly retainRatio?: number
  /** An absolute trigger, which wins over `thresholdRatio` when both are set. */
  readonly thresholdTokens?: number
  /** An absolute retained tail, which wins over `retainRatio` when both are set. */
  readonly retainTokens?: number
}

/** The resolved budget for one request. */
export interface Budget {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  /** Where the window came from, so a caller can say why the budget is what it is. */
  readonly source: 'endpoint' | 'config'
}

/**
 * Resolve the budget for one endpoint.
 *
 * Field-by-field merging is deliberate: a per-endpoint entry names only what it
 * changes, so a later default must not erase a configured ratio — spreading the
 * entry wholesale would do exactly that whenever it carries an explicit
 * `undefined`. The first matching entry wins, because an override list that
 * resolves differently depending on order of arrival is not an override list.
 */
export function resolveBudget(input: {
  readonly endpoint?: string
  /** The routed endpoint's own window, when its adapter declares one. */
  readonly endpointWindow?: number
  /** The plugin's configured window, used when the endpoint declares none. */
  readonly configWindow?: number
  readonly configPolicy?: BudgetPolicy
  /** Per-endpoint overrides, matched by `endpoint`. */
  readonly policies?: readonly ({ readonly endpoint: string } & BudgetPolicy)[]
}): Budget {
  const window = input.endpointWindow ?? input.configWindow
  if (window === undefined) {
    throw new BudgetError(
      input.endpoint === undefined
        ? 'no context window: the endpoint declares none and none is configured'
        : `no context window for endpoint '${input.endpoint}': the endpoint declares none and none is configured`,
      'NO_CAPACITY',
    )
  }

  const overrideAt = input.policies?.findIndex((entry) => entry.endpoint === input.endpoint) ?? -1
  const override = overrideAt >= 0 ? input.policies?.[overrideAt] : undefined
  const configured = input.configPolicy ?? {}
  const policy: BudgetPolicy = {
    ...configured,
    ...(override?.thresholdRatio !== undefined ? { thresholdRatio: override.thresholdRatio } : {}),
    ...(override?.retainRatio !== undefined ? { retainRatio: override.retainRatio } : {}),
    ...(override?.thresholdTokens !== undefined ? { thresholdTokens: override.thresholdTokens } : {}),
    ...(override?.retainTokens !== undefined ? { retainTokens: override.retainTokens } : {}),
  }

  const thresholdTokens = policy.thresholdTokens ?? Math.floor(window * (policy.thresholdRatio ?? THRESHOLD_RATIO))
  const retainTokens = policy.retainTokens ?? Math.floor(window * (policy.retainRatio ?? RETAIN_RATIO))
  if (retainTokens >= thresholdTokens) {
    /**
     * Named by what was written (#212): the setting each side came from, and the window it was taken of, in the words a
     * Save of the same values is refused with (src/config/budget-words.ts); a policy's own field is named under its index.
     */
    const ownField = override !== undefined && (['thresholdRatio', 'retainRatio', 'thresholdTokens', 'retainTokens'] as const).some((field) => override[field] !== undefined)
    const sentence = retainNotBelow({
      prefix: ownField ? `policies[${overrideAt}].` : '',
      windowName: input.endpointWindow !== undefined ? `endpoint '${input.endpoint}' window` : 'contextWindow',
      window,
      thresholdTokens: policy.thresholdTokens,
      retainTokens: policy.retainTokens,
      thresholdRatio: policy.thresholdRatio ?? THRESHOLD_RATIO,
      retainRatio: policy.retainRatio ?? RETAIN_RATIO,
      threshold: thresholdTokens,
      retain: retainTokens,
    })
    throw new BudgetError(`${sentence}: the retained tail would be at least the trigger, so compaction could never make progress`, 'RETAIN_NOT_BELOW_THRESHOLD')
  }

  return {
    contextWindow: window,
    thresholdTokens,
    retainTokens,
    source: input.endpointWindow !== undefined ? 'endpoint' : 'config',
  }
}
