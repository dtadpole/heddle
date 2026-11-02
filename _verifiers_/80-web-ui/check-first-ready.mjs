import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — a message sent before the page's event stream opens is drawn once the stream opens (#128's first-ready
 * follow-up).
 *
 * **The claim it decides:** a person who sends while the page's stream is still opening (a slow network, a page that is
 * still loading, a stream waiting for its lock) sees their message, and its answer, once the stream opens, each once and
 * without a reload. The catch-up never moves the page: a person who opened another session meanwhile stays there, and a
 * page whose stream was open when it sent reads nothing extra.
 *
 * Measured before (developer-ten, d5db; integrator-two's flaky strict-policy case): `runTurn` waits up to 3 s for the
 * stream (`events.whenOpen`) and then sends regardless. The first connection presents no cursor, so its `ready` replays
 * nothing, and the first `ready` reads nothing either (`StreamBaseline`). Whatever the server wrote between the turn's
 * acceptance and the subscription, the person's own message first, never reached the page until a reload.
 *
 * **How:** the page reaches the server through an HTTP proxy this check owns, which holds every `GET /api/events` until
 * the check lets them through (as a slow first connection does) and counts the page's session reads
 * (`GET /api/sessions/<id>`). The model double holds each answer until the check releases it, so the turn is still
 * running when the stream opens and its answer arrives live afterwards.
 */

const CAPABILITY = 'a Web UI whose page follows the event stream'

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await sleep(50)
  return predicate()
}

/** A chat double that answers `answer to MARK-x` for a prompt carrying `MARK-x`, once the check releases it. */
async function heldDouble() {
  const prompts = []
  const waiting = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', async () => {
      const pathname = new URL(request.url ?? '/', 'http://x').pathname
      if (pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      const messages = JSON.parse(body || '{}').messages ?? []
      /** The prompt is the newest user message with a marker: the harness adds user messages of its own after it. */
      const texts = messages
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')))
      const prompt = [...texts].reverse().find((text) => /MARK-\w+/.test(text)) ?? ''
      prompts.push(prompt)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      frame({ role: 'assistant', content: '' })
      await new Promise((resolvePromise) => waiting.push(resolvePromise))
      if (response.destroyed) return
      frame({ content: `answer to ${/MARK-\w+/.exec(prompt)?.[0] ?? 'nothing'}` })
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    prompts,
    /** Let every answer held so far go. */
    answer() {
      for (const resolvePromise of waiting.splice(0)) resolvePromise()
    },
    close: () =>
      new Promise((resolvePromise) => {
        for (const resolvePromise of waiting.splice(0)) resolvePromise()
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}

/**
 * An HTTP proxy in front of the server. It forwards every request as it came (the Host and Origin the browser sent
 * included), holds `GET /api/events` while `holding`, and records the page's session reads.
 */
async function holdingProxy(target) {
  let holding = true
  const held = []
  const sessionReads = []
  const sockets = new Set()
  const server = createServer((request, response) => {
    let gone = false
    response.on('close', () => {
      gone = true
    })
    const pathname = new URL(request.url ?? '/', 'http://x').pathname
    const read = /^\/api\/sessions\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && read !== null) sessionReads.push({ id: decodeURIComponent(read[1]), at: Date.now() })
    const forward = () => {
      if (gone) return
      const upstream = httpRequest({ host: target.hostname, port: target.port, method: request.method, path: request.url, headers: request.headers }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      })
      upstream.on('error', () => response.destroy())
      response.on('close', () => upstream.destroy())
      /** A held GET finished its (empty) body long ago, so it is ended here rather than piped. */
      if (request.method === 'GET' || request.method === 'HEAD') upstream.end()
      else request.pipe(upstream)
    }
    if (pathname === '/api/events' && holding) {
      held.push(forward)
      return
    }
    forward()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    port: server.address().port,
    sessionReads,
    /** The page's reads of session `id` since `since` (a `Date.now()`). */
    readsOf: (id, since = 0) => sessionReads.filter((entry) => entry.id === id && entry.at >= since).length,
    /** Let the held stream connections through, and every later one. */
    release() {
      holding = false
      for (const forward of held.splice(0)) forward()
    },
    close: () =>
      new Promise((resolvePromise) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolvePromise())
      }),
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

/**
 * One test's world: the double, the server with its workspace registered before any page loads (so a first visit has
 * somewhere to start at once), the proxy, and a browser that has not loaded the page yet.
 */
async function world(label) {
  const opened = []
  try {
    const home = isolatedHome(`first-ready-${label}`)
    opened.push(() => removeDir(home))
    const work = fixtureDir(`first-ready-${label}-work`)
    mkdirSync(work, { recursive: true })
    opened.push(() => removeDir(work))
    const double = await heldDouble()
    opened.push(() => double.close())
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'double',
      endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'model-one', capabilities: ['chat', 'stream'] }],
    })
    const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')], {
      env: { HEDDLE_CONFIG: config, HEDDLE_HOME: home, HOME: home },
    })
    opened.push(() => server.kill())
    const door = await fetch(server.url, { redirect: 'manual' })
    const cookie = String(door.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the handshake set a cookie')
    const headers = { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' }
    const post = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: 'POST', headers, body: JSON.stringify(body) })
      assert.ok(response.ok, `${path} answered ${response.status}`)
      return response.json()
    }
    await post('/api/workspaces', { path: work })
    const proxy = await holdingProxy(new URL(server.url))
    opened.push(() => proxy.close())
    const pageUrl = new URL(server.url)
    pageUrl.port = String(proxy.port)
    const browser = await openBrowser({ width: 1280, height: 900 })
    opened.push(() => browser.close())
    return {
      double,
      proxy,
      browser,
      pageUrl: pageUrl.toString(),
      /** A blank session in the workspace, titled so the header names it. */
      session: async (title) => {
        const id = (await post('/api/sessions', { branch: work })).session
        await post(`/api/sessions/${id}/title`, { title })
        return id
      },
      close: async () => {
        for (const close of opened.reverse()) await Promise.resolve(close()).catch(() => {})
      },
    }
  } catch (error) {
    // A setup that fails still closes what it opened, so the test process can exit and its browser hold ends.
    for (const close of opened.reverse()) await Promise.resolve(close()).catch(() => {})
    throw error
  }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

