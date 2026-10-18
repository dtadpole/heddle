import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { describeEndpoint, selectionProblem } from '../src/endpoints.ts'
import { openAiChatAdapter, openAiResponsesAdapter, anthropicCall } from '../src/llm/adapters.ts'
import type { EndpointConfig, GenerateRequest } from '../src/llm/types.ts'

/**
 * The two-tier catalogue and the reasoning effort that rides on it.
 *
 * The owner's rule (2026-10-17) is what these tests exist to keep: the selector is
 * **user-specific configuration in `~/.heddle/`** — an endpoint, and the model types that
 * endpoint offers — while the repository holds the schema and the logic that turns a level
 * into the provider's own wire value. Two claims are pinned here because a browser cannot
 * tell them apart from a rendering bug:
 *
 * - an effort is displayed only when the endpoint **declares** it for the selected model,
 *   and the declared wire value is what the adapter sends;
 * - a page's choice is checked against that catalogue, so a name or a level the endpoint
 *   does not offer is refused rather than recorded and then sent to a provider that will
 *   reject every following turn.
 *
 * The adapter bodies are judged against a local socket rather than a live provider: the
 * transportation is the same `wire()` the real run uses, so the assertion is about the
 * bytes a provider would receive.
 */

/** A two-tier endpoint: two models, one of them reasoning-capable. */
const endpoint: EndpointConfig = {
  name: 'two-tier',
  kind: 'openai-chat',
  baseUrl: 'http://127.0.0.1:1',
  model: 'model-a',
  models: [
    {
      id: 'model-a',
      name: 'Model A',
      reasoning: {
        default: 'high',
        levels: [
          { id: 'low', name: 'Low', value: 'low' },
          { id: 'high', name: 'High', value: 'high' },
          { id: 'max', name: 'Max', value: 'max' },
        ],
      },
    },
    { id: 'model-b', name: 'Model B' },
  ],
}

/** A request with no content to speak of; only the effort fields under test vary. */
function requestFor(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    endpoint: 'two-tier',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  }
}

/**
 * One local server that records the request body and answers with the smallest legal stream.
 *
 * `kind` decides which stream shape the adapter will accept: chat completions ends on `[DONE]`,
 * responses ends on `response.completed`.
 */
