import { ConfigError } from './schema.ts'

/**
 * Provider request retry: DSH's provider-owned `retryPolicy` (`dsh-llm`'s retry policy) and the decision its retry
 * executor (`dsh-llm-retry`) takes for one failed model request. The Rust port's `heddle-config` `retry` module is the
 * twin; both answer the same policy, codes, delays, keys and decisions.
 *
 * **The policy.** An endpoint's `retryPolicy` is `normal` (the default: at most `maxRetries` retries, 5, for the codes
 * in `retryableCodes`, by default `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT`) or `always`
 * (every failure, without a limit). Both share a bounded exponential `backoff`: `initialDelayMs` 500, `maxDelayMs`
 * 10000, `jitterRatio` 0.1. `resolveRetryPolicy` validates and defaults it with DSH's sentences.
 *
 * **The decision.** `planRetry` takes a failure (its code, from `retryFailureCode`, and the provider's `Retry-After`,
 * from `parseRetryAfter`) and how many retries this step already took, and answers the next retry and its delay, or
 * `undefined` when the failure goes to the caller as it is. A positive `Retry-After` within `maxDelayMs` replaces the
 * local delay; one beyond it ends a `normal` policy and is replaced by the local delay in an `always` policy. The local
 * delay is `min(initialDelayMs × 2^(retry−1), maxDelayMs)`, jittered symmetrically and capped again. The count is per
 * step: the caller resets it when a new step or turn begins.
 */

export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_INITIAL_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 10_000
export const DEFAULT_JITTER_RATIO = 0.1
export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const DEFAULT_RETRYABLE_CODES: readonly string[] = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

interface Backoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export type RetryPolicy =
  | (Backoff & { readonly mode: 'normal'; readonly maxRetries: number; readonly retryableCodes: readonly string[] })
  | (Backoff & { readonly mode: 'always' })

export interface RetryFailure {
  readonly code: string
  readonly retryAfterMs?: number
}

export interface RetryPlan {
  readonly retry: number
  readonly delayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: DEFAULT_MAX_RETRIES,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  jitterRatio: DEFAULT_JITTER_RATIO,
})

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (problem: string) => new ConfigError([problem])

/** Validate and default one endpoint's `retryPolicy` as written; `path` names it in every problem. */
export function resolveRetryPolicy(config: unknown, path: string): RetryPolicy {
  if (config === undefined || config === null) return DEFAULT_RETRY_POLICY
  if (!isRecord(config)) throw fail(`${path}.mode must be "normal" or "always"`)
  for (const key of Object.keys(config)) {
    if (!['mode', 'maxRetries', 'retryableCodes', 'backoff'].includes(key)) throw fail(`${path}: unknown key "${key}"`)
  }
  const backoff = resolveBackoff(config.backoff, `${path}.backoff`)
  if (config.mode === 'normal') {
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    if (typeof maxRetries !== 'number' || !Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw fail(`${path}.maxRetries must be a non-negative safe integer`)
    }
    const codes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
    if (!Array.isArray(codes)) throw fail(`${path}.retryableCodes must contain only non-empty strings`)
    if (codes.length === 0) throw fail(`${path}.retryableCodes must not be empty`)
    if (codes.some((code) => typeof code !== 'string' || code.length === 0)) throw fail(`${path}.retryableCodes must contain only non-empty strings`)
    if (new Set(codes).size !== codes.length) throw fail(`${path}.retryableCodes must not contain duplicates`)
    return Object.freeze({ mode: 'normal', maxRetries, retryableCodes: Object.freeze([...(codes as string[])]), ...backoff })
  }
  if (config.mode === 'always') return Object.freeze({ mode: 'always', ...backoff })
  throw fail(`${path}.mode must be "normal" or "always"`)
}

