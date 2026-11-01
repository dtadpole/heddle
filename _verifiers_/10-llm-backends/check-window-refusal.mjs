import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * An Anthropic window refusal is a window refusal (#153).
 *
 * Live, on both builds: a session moved to a Claude model larger than its window was refused with Anthropic's
 * `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 352406 tokens > 200000
 * maximum"}}`. The matcher knew only the OpenAI and DeepSeek wordings, so the log said `compaction/recovery {code:
 * "HTTP", retry: false, reason: "not a window overflow"}`, overflow recovery never ran, and the page showed the raw
 * JSON. On every `anthropic-messages` endpoint — the live default is one — a refusal the harness can recover from
 * therefore failed the turn.
 *
 * What is judged, against a double that speaks the Messages route:
 *
 * - a refusal in Anthropic's words is answered as DSH answers it: one forced fold, then the retry, recorded as a
 *   `turn/retry` with `CONTEXT_WINDOW_EXCEEDED`;
 * - a refusal the fold cannot fix fails the turn with the provider's sentence and the way out, not its JSON.
 */

/** The probe asks for every command these checks run: a turn on a named endpoint, and a turn that resumes a session. */
async function supportsRoute() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help) && /--resume/.test(help)
}

const CAPABILITY = 'backend connections with a configured endpoint list'

const SENTENCE = 'prompt is too long: 352406 tokens > 200000 maximum'
const REFUSAL = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: SENTENCE } })

/** The summariser's directive, in either of the wordings the builds have used (DSH's since #77, the older one before). */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/**
 * A Messages double that refuses the next `refuse` turn calls in Anthropic's words, and answers everything else.
 *
 * The answer follows what was asked for — an event stream for a streamed call, one message for a buffered one — so a
 * summary call is answered whichever way a build makes it.
 */
async function refusingDouble() {
  const state = { refuse: 0, turnCalls: 0, refused: 0, summaries: 0 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      const summary = isSummaryRequest(body)
      if (summary) state.summaries += 1
      else {
        state.turnCalls += 1
        if (state.refuse > 0) {
          state.refuse -= 1
          state.refused += 1
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(REFUSAL)
          return
        }
      }
      const text = summary ? 'a compact briefing of the conversation so far' : 'answered'
      let streamed = true
      try {
        streamed = JSON.parse(body).stream === true
      } catch {
        // An unreadable body is answered as a stream; the turn's own check reports what went wrong.
      }
      if (!streamed) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'msg-double',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 5 },
          }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, payload) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      }
      send('message_start', { message: { usage: { input_tokens: 5 } } })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      send('message_stop', {})
      response.end()
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
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** A home with one Messages endpoint on the double, and the CLI arguments every turn here shares. */
function setup(label, double) {
  const home = isolatedHome(label)
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'claude',
    endpoints: [
      {
        name: 'claude',
        kind: 'anthropic-messages',
        baseUrl: double.baseUrl,
        model: 'a-claude-model',
        apiKey: 'a-test-key',
        maxOutputTokens: 64,
        contextWindow: 200_000,
      },
    ],
  })
  const sessions = join(home, 'sessions')
  const turn = (prompt, resume) =>
    runCli(
      ['--endpoint', 'claude', '--sandbox-root', home, '--session-root', sessions, ...(resume ? ['--resume', resume] : []), '--turn', prompt, '--max-rounds', '1'],
      { env: { HOME: home, HEDDLE_CONFIG: config }, timeoutMs: 120_000 },
    )
  return { home, sessions, turn }
}

/**
 * A first turn with something to fold.
 *
 * A checkpoint has to be smaller than the span it replaces, and a one-line exchange is not: the frame around a summary
 * costs more than the messages do. Without a substantial first turn the fold would have nothing to take, and the check
 * would be judging the shrink rule rather than the recovery.
 */
async function conversation(fixture) {
  const first = await fixture.turn(`Keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(60)}`)
  assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
  const session = sessionsUnder(fixture.sessions)[0]
  assert.ok(session, 'a session was recorded')
  return session
}

test("an Anthropic 'prompt is too long' refusal is recovered: one fold, then the retry is answered", async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  const double = await refusingDouble()
  const fixture = setup('window-refusal-recovered', double)
  try {
    const session = await conversation(fixture)
    double.state.refuse = 1
    const second = await fixture.turn('and now the next question', session)
    assert.equal(double.state.refused, 1, 'the double refused the turn once, in Anthropic’s words')
    assert.equal(second.code, 0, `the refused turn recovered\n${second.stdout}${second.stderr}`)
    const events = readTranscript(join(fixture.sessions, session))
    const decision = events.filter((event) => event.type === 'compaction/recovery').at(-1)
    assert.ok(decision, 'the recovery decision was recorded')
    assert.equal(decision.code, 'CONTEXT_WINDOW_EXCEEDED', `the refusal was read as a window overflow (${JSON.stringify(decision)})`)
    assert.equal(decision.retry, true, `and a fold landed, so a retry was granted (${JSON.stringify(decision)})`)
    const retry = events.find((event) => event.type === 'turn/retry')
    assert.ok(retry, 'the retry was recorded')
    assert.equal(retry.code, 'CONTEXT_WINDOW_EXCEEDED', 'and it says what it was recovering from')
    assert.ok(double.state.summaries >= 1, 'the fold asked the model for a summary')
    assert.ok(/answered/.test(second.stdout), `the retry's answer reached the caller\n${second.stdout}`)
  } finally {
    await double.close()
    removeDir(fixture.home)
  }
})

test("a refusal the fold cannot fix fails the turn with the provider's sentence and the way out, not its JSON", async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  const double = await refusingDouble()
  const fixture = setup('window-refusal-failed', double)
  try {
    const session = await conversation(fixture)
    double.state.refuse = 10
    const failed = await fixture.turn('and now the next question', session)
    assert.notEqual(failed.code, 0, `a refusal recovery cannot fix fails the turn rather than looping\n${failed.stdout}${failed.stderr}`)
    assert.ok(double.state.refused <= 3, `the turn did not loop on the refusal (${double.state.refused} refused calls)`)
    const said = `${failed.stdout}${failed.stderr}`
    assert.ok(said.includes(SENTENCE), `the provider's sentence is said\n${said}`)
    assert.match(said, /larger window/, `and the way out is named\n${said}`)
    assert.equal(said.includes('"invalid_request_error"'), false, `and not the provider's JSON\n${said}`)

    const events = readTranscript(join(fixture.sessions, session))
    const decision = events.filter((event) => event.type === 'compaction/recovery')[0]
    assert.ok(decision, 'a recovery decision was recorded')
    assert.equal(decision.code, 'CONTEXT_WINDOW_EXCEEDED', `the refusal was read as a window overflow (${JSON.stringify(decision)})`)
    const recorded = events
      .filter((event) => typeof event.error === 'string' || (event.type === 'turn/failed' && typeof event.message === 'string'))
      .map((event) => event.error ?? event.message)
    assert.ok(recorded.length > 0, `the failure is in the record\n${JSON.stringify(events.slice(-5))}`)
    for (const message of recorded) {
      assert.ok(message.includes(SENTENCE) && !message.includes('"invalid_request_error"'), `the recorded failure is readable: ${message}`)
    }
  } finally {
    await double.close()
    removeDir(fixture.home)
  }
})
