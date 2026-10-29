import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { test } from 'node:test'

import {
  ANTHROPIC_MESSAGES_VERSION,
  DEFAULT_MAX_TOKENS,
  adapterFor,
  anthropicMessageChunks,
  anthropicMessagesCall,
  anthropicThinking,
} from '../src/llm/adapters.ts'
import { ModelError, type Chunk, type EndpointConfig, type GenerateRequest, type ReasoningLevels } from '../src/llm/types.ts'

/**
 * Anthropic's own Messages API, `POST {baseUrl}/messages`.
 *
 * The kind exists for a measured reason (2026-10-29): the Conclave gateway serves Claude on its Chat Completions
 * route **buffered** — a 30-line count arrived as one content chunk — while its `/v1/messages` streams the same answer
 * as it is written. Three things are pinned here, each the place a translation goes quietly wrong:
 *
 * - the **request**: the model in the body and the version in a header (the publisher route has both the other way
 *   round), the declared level's value choosing adaptive thinking or a token budget, the cap covering a budget, and
 *   no temperature beside thinking — each a refusal from the route when wrong;
 * - the **stream**, through the real transport against a local double: incremental arrival (the double withholds
 *   the rest of its body until the first text delta has reached the caller), summarized thinking, and a tool call
 *   whose fragments are passed on live as well as assembled;
 * - the **credential**: `x-api-key` on the wire, and never in the prepared call that a log or a test could print.
 */

const levels: ReasoningLevels = {
  default: 'high',
  levels: [
    { id: 'default', name: 'Default', value: null },
    { id: 'high', name: 'High', value: 'high' },
    { id: 'budget', name: 'Budget', value: 2048 },
  ],
}

const endpoint: EndpointConfig = {
  name: 'claude',
  kind: 'anthropic-messages',
  baseUrl: 'http://gateway.example:8088/v1',
  model: 'claude-model',
  maxOutputTokens: 64,
  apiKey: 'sk-secret-never-printed',
  headers: { 'x-gateway-inject': 'descriptor' },
  reasoning: levels,
}

const request: GenerateRequest = {
  endpoint: 'claude',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'what is here?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'reasoning', text: 'the user wants a listing' },
        { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{"path":"."}' },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'AGENTS.md' }] },
  ],
}

test('the call goes to {baseUrl}/messages with the model in the body and the version in a header', () => {
  const call = anthropicMessagesCall(endpoint, request)
  assert.equal(call.url, 'http://gateway.example:8088/v1/messages', 'the Messages route under the versioned root')
  assert.equal(call.body.model, 'claude-model', 'the model travels in the body, not the path')
  assert.equal(call.body.stream, true, 'and the call streams by default')
  assert.equal(call.stream, true)
  assert.equal(call.body.max_tokens, 64, 'the endpoint’s own cap is the default')
  assert.equal('anthropic_version' in call.body, false, 'the body carries no version: that is the publisher route’s rule')
  assert.equal(call.headers['Anthropic-Version'], ANTHROPIC_MESSAGES_VERSION, 'the version is a header here')
  assert.equal(call.headers['X-Gateway-Inject'], 'descriptor', 'configured headers reach the gateway, Title-Cased')
})

test('the prepared call never carries the credential', () => {
  const call = anthropicMessagesCall(endpoint, request)
  assert.equal(JSON.stringify(call).includes('sk-secret-never-printed'), false, 'the key is added only when the adapter sends')
})

test('a configured header of the same name pins a different version', () => {
  const call = anthropicMessagesCall({ ...endpoint, headers: { 'anthropic-version': '2099-01-01' } }, request)
  assert.equal(call.headers['Anthropic-Version'], '2099-01-01')
})

test('the request names the model per call, and an endpoint with none is refused by name', () => {
  assert.equal(anthropicMessagesCall(endpoint, { ...request, model: 'claude-sonnet-4-5' }).body.model, 'claude-sonnet-4-5')
  const { model: _unused, ...unnamed } = endpoint
  assert.throws(
    () => anthropicMessagesCall(unnamed, request),
    (error: unknown) => error instanceof ModelError && error.code === 'NO_MODEL',
  )
})

test('the conversation is translated the way Anthropic reads it, and reasoning is never replayed', () => {
  const call = anthropicMessagesCall(endpoint, request)
  assert.equal(call.body.system, 'be brief', 'a system message becomes the top-level system field')
  const messages = call.body.messages as { role: string; content: Record<string, unknown>[] }[]
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.deepEqual(messages[1]?.content, [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: 'call-1', name: 'list_dir', input: { path: '.' } },
  ])
  assert.deepEqual(messages[2]?.content, [{ type: 'tool_result', tool_use_id: 'call-1', content: 'AGENTS.md' }])
  assert.equal(JSON.stringify(call.body).includes('the user wants a listing'), false, 'no thinking block without a signature')
})

