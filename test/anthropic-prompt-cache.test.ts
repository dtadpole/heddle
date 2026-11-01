import assert from 'node:assert/strict'
import { test } from 'node:test'

import { anthropicChunks, anthropicMessagesCall, withPromptCache } from '../src/llm/adapters.ts'
import type { EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * An Anthropic request marks its prompt for caching where DSH's route does (#70).
 *
 * Measured before on both builds (live, conclave-claude, Claude Sonnet 4.5): a two-turn session billed 5193 then 5205
 * input tokens with no cache read or write, because no request carried `cache_control`. pi-ai's
 * `anthropic-messages` route marks the system prompt, the last tool and the last block of the last user message
 * with an ephemeral breakpoint by default.
 */

const ephemeral = { type: 'ephemeral' }

const body = (): Record<string, unknown> => ({
  system: 'be brief',
  tools: [{ name: 'a' }, { name: 'b' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }, { type: 'text', text: 'next' }] },
  ],
})

test('the system prompt, the last tool and the last block of the last user message carry the breakpoint', () => {
  const cached = withPromptCache(body(), {}) as {
    system: Record<string, unknown>[]
    tools: Record<string, unknown>[]
    messages: { content: Record<string, unknown>[] }[]
  }
  assert.deepEqual(cached.system, [{ type: 'text', text: 'be brief', cache_control: ephemeral }])
  assert.deepEqual(cached.tools[1], { name: 'b', cache_control: ephemeral }, 'the last tool')
  assert.equal('cache_control' in cached.tools[0]!, false, 'and only the last')
  assert.deepEqual(cached.messages[2]!.content[1], { type: 'text', text: 'next', cache_control: ephemeral })
  assert.equal('cache_control' in cached.messages[2]!.content[0]!, false)
  assert.equal('cache_control' in cached.messages[0]!.content[0]!, false, 'earlier messages are not marked')
  assert.equal(JSON.stringify(cached).split('cache_control').length - 1, 3, 'three breakpoints, under Anthropic’s four')
})

test('promptCache: false sends the body as it was, and an assistant last message or an empty text block takes none', () => {
  assert.deepEqual(withPromptCache(body(), { promptCache: false }), body())
  const prefill = withPromptCache({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }] }, {})
  assert.equal(JSON.stringify(prefill).includes('cache_control'), false)
  const empty = withPromptCache({ messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] }, {})
  assert.equal(JSON.stringify(empty).includes('cache_control'), false)
})

test('the Messages route sends the marked body, and the switch reaches it', () => {
  const endpoint: EndpointConfig = { name: 'claude', kind: 'anthropic-messages', baseUrl: 'https://gateway.example/v1', model: 'claude-model' }
  const request: GenerateRequest = {
    endpoint: 'claude',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }
  assert.equal(JSON.stringify(anthropicMessagesCall(endpoint, request).body).split('cache_control').length - 1, 2, 'system and the last user block')
  assert.equal(JSON.stringify(anthropicMessagesCall({ ...endpoint, promptCache: false }, request).body).includes('cache_control'), false)
})

test('the stream records the cache read and write the start frame reports, which used to be dropped', async () => {
  async function* frames() {
    yield { data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 } } }) }
    yield { data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } }) }
    yield { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) }
    yield { data: JSON.stringify({ type: 'message_stop' }) }
  }
  const chunks = []
  for await (const chunk of anthropicChunks(frames(), 'claude')) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), {
    type: 'done',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 4000, cacheWriteTokens: 300 },
  })
})
