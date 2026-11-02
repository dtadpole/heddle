import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, runCli, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A refused credential and a spent quota say what they are (S31, R-developer-seven-5).
 *
 * Measured on both builds (results-developer-seven.md S31): an endpoint answering 401 ended the turn with
 * `'scripted' answered 401 — {"error":{"message":"Incorrect API key provided", …}}`, and a quota 429 the same way;
 * nothing said what to do. DSH's chat names both (dsh-client-ui-chat `failureMessage`): an `AUTH` failure (401 or 403)
 * is "API key is invalid", with the provider's sentence left out since it can echo part of the key, and a `QUOTA`
 * failure (`dsh-llm`'s `isQuotaExceededError`: "insufficient quota", "exceeded your current quota", …) is "Request
 * quota exhausted." A quota refusal is not a rate limit, so it is never retried.
 */

async function supportsRoute() {
  const help = (await runCli(['--help'])).stdout
  return /--endpoint/.test(help) && /--turn/.test(help)
}

const CAPABILITY = 'backend connections with a configured endpoint list'

const KEY_ECHO = 'Incorrect API key provided: sk-abc****wxyz. You can find your API key at https://example.invalid/api-keys.'
const QUOTA_SENTENCE = 'You exceeded your current quota, please check your plan and billing details.'

/** A chat double that refuses every turn call with the given status and body, and counts them. */
async function refusingDouble(status, body) {
  const state = { turnCalls: 0 }
  const server = createServer((request, response) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => {
      if (isTitleRequest(text)) return refuseTitleRequest(response)
      state.turnCalls += 1
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
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

/** A home with one chat endpoint on the double; `turn` runs one CLI turn there. */
function setup(label, double) {
  const home = isolatedHome(label)
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'chat',
    endpoints: [{ name: 'chat', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'a-chat-model', apiKey: 'a-test-key', stream: true }],
  })
  const sessions = join(home, 'sessions')
  const turn = (prompt) =>
    runCli(['--endpoint', 'chat', '--sandbox-root', home, '--session-root', sessions, '--turn', prompt, '--max-rounds', '1'], {
      env: { HOME: home, HEDDLE_CONFIG: config },
      timeoutMs: 60_000,
    })
  return { home, sessions, turn }
}

/** Everything the session's log says about the failure, as one string. */
function recorded(fixture) {
  const session = sessionsUnder(fixture.sessions)[0]
  assert.ok(session, 'a session was recorded')
  return JSON.stringify(readTranscript(join(fixture.sessions, session)))
}

test('a refused credential fails the turn saying the API key is invalid, with none of the provider’s words', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  const double = await refusingDouble(401, { error: { message: KEY_ECHO, type: 'invalid_request_error', code: 'invalid_api_key' } })
  const fixture = setup('auth-refused', double)
  try {
    const failed = await fixture.turn('hello')
    assert.notEqual(failed.code, 0, `the turn failed\n${failed.stdout}${failed.stderr}`)
    const said = `${failed.stdout}${failed.stderr}`
    assert.match(said, /'chat' answered 401 — API key is invalid; check the key this endpoint reads\./, `the failure names the cause and where to look\n${said}`)
    assert.equal(said.includes('sk-abc'), false, `no part of the key is repeated\n${said}`)
    assert.equal(said.includes('Incorrect API key provided'), false, `nor the provider's sentence that carried it\n${said}`)
    const log = recorded(fixture)
    assert.match(log, /API key is invalid/, 'the session records the same sentence, so a reload keeps the reason')
    assert.equal(log.includes('sk-abc'), false, 'and the log holds no part of the key')
  } finally {
    await double.close()
    removeDir(fixture.home)
  }
})

test('a quota refusal says so, in the provider’s words and DSH’s, and is sent once', async (context) => {
  if (!skipUnless(context, await supportsRoute(), CAPABILITY)) return
  const double = await refusingDouble(429, { error: { message: QUOTA_SENTENCE, type: 'insufficient_quota', code: 'insufficient_quota' } })
  const fixture = setup('quota-refused', double)
  try {
    const failed = await fixture.turn('hello')
    assert.notEqual(failed.code, 0, `the turn failed\n${failed.stdout}${failed.stderr}`)
    const said = `${failed.stdout}${failed.stderr}`
    assert.ok(said.includes(`'chat' answered 429 — ${QUOTA_SENTENCE} Request quota exhausted.`), `the provider's sentence, then DSH's\n${said}`)
    assert.equal(said.includes('"insufficient_quota"'), false, `not the provider's JSON\n${said}`)
    assert.equal(double.state.turnCalls, 1, 'a spent quota is not a rate limit: the call is not repeated')
    assert.match(recorded(fixture), /Request quota exhausted\./, 'the session records the same sentence')
  } finally {
    await double.close()
    removeDir(fixture.home)
  }
})
