import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A provider stream that did not finish fails the turn in words; it is never a finished answer (#173).
 *
 * Measured by developer-four on both builds with doubles (J99, then on main 9cbeb6cd):
 *
 * - a chat stream cut after three deltas, with no `finish_reason` and no `[DONE]`, ended `done: stop`, `assistant/completed
 *   "PARTIAL-99 alpha beta "` and a plain `turn/completed`, and the fragment went back to the model as a complete answer;
 * - cut inside a tool call, the chat route dropped the half-written call without a word, and the Messages route (no
 *   `message_stop`) emitted it and ran it;
 * - a chat `data: {"error": …}` frame mid-stream was skipped, so the provider's sentence appeared nowhere;
 * - an empty answer (a role-only delta, `finish_reason: stop`, `completion_tokens: 0`) drew no row and no notice;
 * - on the TS build, a stream that stalled past the socket-idle limit ended as a finished answer, where the Rust build
 *   fails the turn with "the request to '…' timed out after …ms".
 *
 * DSH fails each (`STREAM_CLOSED`, the provider's words, `EMPTY_RESPONSE`, a timeout). The double answers
 * close-delimited, as an event stream through a proxy often is: that is the body form in which a cut reads as a normal
 * end of body.
 */

async function supportsRoute() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help)
}

const CAPABILITY = 'backend connections with a configured endpoint list'

const data = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const delta = (fields) => data({ choices: [{ delta: fields, finish_reason: null }] })
const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

/** What the chat route streams for each marker; `hold` keeps the socket open after the frames. */
const CHAT = {
  'CUT-TEXT-173': { frames: [delta({ role: 'assistant', content: 'PARTIAL-99 ' }), delta({ content: 'alpha ' }), delta({ content: 'beta ' })] },
  'CUT-TOOL-173': {
    frames: [
      delta({ role: 'assistant', content: 'Running it now. ' }),
      delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command": "echo DRO' } }] }),
    ],
  },
  'ERROR-OBJECT-173': {
    frames: [
      delta({ role: 'assistant', content: 'Partial answer before the error' }),
      data({ error: { message: 'Internal server error (fake mid-stream)', type: 'server_error', code: 'internal_error' } }),
    ],
  },
  'EMPTY-173': {
    frames: [
      delta({ role: 'assistant', content: '' }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 0 } }),
      data('[DONE]'),
    ],
  },
  'STALL-173': { frames: [delta({ role: 'assistant', content: 'Partial answer before the stall' })], hold: true },
}

/** What the Messages route streams for each marker: never a stop reason, never `message_stop`. */
const MESSAGES = {
  'CUT-TEXT-173': {
    frames: [
      event('message_start', { message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 12, output_tokens: 0 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PARTIAL-99 ' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'alpha ' } }),
    ],
  },
  'CUT-TOOL-173': {
    frames: [
      event('message_start', { message: { id: 'msg_2', role: 'assistant', usage: { input_tokens: 12, output_tokens: 0 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Running it now. ' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} } }),
      event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "echo DRO' } }),
    ],
  },
}

/** One double for both routes: the marker in the request picks the script, the path picks the route. */
async function cuttingDouble() {
  const state = { calls: {} }
  const held = new Set()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      const path = new URL(request.url ?? '/', 'http://x').pathname
      const route = path.endsWith('/messages') ? MESSAGES : path.endsWith('/chat/completions') ? CHAT : undefined
      const marker = route === undefined ? undefined : Object.keys(route).find((key) => body.includes(key))
      if (route === undefined || marker === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `no script for ${path}` } }))
        return
      }
      state.calls[marker] = (state.calls[marker] ?? 0) + 1
      const script = route[marker]
      response.useChunkedEncodingByDefault = false
      response.shouldKeepAlive = false
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      for (const frame of script.frames) response.write(frame)
      if (script.hold === true) held.add(response)
      else response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const response of held) response.destroy()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** A home with a chat endpoint, a chat endpoint with a short idle limit, and a Messages endpoint, all on the double. */
function setup(label, double) {
  const home = isolatedHome(label)
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'chat',
    endpoints: [
      { name: 'chat', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'a-chat-model', apiKey: 'a-test-key', stream: true },
      { name: 'chat-idle', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'a-chat-model', apiKey: 'a-test-key', stream: true, timeoutMs: 1500 },
      { name: 'claude', kind: 'anthropic-messages', baseUrl: double.baseUrl, model: 'a-claude-model', apiKey: 'a-test-key', maxOutputTokens: 64 },
    ],
  })
  const sessions = join(home, 'sessions')
  const turn = (endpoint, prompt) =>
    runCli(['--endpoint', endpoint, '--sandbox-root', home, '--session-root', sessions, '--turn', prompt, '--max-rounds', '2'], {
      env: { HOME: home, HEDDLE_CONFIG: config },
      timeoutMs: 90_000,
    })
  return { home, sessions, turn }
}

