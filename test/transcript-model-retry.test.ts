import assert from 'node:assert/strict'
import { test } from 'node:test'

import { transcriptTurns } from '../src/server/web.ts'

/**
 * #251: a model retry chain is one `model-retry` row, as DSH's `retryDefinition` folds `llm/retry` and
 * `llm/retry-started` (dsh-client-ui-chat lib/client.js:10037-10104). The same three vectors are judged by the Rust
 * fold (heddle-server transcript.rs, `a_model_retry_chain_is_one_row_*`), so both builds draw the same row.
 */

const user = { seq: 1, type: 'message', at: '2026-11-02T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }
const scheduled = (seq: number, retryId: string, retry: number, maxRetries: number) => ({
  seq,
  type: 'llm/retry',
  at: `2026-11-02T00:00:0${seq}.000Z`,
  retryId,
  round: 0,
  provider: 'scripted',
  mode: 'normal',
  policyKey: 'normal:5',
  retry,
  maxRetries,
  delayMs: 500 * retry,
  failure: { code: 'SERVER', message: 'upstream answered 503' },
})
const started = (seq: number, retryId: string, retry: number) => ({ seq, type: 'llm/retry-started', retryId, round: 0, retry })
const attempt = (seq: number, retry: number, maxRetries: number, state: string) => ({
  retry,
  maxRetries,
  mode: 'normal',
  delayMs: 500 * retry,
  failure: { code: 'SERVER', message: 'upstream answered 503' },
  at: `2026-11-02T00:00:0${seq}.000Z`,
  state,
})

test('a retried request that then answers is one model-retry row of started attempts, before the answer (#251)', () => {
  const turns = transcriptTurns([
    user,
    scheduled(2, 'retry-a', 1, 5),
    started(3, 'retry-a', 1),
    scheduled(4, 'retry-a', 2, 5),
    started(5, 'retry-a', 2),
    { seq: 6, type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'done' } },
    { seq: 7, type: 'turn/completed' },
  ])
  assert.deepEqual(turns.map((turn) => turn.kind), ['user', 'model-retry', 'assistant'])
  assert.deepEqual(turns[1], { kind: 'model-retry', text: '', retryId: 'retry-a', attempts: [attempt(2, 1, 5, 'started'), attempt(4, 2, 5, 'started')] })
})

test('a retry whose request fails again ends with its attempt started and the failure row after it (#251)', () => {
  const turns = transcriptTurns([user, scheduled(2, 'retry-b', 1, 1), started(3, 'retry-b', 1), { seq: 4, type: 'turn/failed', message: 'upstream answered 503' }])
  assert.deepEqual(turns.map((turn) => turn.kind), ['user', 'model-retry', 'assistant'])
  assert.deepEqual(turns[1], { kind: 'model-retry', text: '', retryId: 'retry-b', attempts: [attempt(2, 1, 1, 'started')] })
  assert.deepEqual(turns[2]?.ended, ['the turn failed: upstream answered 503'])
})

test('a turn stopped while its retry waits cancels the attempt, as DSH cancels one whose turn closed (#251)', () => {
  const turns = transcriptTurns([
    user,
    scheduled(2, 'retry-c', 1, 5),
    { seq: 3, type: 'assistant/completed', text: '', ended: ['stopped by the caller'] },
    { seq: 4, type: 'turn/completed' },
  ])
  assert.deepEqual(turns.map((turn) => turn.kind), ['user', 'model-retry', 'assistant'])
  assert.deepEqual(turns[1], { kind: 'model-retry', text: '', retryId: 'retry-c', attempts: [attempt(2, 1, 5, 'cancelled')] })
  assert.deepEqual(turns[2]?.ended, ['stopped by the caller'])
})
