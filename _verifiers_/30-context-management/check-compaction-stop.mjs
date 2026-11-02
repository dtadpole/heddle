import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A Stop or a restart during a turn's automatic compaction is honoured (#154).
 *
 * Measured before, live and on scratch servers, on both builds:
 * - A Stop during the summary did not stop it. The summary landed seconds after the Stop. TS then called the model and
 *   answered in full; Rust logged a `model/request` and cut it.
 * - A kill during the summary left the log at `compaction/start`. Nothing closed the turn at the next open, because it
 *   had not reached its first model request, so the transcript ended with the bare question.
 *
 * DSH's `dsh-compaction-basic`: "Cancellation stays authoritative throughout". The pre-step compaction runs with the
 * turn's signal and the summary request carries it, so a cancelled summary lands no replacement. DSH appends
 * `turn/start` before the pre-step, so a process that dies there leaves a turn `openTurnClosers` closes as interrupted.
 *
 * The fixture makes the second turn's request cross the compaction trigger with the first turn's long prompt to fold,
 * against a double that holds the summary call open until its caller lets go.
 *
 * #200 adds the Stop that lands once the summary has begun to stream: the cut text is not the summary, on either path.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** The summariser's directive, in either of the wordings the builds have used (DSH's since #77, the older one before). */
function isSummaryRequest(body) {
  return body.includes('acting as a compaction engine') || body.includes('Summarise the conversation above')
}

/**
 * The window and the two prompts.
 *
 * The default tree's request costs about 7,000 estimated tokens before any prompt (its tool schemas are most of it).
 * With a 40,000-token window the trigger is 32,000 and the retained tail 6,400. The first prompt (about 21,800) keeps
 * the first turn under the trigger; the second (about 5,600) takes the next request over it and fits the retained
 * tail, so the first turn is the span the compaction folds.
 */
const WINDOW = 40_000
const FIRST = `Keep this in mind: ${'the quick brown fox jumps over the lazy dog, '.repeat(1950)}`
const SECOND = `And now the question: ${'a lazy dog sleeps under the quick brown fox, '.repeat(500)}`

/**
 * A chat double that answers turns at once and, while `hold` is set, holds a summary call open until it is dropped.
 *
 * With `partial` set to a string, the held call streams one chunk first: that text as the summary's opening (`''` sends
 * the role alone). Then a Stop cuts a stream that has begun, not one still waiting for its first byte (#200).
 */
async function holdingDouble() {
  const state = { hold: false, partial: null, turnCalls: [], summaries: 0, summaryDropped: null, summaryAt: null, held: [] }
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
        if (state.partial !== null) {
          /**
           * The streamed form is close-delimited, as a gateway that ends the body by closing the connection sends it
           * (developer-four's J143 fake, and the live route where #200 was seen). A client that drops such a body sees
           * it end, not fail, so a cut summary reaches the caller as text. A chunked body would fail with "aborted"
           * and hide #200.
           */
          response.useChunkedEncodingByDefault = false
          response.shouldKeepAlive = false
          response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: state.partial }, finish_reason: null }] })}\n\n`)
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
        }
        state.summaryAt = Date.now()
        state.held.push(response)
        response.on('close', () => {
          if (state.summaryDropped === null && !response.writableEnded) state.summaryDropped = Date.now()
        })
        return
      }
      state.turnCalls.push(Date.now())
      answer(response, 'answered')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  /** Answer every held summary call now. */
  const release = () => {
    state.hold = false
    for (const response of state.held.splice(0)) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'a compact briefing of the conversation so far' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    }
  }
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    release,
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

/** Post a turn, streamed; resolve its session as soon as the stream names it, and the whole body when it ends. */
async function postTurn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, `the turn was accepted (${String(body.prompt).slice(0, 40)})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let nameSession
  const session = new Promise((resolve) => {
    nameSession = resolve
  })
  const done = (async () => {
    try {
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
    } catch {
      // A server killed mid-turn ends the body with an error; what was read is the answer.
    }
    nameSession(undefined)
    return text
  })()
  return { session, done }
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

/** One home on the double, with the window above; `body` gets a server starter and the log reader. */
async function withHome(label, double, body) {
  const home = fixtureDir(label)
  writeJson(join(home, 'heddle.json'), {
    default: 'double',
    endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true, contextWindow: WINDOW }],
  })
  const servers = []
  const start = async () => {
    const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
      HEDDLE_HOME: home,
      HEDDLE_CONFIG: join(home, 'heddle.json'),
    })
    servers.push(server)
    return server
  }
  try {
    await body(start, (session) => readTranscript(join(home, 'sessions', session)))
  } finally {
    for (const server of servers) await killServer(server)
    removeDir(home)
  }
}