test('tools are declared with an input schema', () => {
  const call = anthropicMessagesCall(endpoint, {
    ...request,
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
  })
  assert.deepEqual(call.body.tools, [{ name: 'bash', description: 'run a command', input_schema: { type: 'object', properties: {} } }])
})

test('an effort level asks for adaptive, summarized thinking with that effort', () => {
  const call = anthropicMessagesCall(endpoint, { ...request, reasoningEffort: 'high' })
  assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(call.body.output_config, { effort: 'high' })
  assert.equal(call.body.max_tokens, 64, 'an effort has no budget to make room for')
})

test('a budget level asks for enabled, summarized thinking, and the cap is raised to leave room for the answer', () => {
  const call = anthropicMessagesCall(endpoint, { ...request, reasoningEffort: 'budget' })
  assert.deepEqual(call.body.thinking, { type: 'enabled', budget_tokens: 2048, display: 'summarized' })
  assert.equal('output_config' in call.body, false)
  assert.equal(call.body.max_tokens, 2048 + 64, 'max_tokens must exceed the budget, so the caller’s cap is added to it')

  const roomy = anthropicMessagesCall({ ...endpoint, maxOutputTokens: 8192 }, { ...request, reasoningEffort: 'budget' })
  assert.equal(roomy.body.max_tokens, 8192, 'a cap already above the budget is left alone')

  const unset = anthropicMessagesCall({ ...endpoint, maxOutputTokens: undefined }, { ...request, reasoningEffort: 'budget' })
  assert.equal(unset.body.max_tokens, DEFAULT_MAX_TOKENS, 'the conservative default already exceeds this budget')
})

test('a level whose value is null sends nothing, and an undeclared one is refused loudly', () => {
  const quiet = anthropicMessagesCall(endpoint, { ...request, reasoningEffort: 'default' })
  assert.equal('thinking' in quiet.body, false)
  assert.equal('output_config' in quiet.body, false)
  assert.throws(
    () => anthropicMessagesCall(endpoint, { ...request, reasoningEffort: 'ultra' }),
    (error: unknown) => error instanceof ModelError && error.code === 'UNSUPPORTED_REASONING_EFFORT' && /default, high, budget/.test(error.message),
  )
})

test('a temperature is sent without thinking and dropped beside it', () => {
  assert.equal(anthropicMessagesCall(endpoint, { ...request, temperature: 0.2 }).body.temperature, 0.2)
  const thinking = anthropicMessagesCall(endpoint, { ...request, temperature: 0.2, reasoningEffort: 'high' })
  assert.equal('temperature' in thinking.body, false, 'the route refuses any temperature but 1 when thinking is on')
})

