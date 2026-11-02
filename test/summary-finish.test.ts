import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summaryFinishFailure } from '../src/llm/types.ts'

/**
 * How a summary call finished decides whether its answer may be a checkpoint (#207).
 *
 * A summary cut at its output limit replaced the history on both builds, losing what it had not reached; DSH's
 * `dsh-compaction-basic` `finishError` refuses it as `MAX_TOKENS`. The Rust build pins the same table in
 * `heddle-llm` `types.rs`.
 */

test('a summary cut at its output limit is refused in DSH’s words', () => {
  const failure = summaryFinishFailure('double', 'max_output_tokens')
  assert.equal(failure?.message, 'summarization truncated at the token cap (incomplete checkpoint)')
  assert.equal(failure?.code, 'MAX_TOKENS')
  assert.equal(failure?.endpoint, 'double')
})

test('any other early end is refused too, and a normal finish is a checkpoint', () => {
  for (const reason of ['content_filter', 'incomplete', 'unknown']) {
    const failure = summaryFinishFailure('double', reason)
    assert.equal(failure?.message, `summarization ended '${reason}' (incomplete checkpoint)`)
    assert.equal(failure?.code, 'INCOMPLETE')
  }
  assert.equal(summaryFinishFailure('double', 'stop'), undefined)
  assert.equal(summaryFinishFailure('double', 'tool_calls'), undefined)
})
