import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test } from 'node:test'

import { adapterFor, anthropicChunks } from '../src/llm/adapters.ts'
import type { Chunk, EndpointConfig } from '../src/llm/types.ts'

/**
 * A provider stream that did not finish is never a finished answer (#173).
 *
 * Measured on both builds with doubles (developer-four, J99 and later): a chat stream cut after three deltas, with no
 * `finish_reason` and no `[DONE]`, was recorded `finishReason: "stop"`; a tool call half-written when it was cut was
 * dropped on the chat route and run on the Messages route; a `data: {"error": …}` frame was skipped; an empty `stop`
 * was a finished answer with no text; and on the TS build alone the 120 s socket-idle limit ended a stalled stream as
 * if the provider had finished. DSH fails each: `STREAM_CLOSED`, the provider's words, `EMPTY_RESPONSE`, a timeout.
 *
 * The doubles answer **close-delimited** (`connection: close`, no length, no chunking) unless a case says otherwise:
 * that is the body form where Node ends the read normally when either side cuts it, which is what hid the cut.
 */

type Reply = (response: ServerResponse) => void

async function double(reply: Reply): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createServer((incoming, response) => {
    incoming.resume()
    incoming.on('end', () => reply(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** A close-delimited event stream: the frames, then (unless `hold`) the socket closes with no terminator. */
function streamed(frames: readonly string[], options: { readonly hold?: boolean } = {}): Reply {
  return (response) => {
    response.useChunkedEncodingByDefault = false
    response.shouldKeepAlive = false
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    for (const frame of frames) response.write(frame)
    if (options.hold !== true) response.end()
  }
}

const data = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const delta = (content: string) => data({ choices: [{ delta: { content } }] })
const event = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

/** Drain one call through the endpoint's real adapter; the chunks it gave before it ended, and how it ended. */
async function drain(
  endpoint: EndpointConfig,
  signal?: AbortSignal,
): Promise<{ readonly chunks: readonly Chunk[]; readonly error?: Error & { code?: string } }> {
  const chunks: Chunk[] = []
  try {
    for await (const chunk of adapterFor(endpoint).stream({ endpoint: endpoint.name, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }, signal)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error) {
    return { chunks, error: error as Error & { code?: string } }
  }
}

const chat = (baseUrl: string, extra: Partial<EndpointConfig> = {}): EndpointConfig => ({ name: 'chat', kind: 'openai-chat', baseUrl, model: 'm', ...extra })

test('a chat stream cut with no finish_reason and no [DONE] fails STREAM_CLOSED, not stop', async () => {
  const provider = await double(streamed([delta('PARTIAL-99 '), delta('alpha '), delta('beta ')]))
  try {
    const result = await drain(chat(provider.baseUrl))
    assert.equal(result.error?.code, 'STREAM_CLOSED', `${String(result.error)}`)
    assert.equal(result.error?.message, "'chat' ended its stream before the answer finished (no finish_reason or [DONE])")
    assert.equal(result.chunks.some((chunk) => chunk.type === 'done'), false, 'no done: the fragment is not a finished answer')
  } finally {
    await provider.close()
  }
})

test('a chat tool call the cut left half-written is never emitted', async () => {
  const provider = await double(
    streamed([
      delta('Running it now. '),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bash', arguments: '{"command": "echo DRO' } }] } }] }),
    ]),
  )
  try {
    const result = await drain(chat(provider.baseUrl))
    assert.equal(result.error?.code, 'STREAM_CLOSED')
    assert.equal(result.chunks.some((chunk) => chunk.type === 'tool-call'), false, 'the half-written call is not assembled')
  } finally {
    await provider.close()
  }
})

test('a finish frame, or [DONE] alone, still ends a chat answer as before', async () => {
  for (const tail of [data({ choices: [{ delta: {}, finish_reason: 'stop' }] }), data('[DONE]')]) {
    const provider = await double(streamed([delta('whole'), tail]))
    try {
      const result = await drain(chat(provider.baseUrl))
      assert.equal(result.error, undefined, `${String(result.error)}`)
      assert.deepEqual(result.chunks.at(-1), { type: 'done', finishReason: 'stop' })
    } finally {
      await provider.close()
    }
  }
})

test("an error object inside a chat stream fails in the provider's words", async () => {
  const provider = await double(
    streamed([
      delta('Partial answer before the error'),
      data({ error: { message: 'Internal server error (fake mid-stream)', type: 'server_error', code: 'internal_error' } }),
    ]),
  )
  try {
    const result = await drain(chat(provider.baseUrl))
    assert.equal(result.error?.code, 'REMOTE')
    assert.equal(result.error?.message, "'chat' reported server_error — Internal server error (fake mid-stream)")
  } finally {
    await provider.close()
  }
})

test('an empty stop fails EMPTY_RESPONSE; reasoning, a tool call or an output limit is not empty', async () => {
  const role = data({ choices: [{ delta: { role: 'assistant', content: '' } }] })
  const stop = data({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 0 } })
  const empty = await double(streamed([role, stop, data('[DONE]')]))
  try {
    const result = await drain(chat(empty.baseUrl))
    assert.equal(result.error?.code, 'EMPTY_RESPONSE')
    assert.equal(result.error?.message, "'chat' returned a completed response with no content")
  } finally {
    await empty.close()
  }
  const answered = [
    [data({ choices: [{ delta: { reasoning_content: 'thinking' } }] }), stop],
    [data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{}' } }] } }] }), data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })],
    [role, data({ choices: [{ delta: {}, finish_reason: 'length' }] }), data('[DONE]')],
  ]
  for (const frames of answered) {
    const provider = await double(streamed(frames))
    try {
      const result = await drain(chat(provider.baseUrl))
      assert.equal(result.error, undefined, `${String(result.error)}`)
    } finally {
      await provider.close()
    }
  }
})

test('a Messages stream cut before its stop reason fails and emits no half-written call; one cut after it is whole', async () => {
  async function* frames(list: readonly { readonly event: string; readonly data: string }[]) {
    yield* list
  }
  const at = (type: string, payload: Record<string, unknown>) => ({ event: type, data: JSON.stringify({ type, ...payload }) })
  const head = [
    at('message_start', { message: {} }),
    at('content_block_start', { index: 0, content_block: { type: 'text' } }),
    at('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Running it now. ' } }),
    at('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } }),
    at('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "echo DRO' } }),
  ]
  const chunks: Chunk[] = []
  await assert.rejects(
    (async () => {
      for await (const chunk of anthropicChunks(frames(head), 'claude')) chunks.push(chunk)
    })(),
    (error: Error & { code?: string }) => error.code === 'STREAM_CLOSED' && error.message === "'claude' ended its stream before the answer finished (no message_stop)",
  )
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call'), false, 'the half-written call is not emitted')

  const whole: Chunk[] = []
  const finished = [at('message_start', { message: {} }), at('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }), at('message_delta', { delta: { stop_reason: 'end_turn' } })]
  for await (const chunk of anthropicChunks(frames(finished), 'claude')) whole.push(chunk)
  assert.deepEqual(whole.at(-1), { type: 'done', finishReason: 'stop' }, 'every block is closed once the stop reason came')
})

test('over the wire, a Messages stream cut mid-answer fails the same way', async () => {
  const provider = await double(
    streamed([event('message_start', { message: {} }), event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PARTIAL-99 ' } })]),
  )
  try {
    const result = await drain({ name: 'claude', kind: 'anthropic-messages', baseUrl: provider.baseUrl, model: 'm' })
    assert.equal(result.error?.code, 'STREAM_CLOSED', `${String(result.error)}`)
  } finally {
    await provider.close()
  }
})

test('a stream that stalls past the idle limit fails TIMEOUT, as the Rust build does, instead of ending as an answer', async () => {
  const provider = await double(streamed([delta('Partial answer before the stall')], { hold: true }))
  try {
    const started = Date.now()
    const result = await drain(chat(provider.baseUrl, { timeoutMs: 400 }))
    assert.equal(result.error?.code, 'TIMEOUT', `${String(result.error)}`)
    assert.equal(result.error?.message, "the request to 'chat' timed out after 400ms")
    assert.ok(Date.now() - started < 10_000, 'it ends at the limit')
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.type),
      ['text-delta'],
      'the fragment arrived, and nothing finished it',
    )
  } finally {
    await provider.close()
  }
})

test('a Stop during a close-delimited stream fails ABORTED rather than ending the body as a whole answer', async () => {
  const provider = await double(streamed([delta('a compact brief')], { hold: true }))
  try {
    const controller = new AbortController()
    const chunks: Chunk[] = []
    let failure: (Error & { code?: string }) | undefined
    try {
      for await (const chunk of adapterFor(chat(provider.baseUrl)).stream({ endpoint: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }, controller.signal)) {
        chunks.push(chunk)
        if (chunk.type === 'text-delta') controller.abort()
      }
    } catch (error) {
      failure = error as Error & { code?: string }
    }
    assert.equal(failure?.code, 'ABORTED', `${String(failure)}`)
    assert.equal(chunks.some((chunk) => chunk.type === 'done'), false)
  } finally {
    await provider.close()
  }
})

test('a chunked body the provider resets mid-answer fails TRANSPORT with the endpoint named', async () => {
  const provider = await double((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(delta('half '))
    setTimeout(() => response.socket?.destroy(), 20)
  })
  try {
    const result = await drain(chat(provider.baseUrl))
    assert.equal(result.error?.code, 'TRANSPORT', `${String(result.error)}`)
    assert.match(result.error?.message ?? '', /^the request to 'chat' could not be read — /)
  } finally {
    await provider.close()
  }
})

test('an answer whose provider keeps the connection open after [DONE] lets go of it once the adapter has the answer', async () => {
  /**
   * Found by check-backends against a real provider: the turn answered "ready" and then the `--turn` process stayed up
   * until the provider let the socket go, because the body was no longer handed back when the adapter stopped reading.
   * The double sends the whole answer on a chunked keep-alive body and never ends it.
   */
  let released: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    released = resolve
  })
  const provider = await double((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(delta('ready'))
    response.write(data({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    response.write(data('[DONE]'))
    response.on('close', () => released?.())
  })
  try {
    const result = await drain(chat(provider.baseUrl))
    assert.equal(result.error, undefined, `${String(result.error)}`)
    assert.deepEqual(result.chunks.at(-1), { type: 'done', finishReason: 'stop' })
    const outcome = await Promise.race([closed.then(() => 'released'), new Promise((resolve) => setTimeout(() => resolve('held'), 2000))])
    assert.equal(outcome, 'released', 'the connection is let go once the answer is whole')
  } finally {
    await provider.close()
  }
})