async function recordingServer(kind: 'chat' | 'responses'): Promise<{
  readonly baseUrl: string
  readonly bodies: string[]
  close(): Promise<void>
}> {
  const bodies: string[] = []
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.on('data', (chunk) => {
      body += chunk
    })
    incoming.on('end', () => {
      bodies.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (kind === 'chat') {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
      } else {
        response.write(
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: null } })}\n\n`,
        )
      }
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: kind === 'chat' ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Drain an adapter stream so the request it makes is complete. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // the assertion is the recorded body
  }
}

test('an endpoint lists the model types it offers, with the names and effort levels a page may show', () => {
  const described = describeEndpoint(endpoint)
  assert.deepEqual(
    (described.models as { id: string; name: string }[]).map((model) => [model.id, model.name]),
    [
      ['model-a', 'Model A'],
      ['model-b', 'Model B'],
    ],
    'every model the endpoint offers travels with its display name',
  )
  const first = (described.models as { id: string; reasoning?: { default?: string; levels: { id: string; name: string }[] } }[])[0]
  assert.equal(first?.reasoning?.default, 'high', 'the model’s default effort is part of the catalogue')
  assert.deepEqual(
    first?.reasoning?.levels.map((level) => [level.id, level.name]),
    [
      ['low', 'Low'],
      ['high', 'High'],
      ['max', 'Max'],
    ],
    'and so are its levels, by id and display name',
  )
  assert.equal(JSON.stringify(described).includes('"value"'), false, 'the provider’s wire value never reaches a page')
  const second = (described.models as { id: string; reasoning?: unknown }[])[1]
  assert.equal('reasoning' in (second ?? {}), false, 'a model that declares no effort levels says so by omission')
})

test('an endpoint that names one model still offers it, so old configuration keeps working', () => {
  const described = describeEndpoint({ name: 'old', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'only-one' })
  assert.deepEqual(described.models, [{ id: 'only-one', name: 'only-one' }], 'the single model becomes a one-entry list')
  const empty = describeEndpoint({ name: 'none', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:1' })
  assert.deepEqual(empty.models, [], 'an endpoint with no model offers nothing rather than inventing a name')
})

test('an endpoint-level reasoning block is the default for the models that have none of their own', () => {
  const withDefault: EndpointConfig = {
    name: 'defaulted',
    kind: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1',
    model: 'a',
    reasoning: { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }] },
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', reasoning: { levels: [{ id: 'max', name: 'Max', value: 'max' }] } }],
  }
  const described = describeEndpoint(withDefault)
  const models = described.models as { id: string; reasoning?: { default?: string; levels: { id: string }[] } }[]
  assert.equal(models[0]?.reasoning?.default, 'low', 'the endpoint block applies to a model with no block of its own')
  assert.deepEqual(models[1]?.reasoning?.levels.map((level) => level.id), ['max'], 'a model block replaces it rather than merging')
})

test('a page’s model and effort are checked against what the endpoint actually offers', () => {
  assert.equal(selectionProblem(endpoint, 'model-b'), null, 'an offered model is accepted')
  assert.match(selectionProblem(endpoint, 'model-z') ?? '', /model-z/, 'a model the endpoint does not offer is refused by name')
  assert.equal(selectionProblem(endpoint, 'model-a', 'low'), null, 'a declared level is accepted')
  assert.match(selectionProblem(endpoint, 'model-a', 'xhigh') ?? '', /xhigh/, 'an undeclared level is refused by name')
  assert.match(
    selectionProblem(endpoint, 'model-b', 'low') ?? '',
    /no reasoning/i,
    'a model with no effort levels cannot be given one',
  )
  assert.equal(selectionProblem(endpoint, undefined, 'low'), null, 'no model named means the endpoint default, which declares low')
})

test('an openai-chat call carries the selected level as reasoning_effort', async () => {
  const server = await recordingServer('chat')
  try {
    const target: EndpointConfig = { ...endpoint, baseUrl: server.baseUrl }
    await drain(openAiChatAdapter(target, requestFor({ reasoningEffort: 'high' })))
    assert.equal(server.bodies.length, 1, 'one request reached the wire')
    const body = JSON.parse(server.bodies[0] ?? '{}') as { reasoning_effort?: string }
    assert.equal(body.reasoning_effort, 'high', 'the level’s declared wire value is what the provider receives')
    await drain(openAiChatAdapter(target, requestFor()))
    assert.equal(JSON.parse(server.bodies[1] ?? '{}').reasoning_effort, undefined, 'no selection sends no effort parameter')
  } finally {
    await server.close()
  }
})

test('an openai-responses call carries the selected level under reasoning.effort', async () => {
  const server = await recordingServer('responses')
  try {
    const target: EndpointConfig = { ...endpoint, kind: 'openai-responses', baseUrl: server.baseUrl }
    await drain(openAiResponsesAdapter(target, requestFor({ reasoningEffort: 'max' })))
    const body = JSON.parse(server.bodies[0] ?? '{}') as { reasoning?: { effort?: string } }
    assert.equal(body.reasoning?.effort, 'max', 'the Responses shape nests the effort')
    await drain(openAiResponsesAdapter(target, requestFor()))
    assert.equal(JSON.parse(server.bodies[1] ?? '{}').reasoning, undefined, 'no selection sends no reasoning object')
  } finally {
    await server.close()
  }
})

test('an anthropic-vertex call asks for adaptive thinking and the level’s effort, as its gateway requires', () => {
  const target: EndpointConfig = {
    name: 'claude',
    kind: 'anthropic-vertex',
    baseUrl: 'http://gateway.example:443/v1',
    model: 'claude-opus-5-5',
    project: 'a-project',
    region: 'global',
    models: [{ id: 'claude-opus-5-5', reasoning: { levels: [{ id: 'high', name: 'High', value: 'high' }] } }],
  }
  const call = anthropicCall(target, requestFor({ endpoint: 'claude', reasoningEffort: 'high' }))
  assert.deepEqual(call.body.thinking, { type: 'adaptive' }, 'budget_tokens was refused by the live route; adaptive is what it asked for')
  assert.deepEqual(call.body.output_config, { effort: 'high' }, 'and the effort travels there rather than in a thinking budget')
  const plain = anthropicCall(target, requestFor({ endpoint: 'claude' }))
  assert.equal('thinking' in plain.body, false, 'no selection sends no thinking directive')
  assert.equal('output_config' in plain.body, false, 'and no effort')
})

test('a level with a null wire value is displayed but sends nothing, and an unknown level fails loudly', async () => {
  const server = await recordingServer('chat')
  try {
    const target: EndpointConfig = {
      ...endpoint,
      baseUrl: server.baseUrl,
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          reasoning: { levels: [{ id: 'default', name: 'Default', value: null }] },
        },
      ],
    }
    await drain(openAiChatAdapter(target, requestFor({ reasoningEffort: 'default' })))
    assert.equal(JSON.parse(server.bodies[0] ?? '{}').reasoning_effort, undefined, 'a null value means “the provider’s own default”')
    await assert.rejects(
      async () => drain(openAiChatAdapter(target, requestFor({ reasoningEffort: 'ghost' }))),
      /ghost|reasoning effort/i,
      'a level the endpoint does not declare is an error rather than a silently unenforced value',
    )
  } finally {
    await server.close()
  }
})
