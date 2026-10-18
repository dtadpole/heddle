import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  anthropicUsage,
  billedInputTokens,
  mergeTokenUsage,
  openaiChatUsage,
  openaiResponsesUsage,
} from '../src/llm/usage.ts'

/**
 * Usage is the fact behind the composer's token pill, and providers disagree about its shape.
 *
 * DSH keeps three prompt-side buckets apart — uncached input, cache reads and cache writes — plus output,
 * because `Cache hit` is the cache-read share of that billed input. The adapters therefore normalise into
 * that shape, and these tests pin the normalisation per wire shape: a cached count is a **subset** of
 * OpenAI's `prompt_tokens`, while Anthropic's `input_tokens` already excludes its cache buckets.
 */
test('openai chat usage: a cached count is a subset of prompt_tokens', () => {
  assert.deepEqual(
    openaiChatUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }),
    { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 },
    'the uncached part is what is billed as input',
  )
  assert.deepEqual(
    openaiChatUsage({ prompt_tokens: 10, completion_tokens: 4 }),
    { inputTokens: 10, outputTokens: 4 },
    'without a cache detail the whole prompt is uncached',
  )
  assert.equal(openaiChatUsage(undefined), undefined, 'nothing reported, nothing claimed')
  assert.deepEqual(
    openaiChatUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 250 } }),
    { inputTokens: 0, cacheReadTokens: 250 },
    'a provider that reports more cached than prompt tokens cannot produce a negative billed input',
  )
})

test('openai responses usage: the same subset rule on input_tokens', () => {
  assert.deepEqual(
    openaiResponsesUsage({ input_tokens: 500, output_tokens: 20, input_tokens_details: { cached_tokens: 400 } }),
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400 },
  )
  assert.deepEqual(openaiResponsesUsage({ input_tokens: 500 }), { inputTokens: 500 })
  assert.equal(openaiResponsesUsage(undefined), undefined)
})

test('anthropic usage: input_tokens excludes the cache buckets already', () => {
  assert.deepEqual(
    anthropicUsage({
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    }),
    { inputTokens: 12, outputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 5 },
    'the three prompt-side buckets are disjoint',
  )
  assert.deepEqual(anthropicUsage({ input_tokens: 12 }), { inputTokens: 12 })
  assert.equal(anthropicUsage(undefined), undefined)
})

test('mergeTokenUsage adds every bucket, and a bucket no round reported stays absent', () => {
  assert.equal(mergeTokenUsage(undefined, undefined), undefined)
  assert.deepEqual(mergeTokenUsage(undefined, { inputTokens: 10, cacheReadTokens: 30 }), { inputTokens: 10, cacheReadTokens: 30 })
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 10, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 5 },
      { inputTokens: 2, outputTokens: 6, cacheReadTokens: 70 },
    ),
    { inputTokens: 12, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 5 },
    'rounds add up per bucket',
  )
  assert.deepEqual(
    mergeTokenUsage({ inputTokens: 10 }, { outputTokens: 6 }),
    { inputTokens: 10, outputTokens: 6 },
    'a field only one round reported is kept without inventing the other',
  )
})

test('billedInputTokens sums the three prompt-side buckets, or says nothing', () => {
  assert.equal(billedInputTokens({ inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 5 }), 45)
  assert.equal(billedInputTokens({ inputTokens: 10 }), 10)
  assert.equal(billedInputTokens({ cacheReadTokens: 30 }), 30)
  assert.equal(billedInputTokens(undefined), undefined, 'no usage means no denominator')
  assert.equal(billedInputTokens({}), undefined, 'an empty usage is not a zero-token billing')
})
