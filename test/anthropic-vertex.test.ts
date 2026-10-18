import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { anthropicCall, anthropicChunks } from '../src/llm/adapters.ts'
import { wire } from '../src/llm/http.ts'
import type { EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * The Anthropic-on-Vertex wire shape.
 *
 * This is the shape a **standard** cloud deployment of Anthropic's models speaks — Vertex AI's publisher route,
 * `projects/<p>/locations/<r>/publishers/anthropic/models/<m>:streamRawPredict` — and the same shape an
 * enterprise gateway exposes when it forwards to that publisher. Two decisions are pinned here because they
 * are where a translation goes quietly wrong:
 *
 * - the **request body**, where Anthropic differs from the OpenAI shapes in ways the agent loop depends on: a
 *   system prompt is a top-level field rather than a message, a tool result is a user-role `tool_result`
 *   block, and a thinking block may **not** be sent back without the signature only the provider holds;
 * - the **event stream**, where a tool call arrives as a start block plus JSON fragments rather than as one
 *   finished object.
 *
 * The transport is judged next door (`src/llm/http.ts`), including the forwarding proxy an enterprise gateway
 * is usually reached through: the gateway itself is machine-local configuration, so the code that has to be
 * right is the one that can be judged with no network at all.
 */

const endpoint: EndpointConfig = {
  name: 'claude',
  kind: 'anthropic-vertex',
  baseUrl: 'http://gateway.example:443/v1',
  model: 'claude-opus-5-5',
  project: 'a-project',
  region: 'global',
  maxOutputTokens: 64,
  headers: { 'x-enterprise-inject': 'descriptor' },
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

test('the call is addressed to the publisher route, with the model and stream in the path', () => {
  const call = anthropicCall(endpoint, request)
  assert.equal(
    call.url,
    'http://gateway.example:443/v1/projects/a-project/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict',
    'the Vertex publisher route, terminating on the streaming verb',
  )
  assert.equal(call.body.anthropic_version, 'vertex-2023-10-16', 'the version travels in the body, as Vertex requires')
  assert.equal(call.body.stream, true, 'and so does the stream flag')
  assert.equal(call.body.max_tokens, 64, 'the endpoint’s own cap is the default')
  assert.equal(call.headers['X-Enterprise-Inject'], 'descriptor', 'configured headers reach the gateway')
})

test('a request names the model per call when the caller asks for another one', () => {
  const call = anthropicCall(endpoint, { ...request, model: 'claude-sonnet-5-5' })
  assert.match(call.url, /models\/claude-sonnet-5-5:streamRawPredict$/, 'the request’s model wins over the endpoint’s')
})

test('the system prompt, the tool call and the tool result are translated the way Anthropic reads them', () => {
  const call = anthropicCall(endpoint, request)
  assert.equal(call.body.system, 'be brief', 'a system message becomes the top-level system field')

  const messages = call.body.messages as { role: string; content: { type: string; [key: string]: unknown }[] }[]
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
    'the system prompt is not a message, and the tool result is a user turn',
  )
  assert.deepEqual(messages[1]?.content, [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: 'call-1', name: 'list_dir', input: { path: '.' } },
  ], 'a recorded tool call becomes a tool_use block with parsed input')
  assert.deepEqual(
    messages[2]?.content,
    [{ type: 'tool_result', tool_use_id: 'call-1', content: 'AGENTS.md' }],
    'and its answer becomes a tool_result block naming the call',
  )
  /**
   * Reasoning is **dropped**, and that is not an optimisation.
   *
   * An Anthropic thinking block carries a signature the provider issues when it generates it, and a block sent
   * back without that signature is refused. The harness records reasoning for its own reader; sending it would
   * turn every second round into a provider error.
   */
  assert.equal(JSON.stringify(messages).includes('the user wants a listing'), false, 'reasoning is not sent back')
})

