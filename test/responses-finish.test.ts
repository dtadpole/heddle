import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { openAiResponsesAdapter, responsesFinishReason } from '../src/llm/adapters.ts'
import type { Chunk, EndpointConfig } from '../src/llm/types.ts'

/**
 * How a Responses stream ends, in the loop's words.
 *
 * The agent loop treats `stop` and `tool_calls` as healthy and reports any other finish as a stop reason on the
 * answer. The Responses shape does not use those words, and two defects followed, both measured against a live
 * Meta-internal Codex route on 2026-10-18:
 *
 * - the adapter passed the response's `status` through, so every finished answer arrived as `completed` and was
 *   logged with `ended: ['round 1: completed']` — a notice on every healthy turn;
 * - the adapter did not recognise `response.incomplete`, which is how the route ends a reply cut by its token
 *   budget, so a reasoning model that spent the budget thinking returned an empty answer reported as `stop`.
 *
 * The double below speaks the route's real terminal events, and the checks drain the real adapter.
 */

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

async function finishOf(events: readonly string[]): Promise<{ readonly finish: string; readonly text: string; readonly calls: number }> {
  const server = createServer((incoming, response) => {
    incoming.resume()
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(event)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const endpoint: EndpointConfig = { name: 'double', kind: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }
  let finish = ''
  let text = ''
  let calls = 0
  try {
    const stream = openAiResponsesAdapter(endpoint, { endpoint: 'double', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    for await (const chunk of stream as AsyncIterable<Chunk>) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'tool-call') calls += 1
      if (chunk.type === 'done') finish = chunk.finishReason
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { finish, text, calls }
}

test('a finished answer is a stop, not the route\'s own word for it', async () => {
  const result = await finishOf([
    sse('response.output_text.delta', { delta: 'ok' }),
    sse('response.completed', { response: { status: 'completed', output: [] } }),
  ])
  assert.equal(result.text, 'ok')
  assert.equal(result.finish, 'stop', 'completed is the healthy end, which the loop calls stop')
})

test('a round that asked for a tool ends as tool_calls', async () => {
  const result = await finishOf([
    sse('response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash' } }),
    sse('response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"command":"pwd"}' }),
    sse('response.completed', { response: { status: 'completed', output: [] } }),
  ])
  assert.equal(result.calls, 1)
  assert.equal(result.finish, 'tool_calls')
})

test('a reply cut by its budget reports why, rather than an empty stop', async () => {
  const result = await finishOf([
    sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }),
  ])
  assert.equal(result.text, '', 'the model spent the budget before writing anything')
  assert.equal(result.finish, 'max_output_tokens', 'and the loop is told, so the answer carries the reason')
})

test('a stream that closes without a terminal event is not a normal stop', async () => {
  const result = await finishOf([sse('response.output_text.delta', { delta: 'partial' })])
  assert.equal(result.text, 'partial')
  assert.equal(result.finish, 'stream_ended')
})

test('the mapping itself, for the cases the double does not need a server for', () => {
  assert.equal(responsesFinishReason('response.completed', undefined, 0), 'stop')
  assert.equal(responsesFinishReason('response.completed', undefined, 2), 'tool_calls')
  assert.equal(responsesFinishReason('response.incomplete', 'content_filter', 0), 'content_filter')
  assert.equal(responsesFinishReason('response.incomplete', undefined, 0), 'incomplete')
})
