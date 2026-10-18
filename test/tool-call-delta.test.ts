import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openAiChatAdapter } from '../src/llm/adapters.ts'
import type { Chunk, EndpointConfig } from '../src/llm/types.ts'
import { SessionStore, type SessionEvent } from '../src/session/store.ts'

/**
 * A tool call is shown **while it is written**, and recorded only once it is whole.
 *
 * Measured 2026-10-18 at the owner's address against the DeepSeek route behind the plugboard interface: a
 * `write_file` call's 4060-character argument arrived at the wire as 793 fragments over 2.7s, and the page then
 * sat silent for 3.7s (deepseek-flash) to 14.1s (deepseek-v4-pro) before a finished card appeared in one step —
 * because the Chat adapter folded every fragment and yielded one `tool-call` at `finish_reason`, and the chunk
 * union had no variant a partial call could travel in.
 *
 * Two claims, judged separately because they can fail separately:
 *
 * - **the adapter** passes each fragment on as a `tool-call-delta` the moment it lands, *and* still yields the one
 *   complete `tool-call` every existing consumer reads;
 * - **the store** publishes those fragments to live listeners and keeps them **out of the log**, so the transcript,
 *   the trajectory and the surface — which all read the log — never see a fragment.
 */

const endpoint: EndpointConfig = { name: 'chat', kind: 'openai-chat', baseUrl: '', model: 'm' }
const ask = { endpoint: 'chat', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }] }

/** A double that streams one tool call as three argument fragments, with a gap between each. */
async function withToolStream<T>(gapMs: number, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const frames = [
    { index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt",' } },
    { index: 0, function: { arguments: '"content":"one ' } },
    { index: 0, function: { arguments: 'two"}' } },
  ]
  const server = createServer((incoming, response) => {
    incoming.resume()
    incoming.on('end', async () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const call of frames) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, gapMs))
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('each fragment of a tool call reaches the caller as it lands, not at the end of the round', async () => {
  const arrivals: { at: number; chunk: Chunk }[] = []
  await withToolStream(120, async (baseUrl) => {
    const started = performance.now()
    for await (const chunk of openAiChatAdapter({ ...endpoint, baseUrl }, ask)) {
      arrivals.push({ at: performance.now() - started, chunk })
    }
  })
  const deltas = arrivals.filter((entry) => entry.chunk.type === 'tool-call-delta')
  assert.equal(deltas.length, 3, 'three provider fragments are three live chunks')
  const spread = deltas[deltas.length - 1]!.at - deltas[0]!.at
  assert.ok(spread >= 180, `the fragments arrive across the route's writing time, not in one burst (spread ${spread.toFixed(0)}ms)`)
  const first = deltas[0]!.chunk as Extract<Chunk, { type: 'tool-call-delta' }>
  assert.equal(first.name, 'write_file', 'the first fragment names the tool, so a card can be titled before it is finished')
  assert.equal(first.id, 'call_1')
  assert.equal(
    deltas.map((entry) => (entry.chunk as Extract<Chunk, { type: 'tool-call-delta' }>).argumentsDelta).join(''),
    '{"path":"a.txt","content":"one two"}',
    'the fragments concatenate to the arguments the provider wrote',
  )
})

test('the complete call still arrives once, after its fragments, so every existing consumer is unchanged', async () => {
  const chunks: Chunk[] = []
  await withToolStream(0, async (baseUrl) => {
    for await (const chunk of openAiChatAdapter({ ...endpoint, baseUrl }, ask)) chunks.push(chunk)
  })
  const calls = chunks.filter((chunk) => chunk.type === 'tool-call')
  assert.equal(calls.length, 1, 'one complete call')
  assert.deepEqual(calls[0], { type: 'tool-call', id: 'call_1', name: 'write_file', arguments: '{"path":"a.txt","content":"one two"}' })
  const lastDelta = chunks.map((chunk) => chunk.type).lastIndexOf('tool-call-delta')
  assert.ok(lastDelta < chunks.indexOf(calls[0]!), 'and it follows the last fragment')
  assert.equal(chunks[chunks.length - 1]?.type, 'done')
})

test('the store publishes a fragment to live listeners and never writes it to the log', () => {
  const root = mkdtempSync(join(tmpdir(), 'heddle-tool-delta-'))
  try {
    const published: SessionEvent[] = []
    const store = new SessionStore(join(root, 'store'), { onEvent: (_handle, event) => published.push(event) })
    const handle = store.create({ cwd: root })
    const before = store.count(handle)

    store.assistantChunk(handle, { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'write_file', argumentsDelta: '{"a":' })
    store.assistantChunk(handle, { type: 'tool-call-delta', index: 0, argumentsDelta: '1}' })
    store.assistantChunk(handle, { type: 'tool-call', id: 'call_1', name: 'write_file', arguments: '{"a":1}' })

    const live = published.filter((event) => event.type === 'assistant/chunk')
    assert.equal(live.length, 3, 'a live listener sees both fragments and the call')
    assert.equal(live[0]!.transient, true, 'a fragment says it is not a record')
    assert.equal(live[2]!.transient, undefined, 'the call is a record')

    const recorded = store.read(handle).filter((event) => event.type === 'assistant/chunk')
    assert.equal(recorded.length, 1, 'the log holds the complete call and nothing else')
    assert.equal((recorded[0]!.chunk as Chunk).type, 'tool-call')
    assert.equal(store.count(handle), before + 1, 'and its sequence has no hole where the fragments were')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