/** Type a draft, wait until Send would take it (a workspace is drawn), and press Enter, as a person does. */
async function send(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await browser.waitFor(`document.getElementById('send')?.disabled === false`, 15_000)
  await browser.evaluate(`(() => {
    document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
}

/** How many rows of `kind` in the conversation hold `text`. */
const rows = (kind, text) =>
  `Array.from(document.querySelectorAll('#log [data-kind=${kind}]')).filter((row) => row.textContent.includes(${JSON.stringify(text)})).length`
const STREAM_OPEN = `document.body.dataset.connection === 'open'`
const SETTLED = `document.getElementById('stop').hidden === true`

/**
 * Wait for the turn to reach the model while the stream is held, then open the stream: what the page drew in between
 * is what the test judges.
 */
async function openAfterSend(at, mark) {
  assert.ok(await until(() => at.double.prompts.some((prompt) => prompt.includes(mark)), 20_000), `the turn reached the model (prompts: ${JSON.stringify(at.double.prompts)})`)
  assert.equal(await at.browser.evaluate(STREAM_OPEN), false, 'and the page sent it while its stream was still held')
  const releasedAt = Date.now()
  at.proxy.release()
  assert.ok(await at.browser.waitFor(STREAM_OPEN, 20_000), 'the stream opens once it is let through')
  return releasedAt
}

test('a first message sent as the page loads, before its stream opens, is drawn once the stream opens, with its answer, each once', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('first')
  try {
    await at.browser.goto(at.pageUrl)
    await at.browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000)
    const message = 'MARK-FIRST sent as the page loads'
    await send(at.browser, message)
    await openAfterSend(at, 'MARK-FIRST')
    const drawn = await at.browser.waitFor(`${rows('user', message)} >= 1`, 10_000).catch(() => false)
    assert.ok(drawn, `the person's own message is drawn once the stream opens, without a reload\n${(await at.browser.evaluate(`document.getElementById('log').innerText`)).slice(-400)}`)
    at.double.answer()
    assert.ok(await at.browser.waitFor(`${rows('assistant', 'answer to MARK-FIRST')} >= 1 && ${SETTLED}`, 15_000), 'its answer arrives live and the turn ends')
    await sleep(500)
    assert.equal(await at.browser.evaluate(rows('user', message)), 1, 'the message is drawn once')
    assert.equal(await at.browser.evaluate(rows('assistant', 'answer to MARK-FIRST')), 1, 'and so is the answer')
  } finally {
    await at.close()
  }
})

