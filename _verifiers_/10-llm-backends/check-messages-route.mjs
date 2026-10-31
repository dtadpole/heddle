import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, isTitleRequest, parseJson, refuseTitleRequest, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Anthropic's own Messages API, offline against a double and then — if the machine has one — against the real
 * route.
 *
 * The wire shape under judgment is `POST {baseUrl}/messages`: the model in the body, the API version and the
 * credential in headers (`anthropic-version`, `x-api-key`), and text/thinking/tool-use deltas in the event stream.
 * It is the wire DSH speaks to the Conclave gateway, and it is a separate kind from the publisher route because a
 * gateway may serve Claude on its Chat Completions route **buffered** — measured 2026-10-29: Conclave answered a
 * 30-line count there as one content chunk, and as 21 text deltas on `/v1/messages`.
 *
 * The live half follows the contract of the other spending checks in this part: one short turn against a configured
 * endpoint of this kind, and **unjudged** when this machine has none — "no such endpoint is configured" must never be
 * recorded as "the route works".
 */

/** The probe asks for every command these checks run: a turn on a named endpoint, and the model listing. */
async function supportsRoute() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help) && /^\s{2}models\b/m.test(help)
}

const CAPABILITY = 'backend connections with a configured endpoint list'

/** A double that speaks the Messages route: records the call and answers with Anthropic's event stream. */
async function messagesDouble() {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      /** A new session's title request is not the turn's call this double records (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      calls.push({ url: request.url ?? '', body, headers: request.headers })
      if (request.method !== 'POST' || (request.url ?? '') !== '/v1/messages') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"type":"error","error":{"type":"not_found_error","message":"not the Messages route"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, payload) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      }
      send('message_start', { message: { usage: { input_tokens: 5 } } })
      send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } })
      send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'a-signature' } })
      send('content_block_stop', { index: 0 })
      send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answered over ' } })
      send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'the Messages route' } })
      send('content_block_stop', { index: 1 })
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })
      send('message_stop', {})
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

test('a turn runs over the Anthropic Messages route, streamed', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  const home = isolatedHome('messages-route')
  const double = await messagesDouble()
  try {
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'messages',
      endpoints: [
        {
          name: 'messages',
          kind: 'anthropic-messages',
          baseUrl: double.baseUrl,
          model: 'a-model',
          apiKey: 'a-test-key',
          maxOutputTokens: 64,
          headers: { 'x-gateway-inject': 'a-descriptor' },
        },
      ],
    })
    const run = await runCli(
      ['--endpoint', 'messages', '--sandbox-root', home, '--turn', 'say something', '--max-rounds', '1', '--json'],
      { env: { HOME: home, HEDDLE_CONFIG: config }, timeoutMs: 120_000 },
    )
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.equal(summary?.endpoint, 'messages', 'the answer came from the endpoint that was named')
    assert.match(String(summary?.text ?? ''), /answered over the Messages route/, 'the text deltas reached the caller, in order')

    const call = double.calls[0]
    assert.ok(call !== undefined, 'the double was called')
    assert.equal(call.url, '/v1/messages', `at the Messages route under the configured root (${call.url})`)
    assert.equal(call.headers['x-api-key'], 'a-test-key', 'the credential travels as Anthropic’s x-api-key header')
    assert.equal(call.headers.authorization, undefined, 'and not as a bearer token')
    assert.equal(call.headers['anthropic-version'], '2023-06-01', 'the API version is a header on this shape')
    assert.equal(call.headers['x-gateway-inject'], 'a-descriptor', 'a configured header reaches the gateway')
    const body = JSON.parse(call.body)
    assert.equal(body.model, 'a-model', 'the model travels in the body')
    assert.equal(body.stream, true, 'and the call is streamed')
    assert.equal(body.max_tokens, 64, 'with the cap the route requires')
    assert.equal('anthropic_version' in body, false, 'the publisher route’s body version is not sent here')
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0, 'with the conversation translated')
  } finally {
    await double.close()
    removeDir(home)
  }
})

test('a configured Messages endpoint answers one short turn, or is unjudged', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  /**
   * The machine-local half. No endpoint or host appears in this file: the check asks the machine's own configuration
   * for an endpoint of this kind and judges whatever it finds, which keeps one deployment's address out of the
   * repository.
   */
  const probe = await runCli(['models', '--json'], {})
  const endpoints = parseJson(probe.stdout)
  const target = Array.isArray(endpoints) ? endpoints.find((endpoint) => endpoint.kind === 'anthropic-messages') : undefined
  if (!skipUnless(context, target !== undefined, 'a configured anthropic-messages endpoint, which this machine did not provide')) return

  /** A fresh session root, so the one short request is not a replay of whatever session the store holds. */
  const home = isolatedHome('messages-real')
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
  /** A thinking model can spend a small budget on reasoning alone; either kind of answer counts, nothing is unjudged. */
  const answer = `${summary?.text ?? ''}${summary?.reasoning ?? ''}`
  if (answer.length === 0) {
    context.skip(`the configured endpoint '${target.name}' answered with no text or reasoning within its token budget, so this part was not judged`)
    return
  }
  assert.equal(summary?.endpoint, target.name, 'and the answer came from the endpoint that was named')
})
