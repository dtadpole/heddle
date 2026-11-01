import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A completed session's context gauge follows a model switch without another turn (#155).
 *
 * This judges the served product in a real headless browser, not an imported server or a page-source proxy.
 * One private endpoint offers two models with windows of 100000 and 200000 tokens; its one completed turn reports
 * 50000 prompt tokens. A keyboard selection while the context popover stays open must immediately repaint the
 * pill, SVG ring and popover from 50% to 25%. HTTP and completion counts prove that no extra turn supplied it.
 * It is a narrow freshness regression, not a claim of complete DSH parity. The caller supplies the built product
 * (dist/cli.js or HEDDLE_BIN); this check never builds it. HEDDLE_VERIFY_UI=0 uses the normal labelled skip.
 */

const ENDPOINT = 'context-refresh-double'
const MODELS = [
  { id: 'context-small', name: 'Context Small', contextWindow: 100000 },
  { id: 'context-large', name: 'Context Large', contextWindow: 200000 },
]
const STEP_MS = 5000

/** Bound resource shutdown as well as operations; do not leave a race timer alive after settlement. */
async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Same local SSE/model-list pattern as check-model-switcher, with explicit usage and both catalogue rows. */
async function plainDouble() {
  const requests = []
  const turns = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const entry = { method: request.method, url: request.url ?? '', body }
      requests.push(entry)
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      if (request.method === 'GET' && entry.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: MODELS.map((model) => ({ id: model.id, object: 'model', context_window: model.contextWindow })) }))
        return
      }
      if (request.method !== 'POST' || !entry.url.endsWith('/chat/completions')) {
        response.writeHead(404)
        response.end('unexpected double route')
        return
      }
      turns.push(entry)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Context refresh fixture answer.' }, finish_reason: 'stop' }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50000, completion_tokens: 1, total_tokens: 50001 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  const close = async () => {
    server.closeAllConnections()
    await bounded(new Promise((resolve) => server.close(() => resolve())), 2000, 'double cleanup')
  }
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    }), STEP_MS, 'double startup')
  } catch (error) {
    await close()
    throw error
  }
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'the double has a private listener')
  return { requests, turns, baseUrl: `http://127.0.0.1:${address.port}/d`, close }
}

/** Spawn only the selected product command; startup failures still own and clean up their child. */
async function startCli(args, options) {
  const child = spawn(...heddleCommand(args), {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    const url = await bounded(new Promise((resolve, reject) => {
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-64000)
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match !== null) resolve(match[1])
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`server exited ${code ?? signal} before startup\n${output}`)))
    }), 15000, 'product startup')
    return {
      url,
      close: async () => {
        assert.notEqual(await endChild(child, { graceMs: 1000 }), 'stuck', 'the private product process exits during bounded cleanup')
      },
    }
  } catch (error) {
    await endChild(child, { graceMs: 1000 })
    throw new Error(`${error.message}\n${output}`, { cause: error })
  }
}