test('a message sent into an open session before the stream opens is drawn once it opens, read once', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('open')
  try {
    const session = await at.session('SEEDED-S')
    await at.browser.gotoSession(at.pageUrl, session)
    await at.browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('session-title').textContent === 'SEEDED-S'`, 20_000)
    const message = 'MARK-OPEN into the shown session'
    await send(at.browser, message)
    const releasedAt = await openAfterSend(at, 'MARK-OPEN')
    const drawn = await at.browser.waitFor(`${rows('user', message)} >= 1`, 10_000).catch(() => false)
    assert.ok(drawn, `the message is drawn once the stream opens, without a reload\n${(await at.browser.evaluate(`document.getElementById('log').innerText`)).slice(-400)}`)
    assert.equal(at.proxy.readsOf(session, releasedAt), 1, 'by one read of the session, at the stream\u2019s ready')
    at.double.answer()
    assert.ok(await at.browser.waitFor(`${rows('assistant', 'answer to MARK-OPEN')} >= 1 && ${SETTLED}`, 15_000), 'its answer arrives live and the turn ends')
    await sleep(500)
    assert.equal(await at.browser.evaluate(rows('user', message)), 1, 'the message is drawn once')
    assert.equal(await at.browser.evaluate(rows('assistant', 'answer to MARK-OPEN')), 1, 'and so is the answer')
  } finally {
    await at.close()
  }
})

test('a page whose stream is open when it sends reads its session no extra time', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('steady')
  try {
    const session = await at.session('STEADY-S')
    at.proxy.release()
    await at.browser.gotoSession(at.pageUrl, session)
    await at.browser.waitFor(`document.body.dataset.ready === 'true' && ${STREAM_OPEN} && document.getElementById('session-title').textContent === 'STEADY-S'`, 20_000)
    await sleep(500)
    const sentAt = Date.now()
    const message = 'MARK-STEADY on an open stream'
    await send(at.browser, message)
    assert.ok(await until(() => at.double.prompts.some((prompt) => prompt.includes('MARK-STEADY')), 20_000), 'the turn reached the model')
    assert.ok(await at.browser.waitFor(`${rows('user', message)} === 1`, 10_000), 'the message is drawn live')
    await sleep(1500)
    assert.equal(at.proxy.readsOf(session, sentAt), 0, 'and the send read the session no extra time while the turn ran')
    at.double.answer()
    assert.ok(await at.browser.waitFor(`${rows('assistant', 'answer to MARK-STEADY')} === 1 && ${SETTLED}`, 15_000), 'its answer arrives and the turn ends')
  } finally {
    await at.close()
  }
})

test('a person who opens another session before the stream opens stays there, and the session they left is not read', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('left')
  try {
    const left = await at.session('LEFT-S')
    const other = await at.session('OTHER-T')
    await at.browser.gotoSession(at.pageUrl, left)
    await at.browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('session-title').textContent === 'LEFT-S'`, 20_000)
    const message = 'MARK-LEFT then another session'
    await send(at.browser, message)
    assert.ok(await until(() => at.double.prompts.some((prompt) => prompt.includes('MARK-LEFT')), 20_000), 'the turn reached the model')
    const row = (id) => `document.querySelector('#tree li[data-session-id=${JSON.stringify(id)}] > .row')`
    await at.browser.waitFor(`${row(other)} !== null`, 15_000)
    await at.browser.evaluate(`${row(other)}.click()`)
    await at.browser.waitFor(`document.getElementById('session-title').textContent === 'OTHER-T'`, 10_000)
    const releasedAt = await openAfterSend(at, 'MARK-LEFT')
    await sleep(1500)
    assert.equal(await at.browser.evaluate(`document.getElementById('session-title').textContent`), 'OTHER-T', 'the page stays on the session the person opened')
    assert.equal(await at.browser.evaluate(`document.querySelector('#tree li[data-session-id=${JSON.stringify(other)}]')?.getAttribute('aria-selected')`), 'true', 'and its row stays selected')
    assert.equal(at.proxy.readsOf(left, releasedAt), 0, 'the session they left is not read at the ready')
    at.double.answer()
    await at.browser.evaluate(`${row(left)}.click()`)
    assert.ok(await at.browser.waitFor(`${rows('user', message)} === 1 && ${rows('assistant', 'answer to MARK-LEFT')} === 1`, 15_000), 'and going back shows the turn, once')
  } finally {
    await at.close()
  }
})
