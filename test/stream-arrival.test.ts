import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { openAiChatAdapter } from '../src/llm/adapters.ts'
import type { Chunk, EndpointConfig } from '../src/llm/types.ts'

/**
 * The arrival of a Chat answer, judged at the adapter — the layer every model call passes through.
 *
 * Two claims, and they fail for different reasons:
 *
 * - **the request asks to stream**, because a route that is not asked answers one body and no downstream code can
 *   recover the missing time (types.ts states the design: every call is a stream);
 * - **the deltas reach the caller while the route is still writing**, because a parser that collects the whole
 *   stream and then yields its deltas satisfies the first claim and still leaves the page drawing a finished answer.
 *
 * Measured 2026-10-18 against plugboard-d's DeepSeek route at the owner's address: the wire streams a 570-character
 * answer as 229 deltas over ~0.8s, the adapter yielded 187 text deltas over 0.4-1.3s once the request asked to
 * stream, and the request a turn built on `main` asked **not** to, so the delivered page received one 570-character
 * delta at 2435ms. These checks were written red against that build before any fix.
 *
 * The double honours the `stream` flag it is asked for — a double that always streams cannot tell a streaming
 * client from a non-streaming one.
 */
type TestRequest = Parameters<typeof openAiChatAdapter>[1]

/** A route that streams when asked and answers one body when not, recording the request it received. */
async function route(
  style: 'honour' | 'json',
): Promise<{ readonly run: (adapter: (endpoint: EndpointConfig, request: TestRequest) => AsyncIterable<Chunk>) => Promise<{ readonly body: Record<string, unknown>; readonly chunks: readonly Chunk[]; readonly arrivals: readonly number[] }> }> {
  const seen: { body: Record<string, unknown> } = { body: {} }
  const server = createServer((incoming, response) => {
    let raw = ''
    incoming.on('data', (chunk) => (raw += chunk))
    incoming.on('end', () => {
      seen.body = JSON.parse(raw) as Record<string, unknown>
      const asked = seen.body.stream === true && style === 'honour'
      if (!asked) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: 'one two' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'one' }, finish_reason: null }] })}\n\n`)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' two' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, 200)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base: EndpointConfig = { name: 'chat', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, model: 'm' }
  const request: TestRequest = { endpoint: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  return {
    async run(adapter) {
      const chunks: Chunk[] = []
      const arrivals: number[] = []
      try {
        for await (const chunk of adapter(base, request)) {
          chunks.push(chunk)
          if (chunk.type === 'text-delta') arrivals.push(performance.now())
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      return { body: seen.body, chunks, arrivals }
    },
  }
}

test('a chat call asks the route to stream even when nothing says so', async () => {
  const { run } = await route('honour')
  const { body } = await run(openAiChatAdapter)
  assert.equal(body.stream, true, 'the wire is asked to stream by default, as the other two shapes already are')
})

test('the text deltas reach the caller while the route is still writing', async () => {
  const { run } = await route('honour')
  const { chunks, arrivals } = await run(openAiChatAdapter)
  const texts = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)
  assert.deepEqual(texts, ['one', ' two'], 'both deltas arrive, in order')
  assert.ok(arrivals.length === 2, `the answer arrives as separate deltas, not one folded body (${arrivals.length})`)
  const spread = arrivals[1] - arrivals[0]
  assert.ok(spread >= 150, `the second delta is read after the route waits, not at the end (${Math.round(spread)}ms after the first)`)
})

test('an event stream with no content type still streams, not buffered', async () => {
  /**
   * The mirror case of the JSON body: a route can stream an event body **without labelling it** (measured on the
   * Codex route's Responses stream). A first-byte peek must replay that first chunk and keep the rest live; a fix
   * that buffered every unlabelled body would make this answer arrive as one burst.
   */
  const server = createServer((incoming, response) => {
    incoming.on('data', () => {})
    incoming.on('end', () => {
      response.writeHead(200)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'one' }, finish_reason: null }] })}\n\n`)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' two' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, 200)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base: EndpointConfig = { name: 'chat', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${port}`, model: 'm' }
  const request: TestRequest = { endpoint: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const arrivals: number[] = []
  const texts: string[] = []
  try {
    for await (const chunk of openAiChatAdapter(base, request)) {
      if (chunk.type === 'text-delta') {
        arrivals.push(performance.now())
        texts.push(chunk.text)
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.deepEqual(texts, ['one', ' two'], 'both deltas arrive, in order')
  assert.ok(arrivals[1] - arrivals[0] >= 150, `an unlabelled stream keeps its pacing (${Math.round(arrivals[1] - arrivals[0])}ms)`)
})

test('a route that answers one JSON body is still read whole', async () => {
  /**
   * The other half: asking to stream must not empty a provider that ignores the flag. This is the case the peek in
   * `http.ts` exists for, and it is asserted here so a fix for the default cannot silently break a buffered route.
   */
  const { run } = await route('json')
  const { chunks } = await run(openAiChatAdapter)
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text-delta', 'done'],
    'one body is folded into the same two chunks',
  )
  const text = chunks.find((chunk) => chunk.type === 'text-delta')
  assert.equal(text?.type === 'text-delta' ? text.text : '', 'one two', 'with its whole content')
})
