import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, transcriptFile, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A `/compact` cut by a restart settles at the next open, as "Compaction cancelled." (#206).
 *
 * Measured before, live and on scratch servers, on both builds: a server killed 2.5 s into `/compact`'s summary left
 * the log at `command/run` and `compaction/start`, with no closer and no `command/done`. After the restart the page drew
 * the `/compact` row as Running… for good, on every fresh open, and nothing told the person the compaction they asked
 * for did not happen.
 *
 * DSH logs a command as heddle does (dsh-commands: `command/run` before the handler, `command/done` after it settles),
 * settles a cancelled `/compact` as "Compaction cancelled." (dsh-command-compact README), and closes what a dead
 * writer left open when the session is next opened for writing, showing the same closers on a cold read before that
 * (dsh-session `openTurnClosers`, dsh-session-query `readColdSessionLog`). heddle's closers for a cut turn do the same
 * (issue #5, `src/session/repair.ts`); this check holds them to a cut command.
 */

const CAPABILITY = 'a Web UI whose command route runs /compact'

/** The summariser's directive, in either of the wordings the builds have used (DSH's since #77, the older one before). */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/** The window and the prompt: one turn long enough that `/compact` has a span to fold (check-compaction-stop's fixture). */
const WINDOW = 40_000
const FIRST = `Keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`

/** A chat double that answers turns at once and, while `hold` is set, holds a summary call open. */
async function holdingDouble() {
  const state = { hold: false, summaries: 0, summaryAt: null, turnCalls: 0 }
  const answer = (response, text) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
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
        if (!state.hold) return answer(response, 'a compact briefing of the conversation so far')
        state.summaryAt = Date.now()
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        return
      }
      state.turnCalls += 1
      answer(response, 'answered')
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

/** Kill a server outright, as a crash does, and wait for it to be gone. */
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

async function until(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return Boolean(await condition())
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a /compact cut by a restart reads as "Compaction cancelled." at once, is closed in the log before the next turn, and only once across two restarts (#206)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await holdingDouble()
  const home = fixtureDir('compact-restart')
  writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
  })
  const sessions = join(home, 'sessions')
  const servers = []
  const start = async () => {
    const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    servers.push(server)
    return server
  }
  try {
    let server = await start()
    const first = await turn(server, { prompt: FIRST })
    const session = first.session
    assert.ok(typeof session === 'string', `the first turn named its session\n${first.text.slice(-300)}`)
    assert.match(first.text, /event: done/, 'and finished')
    const log = () => readTranscript(join(sessions, session))
    const transcript = () => transcriptFile(join(sessions, session))
    const types = (events) => events.map((event) => event.type).join(' ')

    /** `/compact` is sent and not awaited; the server is killed while the double holds its summary. */
    double.state.hold = true
    const compact = request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) }).catch(() => undefined)
    assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `/compact asked for its summary\n${types(log())}`)
    await killServer(server)
    await compact
    const cut = log()
    const run = cut.find((event) => event.type === 'command/run' && event.name === 'compact')
    assert.ok(run, `the log holds the /compact run\n${types(cut)}`)
    const startEvent = cut.find((event) => event.type === 'compaction/start')
    assert.equal(cut.at(-1)?.type, 'compaction/start', `the log ends inside the summary, as a crash leaves it\n${types(cut)}`)
    assert.ok(!cut.some((event) => event.type === 'command/done' && event.commandId === run.commandId), 'with no command/done')
    const cutBytes = readFileSync(transcript())

    /** After the restart, the first read already shows the row settled, and writes nothing. */
    double.state.hold = false
    server = await start()
    const view = async () => {
      const response = await request(server, `/api/sessions/${encodeURIComponent(session)}`)
      assert.equal(response.status, 200, 'the session is served')
      return (await response.json()).turns ?? []
    }
    const row = (turns) => turns.find((one) => one.kind === 'command' && one.commandId === run.commandId)
    const shown = row(await view())
    assert.equal(shown?.state, 'error', `after the restart the /compact row is settled as an error, not Running… (${JSON.stringify(shown)})`)
    assert.equal(shown?.text, 'Compaction cancelled.', "in DSH's words for a cancelled /compact")
    assert.ok(readFileSync(transcript()).equals(cutBytes), 'and reading the session wrote nothing to its log')

    /** The next turn opens the session for writing: the closers are appended first, then the turn. */
    const next = await turn(server, { session, prompt: 'what did I ask you to keep in mind?' })
    assert.ok(!next.text.includes('event: error'), `the next turn ran\n${next.text.slice(-400)}`)
    const after = log()
    assert.deepEqual(after.map((event) => event.seq), after.map((_, index) => index), 'every seq is written once, in order')
    const closers = after.slice(cut.length, cut.length + 2)
    assert.deepEqual(closers.map((event) => event.type), ['compaction/failed', 'command/done'], `the log is closed right after the cut, before anything else\n${types(after.slice(cut.length))}`)
    assert.equal(closers[0].stopped, true, `the span is closed as stopped (${JSON.stringify(closers[0])})`)
    assert.notEqual(closers[0].refused, true, 'not as refused')
    assert.equal(closers[0].fromSeq, startEvent.fromSeq, 'over the span the compaction opened')
    assert.equal(closers[0].throughSeq, startEvent.throughSeq)
    assert.match(String(closers[0].reason), /the process exited before the compaction finished/)
    assert.deepEqual(
      { commandId: closers[1].commandId, kind: closers[1].kind, text: closers[1].text },
      { commandId: run.commandId, kind: 'error', text: 'Compaction cancelled.' },
      'and the command is answered',
    )
    assert.ok(!after.slice(cut.length).some((event) => event.type === 'compaction/end'), 'no replacement landed for the cut compaction')
    const prompt = after.findIndex((event, index) => index >= cut.length && event.type === 'message' && event.message?.role === 'user')
    assert.ok(prompt >= cut.length + 2, 'and the next prompt comes after the closers')

    /** A second restart closes nothing again, and the session still compacts. */
    await killServer(server)
    server = await start()
    const again = await turn(server, { session, prompt: 'one more' })
    assert.ok(!again.text.includes('event: error'), `a turn after the second restart ran\n${again.text.slice(-400)}`)
    const twice = log()
    assert.equal(twice.filter((event) => event.type === 'command/done' && event.commandId === run.commandId).length, 1, `the /compact is answered once\n${types(twice)}`)
    assert.equal(twice.filter((event) => event.type === 'compaction/failed').length, 1, 'and its span closed once')
    assert.equal(row(await view())?.state, 'error', 'the row stays settled')
    const compacted = await request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
    const said = await compacted.json()
    assert.equal(said.kind, 'success', `a new /compact runs to the end (${JSON.stringify(said)})`)
    assert.match(String(said.text), /^Compacted /)
  } finally {
    for (const one of servers) await killServer(one)
    await double.close()
    removeDir(home)
  }
})
