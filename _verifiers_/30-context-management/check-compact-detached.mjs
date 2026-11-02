import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A `/compact` whose request goes away still runs to its end and settles (#206).
 *
 * Measured by developer-four (J148, main 9cbeb6cd). On the Rust build, a page reload during `/compact` dropped the
 * `POST /api/sessions/<id>/commands` request, and with it the compaction mid-summary:
 * - the provider saw the summary connection close at the reload;
 * - the log kept `command/run` and `compaction/start` with no closer and no `command/done`;
 * - the row read Running… for good, on fresh opens too.
 * The TS build finished the compaction, and the reloaded page showed "Compacted 5 history items".
 * DSH runs the command on the host, and a browser only observes it: a reload is not a cancel.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

const WINDOW = 40_000
const FIRST = `Keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`

/** A chat double that answers turns at once and holds every summary call until `release`. */
async function holdingDouble() {
  const state = { summaryAt: null, summaryDropped: null, held: [] }
  const answer = (response, text) => {
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
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!isSummaryRequest(body)) return answer(response, 'answered')
      state.summaryAt = Date.now()
      state.held.push(response)
      response.on('close', () => {
        if (state.summaryDropped === null && !response.writableEnded) state.summaryDropped = Date.now()
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    release: () => {
      for (const response of state.held.splice(0)) answer(response, 'a compact briefing of the conversation so far')
    },
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

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

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
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

test('a /compact whose request goes away mid-summary still compacts and settles its row, as a reload must not cancel it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await holdingDouble()
  const home = fixtureDir('compact-detached')
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
    const first = await (await request(server, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: FIRST }) })).text()
    const named = /event: session\ndata: (\{.*\})/.exec(first)
    const session = named ? JSON.parse(named[1]).session : undefined
    assert.ok(typeof session === 'string', `the first turn named its session\n${first.slice(-300)}`)
    const log = () => readTranscript(join(home, 'sessions', session))

    const client = new AbortController()
    const compact = request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ line: '/compact' }),
      signal: client.signal,
    }).catch((error) => error)
    assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `/compact asked for its summary\n${log().map((event) => event.type).join(' ')}`)
    // The page goes away: a reload, a closed tab, a client timeout.
    client.abort()
    await compact
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(double.state.summaryDropped, null, 'the summary call was not dropped with the request')

    double.release()
    assert.ok(
      await until(() => log().some((event) => event.type === 'command/done'), 15_000),
      `the /compact settled although nobody waited for its answer\n${log().map((event) => event.type).join(' ')}`,
    )
    const events = log()
    const done = events.find((event) => event.type === 'command/done')
    assert.equal(done.kind, 'success', `as a success (${JSON.stringify(done)})`)
    assert.match(String(done.text), /^Compacted /, `saying what it compacted (${JSON.stringify(done)})`)
    const types = events.map((event) => event.type)
    assert.ok(types.includes('compaction/end'), `the compaction landed\n${types.join(' ')}`)
  } finally {
    if (server !== undefined) await killServer(server)
    await double.close()
    removeDir(home)
  }
})