/** The first turn, answered in full; the second turn is the one whose compaction is under test. */
async function firstTurn(server) {
  const first = await postTurn(server, { prompt: FIRST })
  const session = await first.session
  assert.ok(typeof session === 'string', 'the first turn named its session')
  const text = await first.done
  assert.match(text, /event: done/, `the first turn finished\n${text.slice(-400)}`)
  return session
}

/** The events from the second prompt on. */
function secondTurn(events) {
  const prompts = events.map((event, index) => (event.type === 'message' && event.message?.role === 'user' ? index : -1)).filter((index) => index >= 0)
  const from = prompts[1] ?? events.length
  const after = events.slice(from + 1)
  return { after, types: after.map((event) => event.type) }
}

test('a Stop while the turn’s automatic summary runs cancels it: no replacement lands, no model request follows, and the turn ends stopped', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await holdingDouble()
  try {
    await withHome('compaction-stop', double, async (start, log) => {
      const server = await start()
      const session = await firstTurn(server)

      double.state.hold = true
      const callsBefore = double.state.turnCalls.length
      const second = await postTurn(server, { session, prompt: SECOND })
      assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `the second turn compacted first, and its summary call reached the double\n${secondTurn(log(session)).types.join(' ')}`)

      const stop = await request(server, `/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST', body: '{}' })
      assert.equal(stop.status, 200, 'the stop was accepted')
      const stoppedAt = Date.now()
      assert.ok(await until(() => double.state.summaryDropped !== null, 5000), 'the summary call was dropped once the turn was stopped')
      const text = await Promise.race([second.done, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
      assert.notEqual(text, null, 'and the turn ended within moments')
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(double.state.turnCalls.length, callsBefore, `no model call followed the stop (${double.state.turnCalls.length - callsBefore} did, ${Date.now() - stoppedAt} ms after)`)

      const { after, types } = secondTurn(log(session))
      assert.ok(types.includes('compaction/start'), `the compaction had started\n${types.join(' ')}`)
      assert.ok(!types.includes('compaction/summary') && !types.includes('compaction/end'), `and landed nothing\n${types.join(' ')}`)
      assert.ok(!after.some((event) => event.type === 'context/note' && event.origin === 'compaction'), 'no replacement note was written')
      const failed = after.find((event) => event.type === 'compaction/failed')
      assert.ok(failed, `the span is closed as failed\n${types.join(' ')}`)
      assert.equal(failed.stopped, true, `as stopped (${JSON.stringify(failed)})`)
      assert.notEqual(failed.refused, true, 'not as refused')
      assert.ok(!types.slice(types.indexOf('compaction/start')).includes('model/request'), `no model request after the compaction started\n${types.join(' ')}`)
      const completed = after.filter((event) => event.type === 'assistant/completed')
      assert.equal(completed.length, 1, `the turn is ended once\n${types.join(' ')}`)
      assert.match(String(completed[0].ended?.join(' ')), /stopped by the caller/, 'as stopped by the caller')
      assert.equal(after.filter((event) => event.type === 'turn/completed').length, 1, 'and closed')

      /** A /compact on the idle session, with no Stop, still runs to the end: the signal is not a default cancel. */
      double.state.hold = false
      const compacted = await request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
      assert.equal(compacted.status, 200, `/compact answered (${await compacted.clone().text()})`)
      const end = secondTurn(log(session)).types
      assert.ok(end.includes('compaction/end'), `a /compact with no Stop lands its replacement\n${end.join(' ')}`)
    })
  } finally {
    await double.close()
  }
})

test('a turn whose server is killed during its automatic summary reads as interrupted after the restart, not as a bare question', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await holdingDouble()
  try {
    await withHome('compaction-kill', double, async (start, log) => {
      const server = await start()
      const session = await firstTurn(server)

      double.state.hold = true
      const second = await postTurn(server, { session, prompt: SECOND })
      assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `the second turn compacted first\n${secondTurn(log(session)).types.join(' ')}`)
      await killServer(server)
      await second.done
      const cut = secondTurn(log(session)).types
      assert.equal(cut.at(-1), 'compaction/start', `the log ends inside the summary, as a crash leaves it\n${cut.join(' ')}`)

      double.state.hold = false
      const again = await start()
      const view = await (await request(again, `/api/sessions/${encodeURIComponent(session)}`)).json()
      const turns = view.turns ?? []
      const last = turns.at(-1)
      assert.equal(last?.kind, 'assistant', `the question is followed by an answer row, not left bare (${JSON.stringify(turns.slice(-2)).slice(0, 400)})`)
      assert.match(String(last?.ended?.join(' ')), /the process exited before this turn finished/, 'which says the turn was interrupted')

      /** The next turn works, as it did before: it compacts again and is answered. */
      const next = await postTurn(again, { session, prompt: 'one more' })
      const text = await next.done
      assert.match(text, /answered/, `the next turn is answered\n${text.slice(-400)}`)
    })
  } finally {
    await double.close()
  }
})

test('a turn sent while /compact runs waits for it, and starts once the compaction has ended (#140)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * Live #140 on both builds: a turn sent while /compact ran started at once, beside it, and the summary was written
   * after the turn. DSH holds the prompt until its compaction ends (`runMaintenance`).
   */
  const double = await holdingDouble()
  try {
    await withHome('compaction-hold', double, async (start, log) => {
      const server = await start()
      const session = await firstTurn(server)

      double.state.hold = true
      const compact = request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
      assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `/compact asked for its summary\n${secondTurn(log(session)).types.join(' ')}`)

      const callsBefore = double.state.turnCalls.length
      const turn = await postTurn(server, { session, prompt: 'sent while the compaction runs' })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(double.state.turnCalls.length, callsBefore, 'the turn did not start beside the compaction')

      double.release()
      const answered = await compact
      const said = await answered.text()
      assert.equal(answered.status, 200, `/compact answered (${said})`)
      assert.match(said, /Compacted/, `and compacted (${said})`)
      const text = await turn.done
      assert.match(text, /answered/, `the held turn ran once the compaction ended\n${text.slice(-300)}`)
      const types = log(session).map((event) => event.type)
      const end = types.indexOf('compaction/end')
      const lastRequest = types.lastIndexOf('model/request')
      assert.ok(end >= 0 && lastRequest > end, `the turn's model request came after the compaction's end\n${types.join(' ')}`)
    })
  } finally {
    await double.close()
  }
})

test('a Stop while /compact runs with a turn waiting behind it cancels both: the compaction says so, and the waiting turn ends stopped with no model call (#140, #154)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * developer-ten's edge on #140. One Stop reaches the compaction (it holds the session in the live-turn registry) and
   * the turn queued behind it. DSH answers the stopped command "Compaction cancelled." (dsh-command-compact
   * `cancelled`), and a turn cancelled while it waits still records its prompt, with the stop and no model call.
   */
  const double = await holdingDouble()
  try {
    await withHome('compaction-hold-stop', double, async (start, log) => {
      const server = await start()
      const session = await firstTurn(server)

      double.state.hold = true
      const compact = request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
      assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `/compact asked for its summary\n${secondTurn(log(session)).types.join(' ')}`)
      const callsBefore = double.state.turnCalls.length
      const waiting = await postTurn(server, { session, prompt: 'queued behind a compaction that is then stopped' })
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const stop = await request(server, `/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST', body: '{}' })
      assert.equal(stop.status, 200, 'the stop was accepted')
      const answered = await compact
      const body = await answered.json()
      assert.equal(body.kind, 'error', `the stopped /compact is an error (${JSON.stringify(body)})`)
      assert.equal(body.text, 'Compaction cancelled.', "in DSH's words")
      assert.ok(await until(() => double.state.summaryDropped !== null, 5000), 'its summary call was dropped')
      const text = await Promise.race([waiting.done, new Promise((resolve) => setTimeout(() => resolve(null), 15_000))])
      assert.notEqual(text, null, 'the waiting turn ended')
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(double.state.turnCalls.length, callsBefore, 'and no model call was made, for either')

      const events = log(session)
      const types = events.map((event) => event.type)
      assert.ok(!types.includes('compaction/end'), `no replacement landed\n${types.join(' ')}`)
      const prompt = events.findIndex((event) => event.type === 'message' && event.message?.role === 'user' && JSON.stringify(event.message).includes('queued behind a compaction'))
      assert.ok(prompt >= 0, `the waiting turn's prompt is recorded\n${types.join(' ')}`)
      const after = events.slice(prompt + 1)
      assert.ok(!after.some((event) => event.type === 'model/request'), `with no model request after it\n${types.join(' ')}`)
      const completed = after.find((event) => event.type === 'assistant/completed')
      assert.match(String(completed?.ended?.join(' ')), /stopped by the caller/, `and it is ended as stopped\n${types.join(' ')}`)
    })
  } finally {
    await double.close()
  }
})