async function startServer(cleanups) {
  const home = isolatedHome('context-model-refresh')
  const work = fixtureDir('context-model-refresh-work')
  cleanups.push(() => { removeDir(home); removeDir(work) })
  const double = await plainDouble()
  cleanups.push(() => double.close())
  const config = writeJson(join(home, 'heddle.json'), {
    default: ENDPOINT,
    exclude: ['scripted'],
    endpoints: [{ name: ENDPOINT, kind: 'openai-chat', baseUrl: double.baseUrl, model: MODELS[0].id, capabilities: ['chat', 'stream'], models: MODELS }],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', ENDPOINT, '--session-root', join(home, 'sessions')],
    { env: { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config } },
  )
  cleanups.push(() => child.close())
  return { ...child, home, work, double }
}

/** Timeout covers the response body too, including the finite /api/turn SSE response. */
async function request(url, path, cookie, init = {}, json = true) {
  const response = await fetch(new URL(path, url), {
    ...init,
    signal: AbortSignal.timeout(STEP_MS),
    headers: { ...(cookie === undefined ? {} : { cookie }), 'content-type': 'application/json', ...init.headers },
  })
  const body = json ? await response.json() : await response.text()
  assert.equal(response.status, 200, `${path} answered successfully: ${JSON.stringify(body).slice(0, 400)}`)
  return body
}

async function press(browser, key) {
  const code = { Enter: 13, Tab: 9, ArrowDown: 40 }[key]
  assert.ok(code !== undefined, `a key description exists for ${key}`)
  const common = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
  await browser.send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...common, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/** A hit-tested real pointer opens the context popover; no synthetic click bypasses input handling. */
async function clickContext(browser) {
  const point = await browser.evaluate(`(() => {
    const node = document.querySelector('[data-stat-pill="context"]')
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    return { x, y, reaches: node.contains(document.elementFromPoint(x, y)) }
  })()`)
  assert.ok(point.reaches, 'the context pill is visible and hit-testable')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
}

const READ_GAUGE = `(() => {
  const pill = document.querySelector('[data-stat-pill="context"]')
  const ring = document.querySelector('[data-stat="context-ring"]')
  const popover = document.getElementById('stat-popover')
  const dash = (ring?.getAttribute('stroke-dasharray') ?? '').split(/[ ,]+/).map(Number)
  return {
    pillVisible: pill !== null && !pill.hidden && pill.getBoundingClientRect().width > 0,
    percent: document.querySelector('[data-stat="context"]')?.textContent,
    dash,
    popoverVisible: popover !== null && !popover.hidden && popover.getBoundingClientRect().width > 0,
    popoverLabel: popover?.getAttribute('aria-label'),
    headline: popover?.querySelector('.stat-panel-headline')?.textContent,
    figure: popover?.querySelector('.stat-panel-figure')?.textContent,
  }
})()`

function assertGauge(reading, percent, window) {
  assert.equal(reading.pillVisible, true, 'the context pill is visible')
  assert.equal(reading.percent, `${percent}%`, 'the pill uses the selected model window')
  const circumference = 2 * Math.PI * 5.5
  assert.deepEqual(reading.dash, [Number((circumference * percent / 100).toFixed(2)), Number(circumference.toFixed(2))], 'the SVG ring has the same context share as the pill')
  assert.equal(reading.popoverVisible, true, 'the context popover stays open')
  assert.equal(reading.popoverLabel, 'Context usage')
  assert.equal(reading.headline, `${percent}%`, 'the open popover repaints the percentage')
  assert.equal(reading.figure, `~50K / ${window}`, 'the open popover retains the numerator and replaces the denominator')
}

test('switching a completed session model immediately refreshes context pill, open popover and ring without a turn', { timeout: 60000 }, async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser for the context-model-refresh Web UI check')) return
  const cleanups = []
  context.after(async () => {
    const errors = []
    // Close browser, product and double before removing their private home/workspace.
    for (const close of cleanups.reverse()) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'context-refresh cleanup failed')
  })
  const server = await startServer(cleanups)
  const handshake = await fetch(server.url, { redirect: 'manual', signal: AbortSignal.timeout(STEP_MS) })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  await handshake.body?.cancel()
  assert.ok(cookie, 'the product startup URL mints an authentication cookie')
  await request(server.url, '/api/workspaces', cookie, { method: 'POST', body: JSON.stringify({ path: server.work }) })
  // Current API: POST /api/sessions returns a session id string, not a file/tree node.
  const created = await request(server.url, '/api/sessions', cookie, { method: 'POST', body: JSON.stringify({ branch: server.work, title: 'Context model refresh fixture' }) })
  const session = created.session
  assert.match(session, /^session-[0-9a-f-]{36}$/i)
  await request(server.url, '/api/turn', cookie, { method: 'POST', body: JSON.stringify({ session, folder: server.work, prompt: 'Answer once for the context refresh fixture.' }) }, false)
  const before = await request(server.url, `/api/sessions/${session}`, cookie)
  assert.equal(before.stats?.lastPromptTokens, 50000, 'the product persisted the reported prompt usage')
  assert.equal(before.stats?.turns, 1, 'exactly one completed turn supplies the baseline')
  assert.equal(server.double.turns.length, 1, JSON.stringify(server.double.turns.map((entry) => ({ url: entry.url, body: entry.body }))))
  assert.equal(JSON.parse(server.double.turns[0].body).model, MODELS[0].id)

  // Late browser startup also gets cleanup if the bound expires before openBrowser resolves.
  let closing = false
  const opening = openBrowser({ width: 1280, height: 1000 }).then(async (browser) => {
    if (closing) { await browser.close(); throw new Error('browser started after its deadline') }
    cleanups.push(() => bounded(browser.close(), 4000, 'browser cleanup'))
    return browser
  })
  const browser = await bounded(opening, 10000, 'browser startup').catch((error) => { closing = true; throw error })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__refreshRequests = []
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      window.__refreshRequests.push({ path: new URL(typeof input === 'string' ? input : input.url, location.href).pathname, method: init?.method ?? 'GET' })
      return originalFetch(input, init)
    }
  ` })
  // gotoSession restores the saved id before loading the product; showFile(node) is not a session opener.
  await browser.gotoSession(server.url, session, STEP_MS)
  await browser.waitFor(`document.getElementById('model-trigger')?.title === 'Context Small' && document.querySelector('[data-stat="context"]')?.textContent === '50%'`, STEP_MS)
  await clickContext(browser)
  await browser.waitFor(`document.getElementById('stat-popover')?.hidden === false`, STEP_MS)
  assertGauge(await browser.evaluate(READ_GAUGE), 50, '100K')
  const baselineRequests = server.double.requests.length

  // Real keyboard selection avoids outside pointerdown dismissing the already-open context popover.
  await browser.evaluate(`document.getElementById('model-trigger').focus()`)
  await press(browser, 'Enter')
  await browser.waitFor(`document.getElementById('model-menu')?.hidden === false`, STEP_MS)
  await press(browser, 'Tab')
  await press(browser, 'Enter')
  await browser.waitFor(`document.querySelectorAll('#model-menu [role="menuitemradio"]').length === 2`, STEP_MS)
  await press(browser, 'ArrowDown')
  assert.equal(await browser.evaluate(`document.activeElement?.textContent.trim()`), 'Context Large', 'keyboard selection reaches the second model')
  await press(browser, 'Enter')
  await browser.waitFor(`document.getElementById('model-trigger')?.title === 'Context Large' && document.getElementById('model-menu')?.hidden === true`, STEP_MS)
  // No reload, turn, context API read or manual renderer call between selection and these readings.
  assertGauge(await browser.evaluate(READ_GAUGE), 25, '200K')

  const browserRequests = await browser.evaluate('window.__refreshRequests')
  assert.equal(browserRequests.filter((entry) => entry.path === '/api/turn').length, 0, 'the browser sent no extra turn')
  assert.equal(browserRequests.filter((entry) => entry.path === `/api/sessions/${session}/model` && entry.method === 'POST').length, 1, 'the browser committed exactly one model selection')
  const after = await request(server.url, `/api/sessions/${session}`, cookie)
  assert.equal(after.model, MODELS[1].id, 'the selected model is durably recorded')
  assert.equal(after.stats?.lastPromptTokens, 50000)
  assert.equal(after.stats?.turns, 1, 'the switch did not create another turn')
  assert.equal(server.double.turns.length, 1, 'the double saw no extra completion')
  assert.deepEqual(after.turns, before.turns, 'the transcript was unchanged by the switch')
  const extra = server.double.requests.slice(baselineRequests)
  assert.ok(extra.every((entry) => entry.method === 'GET' && entry.url.endsWith('/models')), 'any subsequent provider requests are catalogue discovery only')
  context.diagnostic(`provider requests ${baselineRequests} -> ${server.double.requests.length}; completions 1 -> 1; context 50% -> 25% without another turn`)
})
