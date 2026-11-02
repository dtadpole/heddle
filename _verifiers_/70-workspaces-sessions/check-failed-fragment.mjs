import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A turn whose stream broke mid-answer leaves its fragment out of what the model reads next, of a fork, and of a summary
 * (#173).
 *
 * Measured before, on both builds: a turn whose provider stream was cut after "PARTIAL-99 alpha " failed, as it should,
 * and the next turn's request carried "PARTIAL-99 alpha " as the model's own earlier answer, cut mid-word. A fork and a
 * `/compact` read the same derivation and carried it on.
 *
 * DSH settles a failed stream as `assistant/attempt`, which takes no place on the surface, and only a stream a Stop cut
 * with content as an `assistant/message` marked `interrupted` (dsh-agent-loop). The person still sees the partial: the
 * page draws it with the turn's failure line, as DSH's live stream showed it.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** The summariser's directive, in either of the wordings the builds have used. */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/** check-compaction-stop's window and first prompt: long enough that `/compact` has a span, short of the trigger. */
const WINDOW = 40_000
const FIRST = `CUT-TEXT-173 keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`
const FRAGMENT = 'PARTIAL-99'

/**
 * A chat double. The first prompt's stream sends two text deltas and then the connection is cut inside the chunked body,
 * which both builds read as a broken stream; everything else is answered in full. Every request body is kept.
 */
async function cuttingDouble() {
  const state = { turns: [], summaries: [] }
  const delta = (response, content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
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
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isSummaryRequest(body)) {
        state.summaries.push(body)
        delta(response, 'a compact briefing of the conversation so far')
      } else {
        state.turns.push(body)
        if (state.turns.length === 1) {
          delta(response, `${FRAGMENT} `)
          delta(response, 'alpha ')
          setTimeout(() => response.socket?.destroy(), 100)
          return
        }
        delta(response, 'answered')
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
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
        resolvePromise({ child, url: match[1], output: () => output })
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

/** Post a turn and read it to its end; the session it ran in, and the streamed body. */
async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted (${String(body.prompt).slice(0, 40)})\n${text.slice(0, 400)}`)
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { session: named ? JSON.parse(named[1]).session : undefined, text }
}

/** The conversation a request body carried, without the system prompt: role and text, in order. */
function conversation(body) {
  return (JSON.parse(body).messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(0, 40) : JSON.stringify(message.content).slice(0, 80)}`)
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a turn whose stream broke mid-answer leaves its fragment out of the next request, a fork and a summary, and the page still shows it (#173)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await cuttingDouble()
  const home = fixtureDir('failed-fragment')
  writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
  })
  const sessions = join(home, 'sessions')
  let server
  try {
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })

    /** The cut turn fails, and its log keeps what streamed, closed as an error. */
    const cut = await turn(server, { prompt: FIRST })
    const session = cut.session
    assert.ok(typeof session === 'string', `the cut turn named its session\n${cut.text.slice(-300)}`)
    assert.match(cut.text, /event: error/, `the cut turn failed, as a broken stream must\n${cut.text.slice(-400)}`)
    const events = readTranscript(join(sessions, session))
    assert.ok(events.some((event) => event.type === 'assistant/chunk' && String(event.chunk?.text ?? '').includes(FRAGMENT)), 'the log keeps the streamed chunks')
    const closed = events.find((event) => event.type === 'assistant/completed')
    assert.equal(closed?.finishReason, 'error', `the turn is closed as failed (${JSON.stringify(closed)?.slice(0, 300)})`)

    /** The person still sees the partial, with the failure line. */
    const view = await (await request(server, `/api/sessions/${encodeURIComponent(session)}`)).json()
    const drawn = (view.turns ?? []).find((one) => one.kind === 'assistant' && String(one.text ?? '').includes(FRAGMENT))
    assert.ok(drawn, `the page draws the partial answer\n${JSON.stringify(view.turns).slice(0, 600)}`)
    assert.ok(Array.isArray(drawn.ended) && drawn.ended.length > 0, `with the turn's failure line (${JSON.stringify(drawn)})`)

    /** The next turn's request carries the prompt and not the fragment. */
    const next = await turn(server, { session, prompt: 'NEXT turn' })
    assert.match(next.text, /answered/, `the next turn is answered\n${next.text.slice(-300)}`)
    const nextBody = double.state.turns.at(-1)
    assert.ok(nextBody.includes('CUT-TEXT-173'), `the next request still carries the cut turn's prompt\n${conversation(nextBody).join('\n')}`)
    assert.ok(!nextBody.includes(FRAGMENT), `and not its fragment, as the model's answer\n${conversation(nextBody).join('\n')}`)

    /** A fork's first request reads what the source reads. */
    const forked = await request(server, `/api/sessions/${encodeURIComponent(session)}/fork`, { method: 'POST', body: '{}' })
    assert.equal(forked.status, 200, `the session forks\n${await forked.clone().text()}`)
    const child = (await forked.json()).session
    const branch = await turn(server, { session: child, prompt: 'FORK turn' })
    assert.match(branch.text, /answered/, `the fork's turn is answered\n${branch.text.slice(-300)}`)
    const forkBody = double.state.turns.at(-1)
    assert.ok(forkBody.includes('CUT-TEXT-173') && forkBody.includes('FORK turn'), `the fork's request is the branch's conversation\n${conversation(forkBody).join('\n')}`)
    assert.ok(!forkBody.includes(FRAGMENT), `without the fragment\n${conversation(forkBody).join('\n')}`)

    /** A summary of the span is not handed the fragment either. */
    const compacted = await request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
    const said = await compacted.json()
    assert.equal(said.kind, 'success', `/compact compacts the session (${JSON.stringify(said)})`)
    assert.equal(double.state.summaries.length, 1, 'with one summary call')
    const summaryBody = double.state.summaries[0]
    assert.ok(summaryBody.includes('CUT-TEXT-173'), 'the summary reads the cut turn\'s prompt')
    assert.ok(!summaryBody.includes(FRAGMENT), `and not its fragment\n${conversation(summaryBody).join('\n')}`)
  } finally {
    if (server) await killServer(server)
    await double.close()
    removeDir(home)
  }
})
