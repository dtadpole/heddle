import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { repoRoot } from '../../../verify-runner/lib.mjs'

/**
 * The wire formats, exercised against local doubles — the three families, with the Claude family's two envelopes.
 *
 * The live validation spends real calls per configured model; this suite is its offline counterpart and runs in
 * any checkout. One double per format answers with the event shape that format actually streams — reasoning,
 * text and a tool call — and the real adapter is driven over it, so a change to any adapter's event mapping is
 * caught here before it reaches a machine's endpoint list.
 */

const { adapterFor } = await import(pathToFileURL(join(repoRoot, 'dist', 'llm', 'adapters.js')).href)

/** Serve one SSE answer: read the request, write the frames the caller provides, close. */
async function double(frames) {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(frame)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

const tool = Object.freeze({ name: 'probe_echo', description: 'Echo a value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
const ask = Object.freeze({ messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'Call probe_echo with hello.' }] }]), tools: [tool] })

/** Collect an adapter's chunks, whatever the format. */
async function collect(endpoint) {
  const chunks = []
  for await (const chunk of adapterFor(endpoint).stream({ endpoint: endpoint.name, model: endpoint.model, ...ask })) chunks.push(chunk)
  return chunks
}

function judge(chunks, format) {
  const text = chunks.filter((chunk) => chunk.type === 'text-delta')
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta')
  const calls = chunks.filter((chunk) => chunk.type === 'tool-call')
  const done = chunks.filter((chunk) => chunk.type === 'done')
  assert.ok(text.length >= 2, `${format}: the answer arrives as separate text deltas (${text.length})`)
  assert.ok(text.map((chunk) => chunk.text).join('').includes('one two'), `${format}: and its words are in order`)
  assert.ok(reasoning.length >= 1, `${format}: reasoning arrives as its own delta (${reasoning.length})`)
  assert.equal(reasoning[0].text, 'thinking', `${format}: with the thinking text`)
  assert.equal(calls.length, 1, `${format}: one tool call is assembled`)
  assert.equal(calls[0].name, 'probe_echo', `${format}: under the name the route sent`)
  assert.equal(calls[0].arguments, '{"value":"hello"}', `${format}: with its streamed arguments`)
  assert.ok(done.length >= 1, `${format}: the stream ends on a done chunk`)
  assert.equal(done[0].finishReason, 'tool_calls', `${format}: finished for the tool call`)
}

test('the Chat Completions format streams text, reasoning and a tool call', async () => {
  const server = await double([
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'one ' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'two' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'probe_echo', arguments: '{"value":' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])
  try {
    judge(await collect({ name: 'chat', kind: 'openai-chat', baseUrl: server.baseUrl, model: 'm' }), 'chat')
  } finally {
    await server.close()
  }
})

test('the Responses format streams text, reasoning summary and a function call', async () => {
  const server = await double([
    `data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'one ' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'two' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe_echo' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"value":"hello"}' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'probe_echo', arguments: '{"value":"hello"}' }] } })}\n\n`,
  ])
  try {
    const chunks = await collect({ name: 'codex', kind: 'openai-responses', baseUrl: server.baseUrl, model: 'm' })
    judge(chunks, 'codex')
  } finally {
    await server.close()
  }
})

test('the Anthropic publisher format streams text, thinking and a tool use', async () => {
  const server = await double([
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one ' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'probe_echo' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"value":"hello"}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ])
  try {
    judge(await collect({ name: 'claude', kind: 'anthropic-vertex', baseUrl: server.baseUrl, model: 'm', project: 'p', region: 'global', maxOutputTokens: 64 }), 'claude')
  } finally {
    await server.close()
  }
})

test('Anthropic’s own Messages format streams text, thinking and a tool use', async () => {
  const server = await double([
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'one ' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'two' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'probe_echo', input: {} } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"value":' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"hello"}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ])
  try {
    judge(await collect({ name: 'claude-messages', kind: 'anthropic-messages', baseUrl: server.baseUrl, model: 'm', maxOutputTokens: 64 }), 'claude-messages')
  } finally {
    await server.close()
  }
})
