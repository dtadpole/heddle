import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { anthropicVertexAdapter, openAiChatAdapter, openAiResponsesAdapter } from '../src/llm/adapters.ts'
import { canonicalFinishReason, type Chunk, type EndpointConfig } from '../src/llm/types.ts'

/**
 * One vocabulary for three wire shapes.
 *
 * The loop treats `stop` and `tool_calls` as a healthy end and reports anything else on the answer. Each provider
 * spells the same outcomes differently — Chat Completions says `stop`/`tool_calls`/`length`, the Responses shape
 * says `completed` whether or not it asked for tools and reports a cut reply as a separate event, and Anthropic
 * says `end_turn`/`tool_use`/`max_tokens`.
 *
 * Before `canonicalFinishReason` existed, each adapter passed its provider's word through, so a healthy turn on a
 * Responses or Anthropic route arrived as `ended: ['round 1: completed']` or `['round 1: end_turn']`. Measured
 * 2026-10-18 against live routes; both were real stop notices on answers that were entirely fine.
 *
 * These checks drive the **real adapters** against doubles rather than the mapping alone, because a correct table
 * that an adapter forgets to call is exactly the way this defect would come back. The mapping has its own unit
 * check below, and both are needed: the table proves the translation, the adapters prove the translation is used.
 */

function sse(type: string, payload: Record<string, unknown> = {}): string {
  const body = type === 'message_start' || type.startsWith('content_block') || type === 'message_delta' || type === 'message_stop'
    ? payload
    : { type, ...payload }
  return `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`
}

async function runAdapter(
  endpoint: EndpointConfig,
  stream: readonly string[],
  adapter: (endpoint: EndpointConfig, request: { endpoint: string; messages: { role: 'user'; content: { type: 'text'; text: string }[] }[] }) => AsyncIterable<Chunk>,
): Promise<{ readonly finish: string; readonly calls: number }> {
  const server = createServer((incoming, response) => {
    incoming.resume()
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of stream) response.write(event)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const located: EndpointConfig = { ...endpoint, baseUrl: `http://127.0.0.1:${port}` }
  let finish = ''
  let calls = 0
  try {
    const request = { endpoint: endpoint.name, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] }
    for await (const chunk of adapter(located, request) as AsyncIterable<Chunk>) {
      if (chunk.type === 'tool-call') calls += 1
      if (chunk.type === 'done') finish = chunk.finishReason
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { finish, calls }
}

const chat: EndpointConfig = { name: 'chat', kind: 'openai-chat', baseUrl: '', model: 'm' }
const responses: EndpointConfig = { name: 'responses', kind: 'openai-responses', baseUrl: '', model: 'm' }
const anthropic: EndpointConfig = { name: 'anthropic', kind: 'anthropic-vertex', baseUrl: '', project: 'p', region: 'global', model: 'm' }

test('a healthy end is stop on every wire shape', async () => {
  const cases: [string, EndpointConfig, readonly string[], typeof openAiChatAdapter][] = [
    [
      'openai-chat',
      chat,
      [],
      (endpoint, request) => openAiChatAdapter({ ...endpoint, stream: true }, request),
    ],
    ['openai-responses', responses, [sse('response.completed', { response: { status: 'completed', output: [] } })], openAiResponsesAdapter],
    [
      'anthropic-vertex',
      anthropic,
      [sse('message_start', { message: { usage: { input_tokens: 1 } } }), sse('message_delta', { delta: { stop_reason: 'end_turn' } }), sse('message_stop', {})],
      anthropicVertexAdapter,
    ],
  ]
  // The chat case needs its own stream, whose finish_reason is written below.
  const chatStream = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']
  cases[0] = ['openai-chat', chat, chatStream, (endpoint, request) => openAiChatAdapter({ ...endpoint, stream: true }, request)]

  for (const [kind, endpoint, stream, adapter] of cases) {
    const result = await runAdapter(endpoint, stream, adapter as never)
    assert.equal(result.finish, 'stop', `${kind}: a finished answer is the loop's stop`)
  }
})

test('a round that asked for tools ends as tool_calls on every wire shape', async () => {
  const chatStream = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const responsesStream = [
    sse('response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'bash' } }),
    sse('response.completed', { response: { status: 'completed', output: [] } }),
  ]
  const anthropicStream = [
    sse('message_start', { message: { usage: { input_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'bash' } }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop', {}),
  ]

  const chatResult = await runAdapter(chat, chatStream, (endpoint, request) => openAiChatAdapter({ ...endpoint, stream: true }, request))
  assert.equal(chatResult.finish, 'tool_calls', 'openai-chat names it directly')

  const responsesResult = await runAdapter(responses, responsesStream, openAiResponsesAdapter)
  assert.equal(responsesResult.finish, 'tool_calls', 'the Responses shape says completed, and the calls decide')

  const anthropicResult = await runAdapter(anthropic, anthropicStream, anthropicVertexAdapter)
  assert.equal(anthropicResult.finish, 'tool_calls', 'Anthropic says tool_use')
})

test('a reply cut by its budget says so on every wire shape', async () => {
  const chatStream = [`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`, 'data: [DONE]\n\n']
  const anthropicStream = [
    sse('message_start', { message: { usage: { input_tokens: 1 } } }),
    sse('message_delta', { delta: { stop_reason: 'max_tokens' } }),
    sse('message_stop', {}),
  ]
  const responsesStream = [sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } })]

  const chatResult = await runAdapter(chat, chatStream, (endpoint, request) => openAiChatAdapter({ ...endpoint, stream: true }, request))
  assert.equal(chatResult.finish, 'max_output_tokens', "Chat Completions' length is the same fact")

  const anthropicResult = await runAdapter(anthropic, anthropicStream, anthropicVertexAdapter)
  assert.equal(anthropicResult.finish, 'max_output_tokens', "Anthropic's max_tokens is the same fact")

  const responsesResult = await runAdapter(responses, responsesStream, openAiResponsesAdapter)
  assert.equal(responsesResult.finish, 'max_output_tokens')
})

test('the loop treats exactly these two words as healthy, and they are the ones adapters emit', () => {
  assert.equal(canonicalFinishReason('stop'), 'stop')
  assert.equal(canonicalFinishReason('end_turn'), 'stop')
  assert.equal(canonicalFinishReason('completed'), 'stop')
  assert.equal(canonicalFinishReason('tool_use'), 'tool_calls')
  assert.equal(canonicalFinishReason('length'), 'max_output_tokens')
  // An unknown word is reported as itself rather than invented into a category.
  assert.equal(canonicalFinishReason('something_new'), 'something_new')
  // A provider that says "finished" while having asked for tools did not finish.
  assert.equal(canonicalFinishReason('completed', 2), 'tool_calls')
  assert.equal(canonicalFinishReason('end_turn', 1), 'tool_calls')
  // A cut reply stays cut even with calls in it.
  assert.equal(canonicalFinishReason('length', 1), 'max_output_tokens')
})