function resolveBackoff(config: unknown, path: string): Backoff {
  if (config !== undefined && !isRecord(config)) throw fail(`${path} must be a mapping`)
  const map = (config ?? {}) as Record<string, unknown>
  for (const key of Object.keys(map)) {
    if (!['initialDelayMs', 'maxDelayMs', 'jitterRatio'].includes(key)) throw fail(`${path}: unknown key "${key}"`)
  }
  const initialDelayMs = map.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = map.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = map.jitterRatio ?? DEFAULT_JITTER_RATIO
  const inRange = (delay: unknown): delay is number => typeof delay === 'number' && Number.isFinite(delay) && delay > 0 && delay <= MAX_TIMER_DELAY_MS
  if (!inRange(initialDelayMs)) throw fail(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  if (!inRange(maxDelayMs)) throw fail(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  if (initialDelayMs > maxDelayMs) throw fail(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  if (typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw fail(`${path}.jitterRatio must be between 0 and 1`)
  }
  return { initialDelayMs, maxDelayMs, jitterRatio }
}

/** An endpoint's resolved policy: its `retryPolicy` field, which the endpoint merge carries as written. */
export function retryPolicyOf(endpoint: { readonly name: string; readonly retryPolicy?: unknown }): RetryPolicy {
  return resolveRetryPolicy(endpoint.retryPolicy, `endpoints.${endpoint.name}.retryPolicy`)
}

/** The policy's identity for counting; every behaviour field is in it and the codes are sorted. */
export function retryPolicyKey(policy: RetryPolicy): string {
  return policy.mode === 'always'
    ? JSON.stringify([policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
    : JSON.stringify([policy.mode, policy.maxRetries, [...policy.retryableCodes].sort(), policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
}

/** The local delay before retry number `retry` (1-based), given `random` in `[0, 1)`. */
export function localDelayMs(policy: RetryPolicy, retry: number, random: number): number {
  const exponent = Math.min(Math.max(retry - 1, 0), 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/**
 * The next retry for `failure` after `previousRetry` retries in this step, or `undefined` when the failure goes to the
 * caller as it is: a code the policy does not retry, a spent budget, or a provider delay past `maxDelayMs` under a
 * `normal` policy.
 */
export function planRetry(policy: RetryPolicy, failure: RetryFailure, previousRetry: number, random: number): RetryPlan | undefined {
  if (policy.mode === 'normal' && (!policy.retryableCodes.includes(failure.code) || previousRetry >= policy.maxRetries)) return undefined
  const retry = previousRetry + 1
  const provider = failure.retryAfterMs
  let delayMs: number
  if (provider !== undefined && Number.isFinite(provider) && provider > 0) {
    if (provider > policy.maxDelayMs) {
      if (policy.mode === 'normal') return undefined
      delayMs = localDelayMs(policy, retry, random)
    } else delayMs = provider
  } else delayMs = localDelayMs(policy, retry, random)
  return { retry, delayMs }
}

/**
 * The code a retry policy judges a failure by, given heddle's model-error code and the HTTP status: an `HTTP` failure
 * is named by its status as DSH's provider adapters name it (401 and 403 `AUTH`, 402 `QUOTA`, 429 `RATE_LIMIT`, 400
 * and 413 `INVALID_REQUEST`, 5xx `SERVER`, otherwise `HTTP_<status>`); one with no status is `SERVER`. Every other
 * code is kept.
 */
export function retryFailureCode(code: string, status?: number): string {
  if (code !== 'HTTP') return code
  if (status === undefined) return 'SERVER'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

/**
 * A `Retry-After` header as milliseconds from `now`: decimal seconds, or an HTTP date (IMF-fixdate, the form the
 * Rust port reads too). `undefined` unless the delay is positive and finite, as DSH reads it.
 */
export function parseRetryAfter(value: string, now: number = Date.now()): number | undefined {
  const trimmed = value.trim()
  let delay: number
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) delay = Number(trimmed) * 1000
  else if (IMF_FIXDATE.test(trimmed)) delay = Date.parse(trimmed) - now
  else return undefined
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}