/** The session's log, parsed. */
function logOf(fixture) {
  const session = sessionsUnder(fixture.sessions)[0]
  assert.ok(session, 'a session was recorded')
  return readTranscript(join(fixture.sessions, session))
}

/**
 * What every case asserts: the turn failed, it said `reason`, and the log ends the answer as a failure naming it
 * (`assistant/completed` with `finishReason: "error"` and `failed: <reason>`), never as a finished `stop`.
 */
function assertFailedWith(fixture, run, reason) {
  const said = `${run.stdout}${run.stderr}`
  assert.notEqual(run.code, 0, `the turn failed\n${said}`)
  assert.ok(said.includes(reason), `the failure says ${JSON.stringify(reason)}\n${said}`)
  const log = logOf(fixture)
  const completed = log.filter((entry) => entry.type === 'assistant/completed')
  assert.ok(completed.length > 0, 'the answer was closed')
  const last = completed.at(-1)
  assert.equal(last.finishReason, 'error', `the answer ends as a failure, not a ${last.finishReason}\n${JSON.stringify(last)}`)
  assert.ok((last.ended ?? []).some((line) => line.includes(reason)), `its notice names the reason\n${JSON.stringify(last)}`)
  assert.equal(
    log.some((entry) => entry.type === 'assistant/chunk' && entry.chunk?.type === 'done'),
    false,
    'no done chunk: nothing said the provider finished',
  )
  return log
}

/** Whether the log holds an assembled tool call or a tool result: a half-written call was emitted or run. */
function ranATool(log) {
  return log.some((entry) => (entry.type === 'assistant/chunk' && entry.chunk?.type === 'tool-call') || JSON.stringify(entry).includes('"role":"tool"'))
}

async function withFixture(label, body) {
  const double = await cuttingDouble()
  const fixture = setup(label, double)
  try {
    await body(fixture, double)
  } finally {
    await double.close()
    removeDir(fixture.home)
  }
}

test('a chat stream cut with no finish_reason and no [DONE] fails the turn, not a stop with the fragment as the answer', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-cut-text', async (fixture) => {
    const run = await fixture.turn('chat', 'CUT-TEXT-173 turn')
    assertFailedWith(fixture, run, "'chat' ended its stream before the answer finished (no finish_reason or [DONE])")
  })
})

test('a chat stream cut inside a tool call fails the turn and runs nothing', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-cut-tool', async (fixture) => {
    const run = await fixture.turn('chat', 'CUT-TOOL-173 turn')
    const log = assertFailedWith(fixture, run, "'chat' ended its stream before the answer finished")
    assert.equal(ranATool(log), false, 'the half-written call was neither emitted nor run')
  })
})

test("an error object inside a chat stream fails the turn in the provider's words", async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-error-object', async (fixture) => {
    const run = await fixture.turn('chat', 'ERROR-OBJECT-173 turn')
    assertFailedWith(fixture, run, "'chat' reported server_error — Internal server error (fake mid-stream)")
  })
})

test('an empty answer fails the turn as an empty response, rather than leaving the prompt unanswered with no notice', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-empty', async (fixture, double) => {
    const run = await fixture.turn('chat', 'EMPTY-173 turn')
    // EMPTY_RESPONSE is retryable under DSH's default policy, so a build that retries asks more than once first.
    assert.ok((double.state.calls['EMPTY-173'] ?? 0) >= 1, 'the endpoint was asked')
    const said = `${run.stdout}${run.stderr}`
    assert.notEqual(run.code, 0, `the turn failed\n${said}`)
    assert.ok(said.includes("'chat' returned a completed response with no content"), `the failure says the answer was empty\n${said}`)
    const last = logOf(fixture).filter((entry) => entry.type === 'assistant/completed').at(-1)
    assert.equal(last?.finishReason, 'error', `the answer ends as a failure\n${JSON.stringify(last)}`)
  })
})

test('a stream that stalls past the endpoint’s idle limit fails the turn as a timeout, on both builds', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-stall', async (fixture) => {
    const started = Date.now()
    const run = await fixture.turn('chat-idle', 'STALL-173 turn')
    assertFailedWith(fixture, run, "the request to 'chat-idle' timed out after 1500ms")
    assert.ok(Date.now() - started < 60_000, 'it ended at the limit, not when the double gave up')
  })
})

test('a Messages stream cut before its stop reason fails the turn', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-cut-messages-text', async (fixture) => {
    const run = await fixture.turn('claude', 'CUT-TEXT-173 turn')
    assertFailedWith(fixture, run, "'claude' ended its stream before the answer finished (no message_stop)")
  })
})

test('a Messages stream cut inside a tool_use block fails the turn and never runs the half-written call', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  await withFixture('stream-cut-messages-tool', async (fixture) => {
    const run = await fixture.turn('claude', 'CUT-TOOL-173 turn')
    const log = assertFailedWith(fixture, run, "'claude' ended its stream before the answer finished (no message_stop)")
    assert.equal(ranATool(log), false, 'the half-written call was neither emitted nor run')
  })
})