/**
 * #200, developer-four's J143 on a slow-streaming fake: a Stop before the summary's first byte was honoured on TS, but a
 * Stop once it had begun to stream was not. The cut stream came back as text, so TS committed it as the checkpoint, or
 * refused an empty cut as "the summariser returned nothing" with no stopped flag. Rust recorded both as stopped.
 */
for (const [form, partial] of [
  ['part of the summary', 'a compact brief'],
  ['its first chunk, with no text yet', ''],
]) {
  test(`a Stop once the turn’s automatic summary has streamed ${form} lands nothing, and the turn ends stopped (#200)`, async (context) => {
    if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
    const double = await holdingDouble()
    try {
      await withHome('compaction-stop-streamed', double, async (start, log) => {
        const server = await start()
        const session = await firstTurn(server)

        double.state.hold = true
        double.state.partial = partial
        const callsBefore = double.state.turnCalls.length
        const second = await postTurn(server, { session, prompt: SECOND })
        assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `the second turn compacted first, and its summary began to stream\n${secondTurn(log(session)).types.join(' ')}`)
        // The chunk is on the wire; give the reader time to take it, so the Stop cuts a stream that has begun.
        await new Promise((resolve) => setTimeout(resolve, 500))

        const stop = await request(server, `/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST', body: '{}' })
        assert.equal(stop.status, 200, 'the stop was accepted')
        const text = await Promise.race([second.done, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
        assert.notEqual(text, null, 'the turn ended within moments')
        await new Promise((resolve) => setTimeout(resolve, 500))

        const { after, types } = secondTurn(log(session))
        assert.ok(types.includes('compaction/start'), `the compaction had started\n${types.join(' ')}`)
        assert.ok(!types.includes('compaction/summary') && !types.includes('compaction/end'), `the cut summary landed nothing\n${types.join(' ')}`)
        assert.ok(!after.some((event) => event.type === 'context/note' && event.origin === 'compaction'), 'no replacement note was written')
        const failed = after.find((event) => event.type === 'compaction/failed')
        assert.ok(failed, `the span is closed as failed\n${types.join(' ')}`)
        assert.equal(failed.stopped, true, `as stopped (${JSON.stringify(failed)})`)
        assert.notEqual(failed.refused, true, 'not as refused')
        assert.equal(failed.reason, 'stopped by the caller', 'and not as "the summariser returned nothing"')
        assert.equal(double.state.turnCalls.length, callsBefore, 'no model call followed the stop')
        const completed = after.filter((event) => event.type === 'assistant/completed')
        assert.equal(completed.length, 1, `the turn is ended once\n${types.join(' ')}`)
        assert.match(String(completed[0].ended?.join(' ')), /stopped by the caller/, 'as stopped by the caller')
      })
    } finally {
      await double.close()
    }
  })
}

test('a Stop once /compact’s summary has begun to stream answers "Compaction cancelled." and lands nothing (#200)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await holdingDouble()
  try {
    await withHome('compaction-compact-streamed', double, async (start, log) => {
      const server = await start()
      const session = await firstTurn(server)

      double.state.hold = true
      double.state.partial = 'a compact brief'
      const compact = request(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
      assert.ok(await until(() => double.state.summaryAt !== null, 20_000), `/compact's summary began to stream\n${secondTurn(log(session)).types.join(' ')}`)
      await new Promise((resolve) => setTimeout(resolve, 500))

      const stop = await request(server, `/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST', body: '{}' })
      assert.equal(stop.status, 200, 'the stop was accepted')
      const answered = await compact
      const body = await answered.json()
      assert.equal(body.kind, 'error', `the cut /compact is an error, not "Compacted …" (${JSON.stringify(body)})`)
      assert.equal(body.text, 'Compaction cancelled.', "in DSH's words")

      const events = log(session)
      const types = events.map((event) => event.type)
      assert.ok(!types.includes('compaction/summary') && !types.includes('compaction/end'), `no replacement landed\n${types.join(' ')}`)
      const failed = events.findLast((event) => event.type === 'compaction/failed')
      assert.equal(failed?.stopped, true, `the span is closed as stopped (${JSON.stringify(failed)})`)
    })
  } finally {
    await double.close()
  }
})
