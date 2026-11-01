import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — every turn ends in the log, a failed or stopped one included (#16, #29).
 *
 * **The claim it decides:** a turn whose model call fails, and a turn stopped while the model streams, both leave an
 * `assistant/completed` naming why the turn ended and a closing `turn/completed`. The session view a reload draws
 * from shows the failure.
 *
 * Measured before (drafts developer-four-5 and developer-ten-2). On both builds a failed turn left the log with the
 * prompt and nothing else: the live stream said `event: error`, but a reload, a second tab or a client whose stream
 * dropped saw a message with no answer and no failure, and the next turn's model read two prompts in a row. On TS a
 * stopped turn did the same. DSH's loop appends `turn/end` with its reason in a `finally`.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** A chat double whose answer starts and never finishes, so a stop is what ends it. */
async function endlessDouble() {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'counting ' }, finish_reason: null }] })}\n\n`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((done) => {
      server.close(done)
      server.closeAllConnections()
    }),
  }
}

/** Start the Web UI and resolve once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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
    })()
  })
}

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** Post a turn; resolve its session as soon as the stream names it, and the whole body when it ends. */
async function postTurn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, `the turn was accepted (${JSON.stringify(body.prompt)})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let nameSession
  const session = new Promise((resolve) => {
    nameSession = resolve
  })
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      text += decoder.decode(value, { stream: true })
      const named = /event: session\ndata: (\{.*\})/.exec(text)
      if (named) {
        try {
          const id = JSON.parse(named[1]).session
          if (typeof id === 'string') nameSession(id)
        } catch {
          // A block not yet whole.
        }
      }
    }
    nameSession(undefined)
    return text
  })()
  return { session, done }
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

/** Serve one home on an endpoint and hand the test the server. */
async function serve(label, baseUrl, body) {
  const home = fixtureDir(label)
  httpConfig({ home, baseUrl })
  const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: join(home, 'heddle.json'),
  })
  try {
    await body(server, (session) => readTranscript(join(home, 'sessions', session)))
  } finally {
    server.kill()
    removeDir(home)
  }
}

/** The turn's ending, as the log records it. */
function ending(events) {
  const prompt = events.findIndex((event) => event.type === 'message' && event.message?.role === 'user')
  const after = events.slice(prompt + 1)
  return {
    completed: after.filter((event) => event.type === 'assistant/completed'),
    closed: after.filter((event) => event.type === 'turn/completed'),
    types: events.map((event) => event.type).join(' '),
  }
}

test('a turn whose model call fails is ended in the log with its reason, and the view shows it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  // Port 9 (discard) refuses connections on loopback, as the live report's dead endpoint did.
  await serve('turn-end-failed', 'http://127.0.0.1:9/v1', async (server, log) => {
    const turn = await postTurn(server, { prompt: 'Say hi' })
    const session = await turn.session
    assert.ok(typeof session === 'string', 'the turn named its session')
    const text = await turn.done
    assert.match(text, /^event: error$/m, 'the live stream says the turn failed')
    const { completed, closed, types } = ending(log(session))
    assert.equal(completed.length, 1, `the failed turn is ended in the log\n${types}`)
    assert.match(String(completed[0].ended?.[0]), /could not be sent/, 'naming the failure')
    assert.equal(closed.length, 1, `and closed\n${types}`)
    const view = await (await request(server, `/api/sessions/${encodeURIComponent(session)}`)).text()
    assert.match(view, /could not be sent/, 'the session view, which a reload draws, shows the failure')
  })
})

test('a turn stopped while the model streams is ended in the log as stopped', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await endlessDouble()
  try {
    await serve('turn-end-stopped', double.url, async (server, log) => {
      const turn = await postTurn(server, { prompt: 'count' })
      const session = await turn.session
      assert.ok(typeof session === 'string', 'the turn named its session')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const stop = await request(server, `/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST', body: '{}' })
      assert.equal(stop.status, 200, 'the stop was accepted')
      await turn.done
      const { completed, closed, types } = ending(log(session))
      assert.equal(completed.length, 1, `the stopped turn is ended in the log\n${types}`)
      assert.match(String(completed[0].ended?.join(' ')), /stopped/, 'as stopped')
      assert.equal(closed.length, 1, `and closed\n${types}`)
      // #99: a stop is a cancellation, not a request failure, so the overflow recovery is not involved (DSH, Rust).
      assert.equal(/compaction\/recovery/.test(types), false, `and no compaction/recovery for a call that never failed\n${types}`)
    })
  } finally {
    await double.close()
  }
})
