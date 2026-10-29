import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ConfigError } from '../src/config/schema.ts'
import {
  DEFAULT_RETRY_POLICY,
  localDelayMs,
  parseRetryAfter,
  planRetry,
  resolveRetryPolicy,
  retryFailureCode,
  retryPolicyKey,
  retryPolicyOf,
  type RetryPolicy,
} from '../src/config/retry.ts'

/**
 * Provider retry as DSH decides it (dsh-llm's retry policy, dsh-llm-retry's executor). The Rust port's heddle-config
 * `retry` tests decide the same claims, including the same policy key string.
 */

const path = 'endpoints.a.retryPolicy'
const problem = (value: unknown) => {
  try {
    resolveRetryPolicy(value, path)
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    return error.problems.join('; ')
  }
  return 'accepted'
}

test('an absent policy is DSH normal default', () => {
  const policy = resolveRetryPolicy(undefined, path)
  assert.deepEqual(policy, {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })
  assert.deepEqual(retryPolicyOf({ name: 'a' }), DEFAULT_RETRY_POLICY)
})

test('a written policy is validated with DSH sentences', () => {
  assert.equal(problem({ mode: 'sometimes' }), `${path}.mode must be "normal" or "always"`)
  assert.equal(problem({ mode: 'normal', tries: 3 }), `${path}: unknown key "tries"`)
  assert.equal(problem({ mode: 'normal', maxRetries: -1 }), `${path}.maxRetries must be a non-negative safe integer`)
  assert.equal(problem({ mode: 'normal', maxRetries: 1.5 }), `${path}.maxRetries must be a non-negative safe integer`)
  assert.equal(problem({ mode: 'normal', retryableCodes: [] }), `${path}.retryableCodes must not be empty`)
  assert.equal(problem({ mode: 'normal', retryableCodes: ['A', 'A'] }), `${path}.retryableCodes must not contain duplicates`)
  assert.equal(problem({ mode: 'normal', retryableCodes: [''] }), `${path}.retryableCodes must contain only non-empty strings`)
  assert.equal(
    problem({ mode: 'always', backoff: { initialDelayMs: 0 } }),
    `${path}.backoff.initialDelayMs must be a positive finite number no greater than 2147483647`,
  )
  assert.equal(problem({ mode: 'always', backoff: { initialDelayMs: 2000, maxDelayMs: 1000 } }), `${path}.backoff.initialDelayMs must be less than or equal to maxDelayMs`)
  assert.equal(problem({ mode: 'always', backoff: { jitterRatio: 2 } }), `${path}.backoff.jitterRatio must be between 0 and 1`)
  assert.equal(problem({ mode: 'always', backoff: { delay: 1 } }), `${path}.backoff: unknown key "delay"`)

  const written = resolveRetryPolicy(
    { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 100, maxDelayMs: 400, jitterRatio: 0 } },
    path,
  )
  assert.deepEqual(written, { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 100, maxDelayMs: 400, jitterRatio: 0 })
  assert.equal(resolveRetryPolicy({ mode: 'always', maxRetries: 3 }, path).mode, 'always', 'always accepts and ignores the normal fields, as DSH does')
  assert.match(problem({ mode: 'normal', maxRetries: 'x' }), /maxRetries/)
})

test('the local delay doubles from the initial delay up to the cap with symmetric jitter', () => {
  const policy = DEFAULT_RETRY_POLICY
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((retry) => localDelayMs(policy, retry, 0.5)), [500, 1000, 2000, 4000, 8000, 10_000, 10_000])
  assert.ok(Math.abs(localDelayMs(policy, 1, 0) - 450) < 1e-9, 'jitter reaches 1 − ratio')
  assert.ok(Math.abs(localDelayMs(policy, 1, 1) - 550) < 1e-9, 'and 1 + ratio')
  assert.equal(localDelayMs(policy, 5, 1), 8800)
  assert.equal(localDelayMs(policy, 6, 1), 10_000, 'never past the cap')
  assert.equal(localDelayMs(policy, 2000, 0.5), 10_000, 'a huge retry number saturates')
})