test('tools are declared in the shape the route expects', () => {
  const call = anthropicCall(endpoint, {
    ...request,
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
  })
  assert.deepEqual(call.body.tools, [
    { name: 'bash', description: 'run a command', input_schema: { type: 'object', properties: {} } },
  ], 'a tool is name/description/input_schema')
})

test('a missing project or region is refused by name rather than sent as a broken URL', () => {
  assert.throws(
    () => anthropicCall({ ...endpoint, project: undefined }, request),
    /project/,
    'the project is part of the route and cannot be guessed',
  )
})

/** One event stream built from literal blocks, so the fold is judged without a socket. */
async function* events(...blocks: string[]): AsyncIterable<{ event?: string; data: string }> {
  for (const block of blocks) {
    const newline = block.indexOf('\n')
    if (newline === -1) yield { data: block }
    else yield { event: block.slice(0, newline), data: block.slice(newline + 1) }
  }
}

test('text, thinking and a streamed tool call fold into the harness vocabulary', async () => {
  const chunks = []
  for await (const chunk of anthropicChunks(
    events(
      'message_start\n{"type":"message_start","message":{"usage":{"input_tokens":12}}}',
      'content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      'content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
      'content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the "}}',
      'content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"bash"}}',
      'content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}',
      'content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"pwd\\"}"}}',
      'message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
      'message_stop\n{"type":"message_stop"}',
    ),
    'claude',
  )) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [
    { type: 'reasoning-delta', text: 'hmm' },
    { type: 'text-delta', text: 'the ' },
    { type: 'tool-call', id: 'tool-1', name: 'bash', arguments: '{"command":"pwd"}' },
    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 12, outputTokens: 7 } },
  ], 'the stream ends with the assembled call and one done chunk, in the loop\'s word for it')

  /**
   * The finish reason is the **loop's** word, not Anthropic's.
   *
   * This assertion used to pin `tool_use`, which is what the provider says; the agent loop knows only `stop` and
   * `tool_calls` and reports anything else as a stop notice on the answer, so every healthy Claude turn carried
   * one — measured 2026-10-18 as `ended: ['round 1: end_turn']`. The provider's word is translated once, in
   * `canonicalFinishReason`, and `test/finish-reasons.test.ts` drives all three adapters against doubles.
   */
})

test('an error event becomes a named failure rather than a silent end', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of anthropicChunks(
      events('error\n{"type":"error","error":{"type":"overloaded_error","message":"try later"}}'),
      'claude',
    )) {
      // the assertion is that iterating throws
    }
  }, /overloaded_error|try later/)
})

test('a request is forwarded through the configured proxy in absolute form', async () => {
  /**
   * The enterprise path is a **local forwarding agent** on loopback, which is what an endpoint's `proxy` field
   * names. What has to be true is measured here: the proxy receives the request line as an absolute URL (an
   * HTTP proxy's contract) carrying the target's host, and the body arrives unread.
   */
  const seen: { url?: string; host?: string; body?: string } = {}
  const proxy = createServer((incoming, response) => {
    let body = ''
    incoming.on('data', (chunk) => {
      body += chunk
    })
    incoming.on('end', () => {
      seen.url = incoming.url
      seen.host = String(incoming.headers.host ?? '')
      seen.body = body
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  const address = proxy.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const response = await wire({
      url: 'http://gateway.invalid:443/v1/projects/p/locations/global/publishers/anthropic/models/m:rawPredict',
      body: { hello: 'there' },
      stream: false,
      endpoint: 'claude',
      proxy: `http://127.0.0.1:${port}`,
    })
    assert.deepEqual(response, { json: { ok: true } }, 'the answer comes back through the proxy')
    assert.equal(
      seen.url,
      'http://gateway.invalid:443/v1/projects/p/locations/global/publishers/anthropic/models/m:rawPredict',
      'the proxy receives the absolute-form request line, which is how a proxy is addressed',
    )
    assert.equal(seen.host, 'gateway.invalid:443', 'and the request still names the host it is for')
    assert.equal(seen.body, '{"hello":"there"}', 'with the body forwarded')
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
})
