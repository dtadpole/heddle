import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A summary the provider cut at its output limit is no checkpoint (#207).
 *
 * Measured by developer-four on both builds (J149, main 9cbeb6cd), with a chat double that ended the summary
 * `Summary: the user asked me to remember the code HERON-149 and the number` with `finish_reason: "length"`:
 * - both builds logged `compaction/summary` with the cut text and `compaction/end`;
 * - `/compact` answered "Compacted 33 history items (~6039 tokens).";
 * - the next request held the code but not the number, so 731 was gone from the session.
 * The automatic compaction inside a turn landed the cut summary the same way.
 *
 * DSH's `dsh-compaction-basic` `finishError` refuses a `max-tokens` finish: "summarization truncated at the token cap
 * (incomplete checkpoint)", code `MAX_TOKENS`. No checkpoint lands, `/compact` reports the failure, and an automatic
 * compaction fails without replacing anything.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

const REFUSAL = 'summarization truncated at the token cap (incomplete checkpoint)'

/** What `/compact` answers when the engine refused its summary: DSH's sentence, both builds (COMPACT_REFUSED). */
const COMPACT_REFUSED = 'Compaction could not produce a useful summary. The attempt is recorded in the session log.'

function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/**
 * The window and the two prompts, as in check-compaction-stop: the second turn's request crosses the trigger with the
 * first turn's long prompt to fold. The first prompt carries the two facts the cut summary would lose.
 */
const WINDOW = 40_000
const FIRST = `Remember HERON-207 and the number 731. ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`
const SECOND = `And now the question: ${'a lazy dog sleeps under the quick brown fox, '.repeat(500)}`

/** A chat double that answers turns at once and ends every summary mid-sentence at its output limit. */
async function cuttingDouble() {
  const state = { summaries: 0, turnBodies: [] }
  const send = (response, text, finish) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      if (isSummaryRequest(body)) {
        state.summaries += 1
        return send(response, 'Summary: the user asked me to remember the code HERON-207 and the number', 'length')
      }
      state.turnBodies.push(body)
      send(response, 'answered', 'stop')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

/** Start the Web UI and resolve once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1] })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      }
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`the server printed no URL within 15s\n${output}`))
      }
    }, 15_000).unref()
  })
}

function killServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve()
    server.child.once('exit', () => resolve())
    server.child.kill('SIGKILL')
  })
}

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** Post a turn and read its streamed body to the end; the session it named and the whole text. */
async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, `the turn was accepted (${String(body.prompt).slice(0, 40)})`)
  const text = await response.text()
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { session: named ? JSON.parse(named[1]).session : undefined, text }
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

async function withServer(label, body) {
  const double = await cuttingDouble()
  const home = fixtureDir(label)
  writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
  })
  let server
  try {
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
      HEDDLE_HOME: home,
      HEDDLE_CONFIG: join(home, 'heddle.json'),
    })
    await body(server, double, (session) => readTranscript(join(home, 'sessions', session)))
  } finally {
    if (server !== undefined) await killServer(server)
    await double.close()
    removeDir(home)
  }
}

/** The first turn, answered in full. */
async function firstTurn(server) {
  const first = await turn(server, { prompt: FIRST })
  assert.ok(typeof first.session === 'string', 'the first turn named its session')
  assert.match(first.text, /event: done/, `the first turn finished\n${first.text.slice(-400)}`)
  return first.session
}

/** What every case asserts of the log: the cut summary was refused with DSH's reason, and nothing landed. */
function assertRefused(events) {
  const types = events.map((event) => event.type)
  assert.ok(types.includes('compaction/start'), `a compaction ran\n${types.join(' ')}`)
  assert.ok(!types.includes('compaction/summary'), `the cut summary was not recorded as a checkpoint\n${types.join(' ')}`)
  assert.ok(!types.includes('compaction/end'), `and no compaction landed\n${types.join(' ')}`)
  assert.ok(!events.some((event) => event.type === 'context/note' && event.origin === 'compaction'), 'no replacement note was written')
  const failed = events.filter((event) => event.type === 'compaction/failed')
  assert.ok(failed.length > 0, `the compaction is closed as failed\n${types.join(' ')}`)
  assert.ok(failed.every((event) => String(event.reason).includes(REFUSAL)), `saying why (${JSON.stringify(failed)})`)
}

test('a /compact whose summary ended at the output limit fails, says why, and leaves the history as it was', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  await withServer('summary-cut-command', async (server, double, log) => {
    const session = await firstTurn(server)
    const answered = await request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
    const body = await answered.json()
    assert.equal(double.state.summaries, 1, 'the summary was asked for once')
    assert.equal(body.kind, 'error', `the /compact is an error, not "Compacted …" (${JSON.stringify(body)})`)
    // DSH's sentence for a refused summary (dsh-command-compact); the reason itself is in the log, as asserted below.
    assert.equal(body.text, COMPACT_REFUSED, `in DSH's words (${JSON.stringify(body)})`)
    assertRefused(log(session))

    const next = await turn(server, { session, prompt: 'what was the number?' })
    assert.match(next.text, /answered/, 'the next turn is answered')
    const sent = double.state.turnBodies.at(-1) ?? ''
    assert.ok(sent.includes('HERON-207') && sent.includes('the number 731'), 'and its request still holds the facts the cut summary would have lost')
  })
})

test('a turn whose automatic summary ended at the output limit lands no checkpoint and is still answered on the full history', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  await withServer('summary-cut-turn', async (server, double, log) => {
    const session = await firstTurn(server)
    const before = double.state.summaries
    const second = await turn(server, { session, prompt: SECOND })
    assert.ok(double.state.summaries > before, `the second turn crossed the trigger and asked for a summary\n${second.text.slice(-300)}`)
    assert.match(second.text, /answered/, `the turn is answered all the same\n${second.text.slice(-400)}`)
    assertRefused(log(session))
    const sent = double.state.turnBodies.at(-1) ?? ''
    assert.ok(sent.includes('the number 731'), 'and its request was not built on the cut summary: the number is still in it')
  })
})