test('a normal policy retries its codes within its budget', () => {
  const policy = DEFAULT_RETRY_POLICY
  assert.deepEqual(planRetry(policy, { code: 'RATE_LIMIT' }, 0, 0.5), { retry: 1, delayMs: 500 })
  assert.deepEqual(planRetry(policy, { code: 'SERVER' }, 4, 0.5), { retry: 5, delayMs: 8000 })
  assert.equal(planRetry(policy, { code: 'SERVER' }, 5, 0.5), undefined, 'the sixth retry is past the budget')
  assert.equal(planRetry(policy, { code: 'AUTH' }, 0, 0.5), undefined, 'a permanent failure is not retried')
  assert.equal(planRetry(policy, { code: 'CONTEXT_WINDOW_EXCEEDED' }, 0, 0.5), undefined, 'compaction owns that one')
})

test('a provider delay within the cap replaces the local delay', () => {
  const normal = DEFAULT_RETRY_POLICY
  assert.deepEqual(planRetry(normal, { code: 'RATE_LIMIT', retryAfterMs: 3000 }, 0, 0.5), { retry: 1, delayMs: 3000 })
  assert.equal(planRetry(normal, { code: 'RATE_LIMIT', retryAfterMs: 0 }, 0, 0.5)?.delayMs, 500, 'a zero delay is no delay')
  assert.equal(planRetry(normal, { code: 'RATE_LIMIT', retryAfterMs: 20_000 }, 0, 0.5), undefined, 'past the cap ends a normal policy')
  const always: RetryPolicy = { mode: 'always', initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 }
  assert.deepEqual(planRetry(always, { code: 'RATE_LIMIT', retryAfterMs: 20_000 }, 0, 0.5), { retry: 1, delayMs: 500 }, 'an always policy uses its own delay instead')
  assert.equal(planRetry(always, { code: 'AUTH' }, 99, 0.5)?.retry, 100, 'and retries everything')
})

test('http failures are named by status as DSH adapters name them', () => {
  assert.equal(retryFailureCode('HTTP', 429), 'RATE_LIMIT')
  assert.equal(retryFailureCode('HTTP', 500), 'SERVER')
  assert.equal(retryFailureCode('HTTP', 503), 'SERVER')
  assert.equal(retryFailureCode('HTTP', 401), 'AUTH')
  assert.equal(retryFailureCode('HTTP', 403), 'AUTH')
  assert.equal(retryFailureCode('HTTP', 402), 'QUOTA')
  assert.equal(retryFailureCode('HTTP', 400), 'INVALID_REQUEST')
  assert.equal(retryFailureCode('HTTP', 404), 'HTTP_404')
  assert.equal(retryFailureCode('HTTP'), 'SERVER')
  assert.equal(retryFailureCode('TIMEOUT'), 'TIMEOUT')
  assert.equal(retryFailureCode('TRANSPORT'), 'TRANSPORT')
  assert.equal(retryFailureCode('CONTEXT_WINDOW_EXCEEDED', 400), 'CONTEXT_WINDOW_EXCEEDED')
})

test('retry-after reads seconds and http dates', () => {
  const now = 784_111_777_000 // Sun, 06 Nov 1994 08:49:37 GMT
  assert.equal(parseRetryAfter('2', now), 2000)
  assert.equal(parseRetryAfter('1.5', now), 1500)
  assert.equal(parseRetryAfter('0', now), undefined, 'zero is no delay')
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:40 GMT', now), 3000)
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:30 GMT', now), undefined, 'a date in the past is no delay')
  assert.equal(parseRetryAfter('soon', now), undefined)
  assert.equal(parseRetryAfter('-3', now), undefined)
})

test('the key counts equal policies together and matches the Rust port', () => {
  const one = resolveRetryPolicy({ mode: 'normal', retryableCodes: ['SERVER', 'RATE_LIMIT'] }, path)
  const two = resolveRetryPolicy({ mode: 'normal', retryableCodes: ['RATE_LIMIT', 'SERVER'] }, path)
  assert.equal(retryPolicyKey(one), retryPolicyKey(two), 'code order does not matter')
  assert.equal(retryPolicyKey(one), '["normal",5,["RATE_LIMIT","SERVER"],500,10000,0.1]', 'the string the Rust port writes')
  assert.notEqual(retryPolicyKey(one), retryPolicyKey(resolveRetryPolicy({ mode: 'always' }, path)))
})
