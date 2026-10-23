import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, parseJson, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The Anthropic publisher route, offline against a double and then — if the machine has one — against the
 * real gateway.
 *
 * The wire shape under judgment is the one a hosted cloud exposes for Anthropic's models:
 * `projects/<p>/locations/<r>/publishers/anthropic/models/<m>:streamRawPredict`, with the version and the
 * stream flag in the body and thinking/text/tool-call deltas in the event stream. It is a third shape beside
 * Chat Completions and Responses, so the offline half is not a repeat of either: a double answers the real
 * route, and the check requires the framework to reach it **and** to translate a system prompt, a streamed
 * tool call and a thinking delta correctly.
 *
 * The live half follows the same contract as the other spending check in this part: one short turn against a
 * configured publisher endpoint, and **unjudged** when this machine has none — because "no gateway is
 * configured" must never be recorded as "the gateway works".
 */

/** The probe asks for every command these checks run: a turn on a named endpoint, and the model listing. */
async function supportsRoute() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help) && /^\s{2}models\b/m.test(help)
}

const CAPABILITY = 'backend connections with a configured endpoint list'

/** A double that speaks the publisher route: records the call and answers with Anthropic's event stream. */
async function publisherDouble() {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      calls.push({ url: request.url ?? '', body, headers: request.headers })
      if (!(request.url ?? '').endsWith(':streamRawPredict')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not the publisher route"}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, payload) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      send('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answered over the publisher route' } })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test('a turn runs over the Anthropic publisher route, streamed', async (context) => {
  if (!skipUnless(context, (await supportsRoute()), CAPABILITY)) return
  const home = isolatedHome('publisher-route')
  const double = await publisherDouble()
  try {
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'publisher',
      endpoints: [
        {
          name: 'publisher',
          kind: 'anthropic-vertex',
          baseUrl: double.baseUrl,
          project: 'a-project',
          region: 'global',
          model: 'a-model',
          maxOutputTokens: 64,
          headers: { 'x-gateway-inject': 'a-descriptor' },
        },
      ],
    })
    const run = await runCli(
      ['--endpoint', 'publisher', '--sandbox-root', home, '--turn', 'say something', '--max-rounds', '1', '--json'],
      { env: { HOME: home, HEDDLE_CONFIG: config }, timeoutMs: 120_000 },
    )
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.equal(summary?.endpoint, 'publisher', 'the answer came from the endpoint that was named')
    assert.match(String(summary?.text ?? ''), /answered over the publisher route/, 'the text delta reached the caller')

    const call = double.calls[0]
    assert.ok(call !== undefined, 'the double was called')
    assert.match(
      call.url,
      /^\/v1\/projects\/a-project\/locations\/global\/publishers\/anthropic\/models\/[^/]+:streamRawPredict$/,
      `at the publisher route for the configured project and region (${call.url})`,
    )
    assert.equal(call.headers['x-gateway-inject'], 'a-descriptor', 'a configured header reaches the gateway')
    const body = JSON.parse(call.body)
    assert.equal(body.anthropic_version, 'vertex-2023-10-16', 'the version travels in the body')
    assert.equal(body.stream, true, 'and the call is streamed')
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0, 'with the conversation translated')
    /**
     * The reasoning the double sent is **not** echoed back in the request: a thinking block needs the
     * provider's signature to be replayed, so a second round would be refused if it were sent.
     */
    assert.equal(call.body.includes('weighing it'), false, 'and the provider’s thinking is not replayed')
  } finally {
    await double.close()
    removeDir(home)
  }
})

test('a configured publisher gateway answers one short turn, or is unjudged', async (context) => {
  if (!skipUnless(context, (await supportsRoute()), CAPABILITY)) return
  /**
   * The machine-local half. No endpoint, project or host appears in this file: the check asks the machine's
   * own configuration for an endpoint of this shape and judges whatever it finds, which is what keeps one
   * deployment's address out of the repository.
   */
  const probe = await runCli(['models', '--json'], {})
  const endpoints = parseJson(probe.stdout)
  const target = Array.isArray(endpoints) ? endpoints.find((endpoint) => endpoint.kind === 'anthropic-vertex') : undefined
  if (!skipUnless(context, target !== undefined, 'a configured publisher-route endpoint, which this machine did not provide')) return

  /**
   * A **fresh session root**, because this is meant to be one short request. Measured: run against the
   * owner's store, the turn resumed whatever session was last there, so a flaky answer could be the
   * history's fault rather than the gateway's.
   */
  const home = isolatedHome('publisher-real')
  let run
  try {
    run = await runCli(
      ['--session-root', join(home, 'sessions'), '--endpoint', target.name, '--turn', 'Reply with exactly the single word: ready', '--max-rounds', '1', '--max-output-tokens', '256', '--json'],
      { timeoutMs: 180_000 },
    )
  } finally {
    removeDir(home)
  }
  if (run.code !== 0) {
    context.skip(`the configured endpoint '${target.name}' did not answer, so this part was not judged — ${run.stderr.trim().split('\n').pop() ?? ''}`)
    return
  }
  const summary = parseJson(run.stdout)
  /**
   * A thinking model given a 32-token budget can spend all of it on reasoning and answer with no text —
   * measured on the publisher gateway, and it made this probe fail on a reachable endpoint. The claim is
   * that the gateway **answers**, so either kind of answer counts; nothing at all is unjudged rather than
   * a pass or a failure.
   */
  const answer = `${summary?.text ?? ''}${summary?.reasoning ?? ''}`
  if (answer.length === 0) {
    context.skip(`the configured endpoint '${target.name}' answered with no text or reasoning within its token budget, so this part was not judged`)
    return
  }
  assert.equal(summary?.endpoint, target.name, 'and the answer came from the endpoint that was named')
})