test('the thinking form follows the value: a string is an effort, a number a budget, null nothing', () => {
  assert.deepEqual(anthropicThinking('max'), { thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: 'max' } })
  assert.deepEqual(anthropicThinking(4096), { thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' }, budget: 4096 })
  assert.deepEqual(anthropicThinking(null), {})
  assert.deepEqual(anthropicThinking(undefined), {})
})

test('an endpoint that turns streaming off asks for one JSON message', () => {
  const call = anthropicMessagesCall({ ...endpoint, stream: false }, request)
  assert.equal(call.body.stream, false)
  assert.equal(call.stream, false)
})

test('a JSON answer folds into the same chunks as a stream', () => {
  const chunks = [
    ...anthropicMessageChunks({
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'weighing it', signature: 'sig' },
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'toolu_1', name: 'probe_echo', input: { value: 'hello' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 383, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  ]
  assert.deepEqual(chunks.slice(0, 3), [
    { type: 'reasoning-delta', text: 'weighing it' },
    { type: 'text-delta', text: 'calling' },
    { type: 'tool-call', id: 'toolu_1', name: 'probe_echo', arguments: '{"value":"hello"}' },
  ])
  const done = chunks[3]
  assert.equal(done?.type, 'done')
  assert.equal(done?.type === 'done' ? done.finishReason : '', 'tool_calls', 'the loop’s word for tool_use')
  assert.equal(done?.type === 'done' ? done.usage?.inputTokens : 0, 383)
  assert.equal(done?.type === 'done' ? done.usage?.outputTokens : 0, 50)
  assert.deepEqual([...anthropicMessageChunks({ content: [], stop_reason: 'end_turn' })], [{ type: 'done', finishReason: 'stop' }])
})

/** What the double saw of one request. */
interface Seen {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** A local double for the Messages route, answering each request with `answer`. */
async function messagesDouble(answer: (seen: Seen, response: ServerResponse) => void | Promise<void>) {
  const seen: Seen[] = []
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.on('data', (chunk) => {
      body += chunk
    })
    incoming.on('end', () => {
      const entry = { url: incoming.url ?? '', headers: incoming.headers, body }
      seen.push(entry)
      void answer(entry, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function event(response: ServerResponse, type: string, payload: Record<string, unknown>): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
}

test('a streamed answer arrives as it is written, with summarized thinking and a live tool call', async () => {
  let release: (by: string) => void = () => {}
  const released = new Promise<string>((resolve) => {
    release = resolve
  })
  const double = await messagesDouble(async (seen, response) => {
    if (seen.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    event(response, 'message_start', { message: { usage: { input_tokens: 9 } } })
    event(response, 'content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    event(response, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } })
    event(response, 'content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
    event(response, 'content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
    event(response, 'content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'one ' } })
    // The rest is withheld until the caller has the first text delta: a buffering adapter never gets it.
    await released
    event(response, 'content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'two' } })
    event(response, 'content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'probe_echo', input: {} } })
    event(response, 'content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"value":' } })
    event(response, 'content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"hello"}' } })
    event(response, 'message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } })
    event(response, 'message_stop', {})
    response.end()
  })
  const guard = setTimeout(() => release('timer'), 5_000)
  const chunks: Chunk[] = []
  let releasedBy = ''
  try {
    const adapter = adapterFor({ ...endpoint, baseUrl: double.baseUrl })
    for await (const chunk of adapter.stream({ ...request, reasoningEffort: 'high' })) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta' && releasedBy === '') {
        releasedBy = 'the first text delta'
        release(releasedBy)
      }
    }
  } finally {
    clearTimeout(guard)
    await double.close()
  }
  assert.equal(await released, 'the first text delta', 'the first delta reached the caller while the body was still open')

  assert.deepEqual(chunks, [
    { type: 'reasoning-delta', text: 'weighing it' },
    { type: 'text-delta', text: 'one ' },
    { type: 'text-delta', text: 'two' },
    { type: 'tool-call-delta', index: 2, id: 'toolu_1', name: 'probe_echo', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: '{"value":' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: '"hello"}' },
    { type: 'tool-call', id: 'toolu_1', name: 'probe_echo', arguments: '{"value":"hello"}' },
    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 9, outputTokens: 12 } },
  ])

  const call = double.seen[0]
  assert.ok(call !== undefined, 'the double was called')
  assert.equal(call.headers['x-api-key'], 'sk-secret-never-printed', 'the credential travels as Anthropic’s header')
  assert.equal(call.headers.authorization, undefined, 'and not as a bearer token, which Anthropic’s own API does not take')
  assert.equal(call.headers['anthropic-version'], ANTHROPIC_MESSAGES_VERSION)
  assert.equal(call.headers['x-gateway-inject'], 'descriptor')
  assert.match(String(call.headers.accept), /text\/event-stream/)
  const body = JSON.parse(call.body) as Record<string, unknown>
  assert.equal(body.model, 'claude-model')
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
})

test('an endpoint with streaming off reads one JSON message through the same adapter', async () => {
  const double = await messagesDouble((_seen, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'whole' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }))
  })
  const chunks: Chunk[] = []
  try {
    for await (const chunk of adapterFor({ ...endpoint, baseUrl: double.baseUrl, stream: false }).stream(request)) chunks.push(chunk)
  } finally {
    await double.close()
  }
  assert.deepEqual(chunks, [
    { type: 'text-delta', text: 'whole' },
    { type: 'done', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } },
  ])
  assert.equal((JSON.parse(double.seen[0]?.body ?? '{}') as { stream?: boolean }).stream, false)
})

test('a refusal is a named failure carrying the status, and an error event ends the stream loudly', async () => {
  const refusing = await messagesDouble((_seen, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'adaptive thinking is not supported on this model' } }))
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of adapterFor({ ...endpoint, baseUrl: refusing.baseUrl }).stream(request)) {
        // iterating is the assertion
      }
    }, (error: unknown) => error instanceof ModelError && error.status === 400 && /adaptive thinking is not supported/.test(error.message))
  } finally {
    await refusing.close()
  }

  const failing = await messagesDouble((_seen, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    event(response, 'error', { error: { type: 'overloaded_error', message: 'try later' } })
    response.end()
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of adapterFor({ ...endpoint, baseUrl: failing.baseUrl }).stream(request)) {
        // iterating is the assertion
      }
    }, (error: unknown) => error instanceof ModelError && error.code === 'REMOTE' && /overloaded_error/.test(error.message))
  } finally {
    await failing.close()
  }
})
