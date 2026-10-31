import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { releaseChromeOutput } from '../../_tools_/browser-use/chrome.mjs'
import { openBrowser as openToolBrowser } from '../../_tools_/browser-use/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'
import { trackScratch, untrackScratch } from '../../_tools_/verify-runner/scratch.mjs'

/**
 * Verifier — running turns and open tabs do not use up the browser's connections to the server (#128).
 *
 * **The claim it decides:** with five turns running from one tab the page still answers its other requests and sends a
 * sixth, and the eighth tab of one server loads and follows the stream like the first; when the tab that holds the
 * stream closes, the others keep following, and a turn sent from one of them still ends there.
 *
 * Measured before (issue #128, developer-six, both builds at bbc1042a, headless Chrome): a browser allows six
 * connections per host, shared by all its tabs, and the page held one per tab (`EventSource('/api/events')`) and one per
 * running turn (`runTurn` read the `POST /api/turn` answer to its end). After the fifth turn a `GET /api/settings`
 * timed out at 5 s, and the sixth tab stayed "No session" with an empty tree, as did every request of the other five.
 *
 * **How:** a chat double holds every HOLD prompt's answer open, streaming, until the check releases it. Test one sends
 * five HOLD messages from the page's own composer, each in a new session, racing a request from that page against 2 s
 * after each. Test two opens eight tabs of one server in one browser, renames the session they show, sends a turn from
 * a tab that does not hold the stream, and closes the one that does while it runs.
 */

const CAPABILITY = 'a Web UI whose page follows the event stream'
const isTitleRequest = (body) => typeof body === 'string' && body.includes('Create a concise title for an AI coding-assistant session')

/** A chat double: a HOLD prompt streams a word every 250 ms until `release()`; any other prompt is answered at once. */
async function holdingDouble() {
  const prompts = []
  let release = () => {}
  const released = new Promise((resolvePromise) => (release = resolvePromise))
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      if (isTitleRequest(body)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'this double answers turns, not session titles' } }))
        return
      }
      /** The prompt is the newest user message carrying a marker: the harness appends user messages of its own. */
      const texts = (JSON.parse(body || '{}').messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')))
      const prompt = [...texts].reverse().find((text) => /HOLD|SHORT|NEXT/.test(text)) ?? ''
      prompts.push(prompt)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      frame({ role: 'assistant', content: '' })
      if (prompt.includes('HOLD')) {
        let open = true
        void released.then(() => (open = false))
        for (let word = 0; open && word < 400 && !response.destroyed; word += 1) {
          frame({ content: 'w ' })
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
        }
        frame({ content: `held for: ${prompt}` })
      } else {
        frame({ content: `answer to: ${prompt}` })
      }
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    prompts,
    holds: () => prompts.filter((prompt) => prompt.includes('HOLD')).length,
    release: () => release(),
    close: () =>
      new Promise((resolvePromise) => {
        release()
        server.closeAllConnections?.()
        server.close(() => resolvePromise())
      }),
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, env) {
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

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate()) && Date.now() < deadline) await sleep(100)
  return predicate()
}

/** The double, the server on a scratch home, and a workspace for New session; closed in reverse on any failure. */
async function world(label) {
  const opened = []
  const close = async () => {
    for (const step of opened.reverse()) await Promise.resolve(step()).catch(() => {})
  }
  try {
    const home = isolatedHome(`connection-pool-${label}`)
    opened.push(() => removeDir(home))
    const double = await holdingDouble()
    opened.push(() => double.close())
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'double',
      endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'model-one', capabilities: ['chat', 'stream'] }],
    })
    const work = join(home, 'work')
    mkdirSync(work, { recursive: true })
    const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')], {
      HEDDLE_CONFIG: config,
      HEDDLE_HOME: home,
      HOME: home,
    })
    opened.push(() => server.kill())
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const api = (path, init = {}) =>
      fetch(new URL(path, server.url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    const registered = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(registered.status, 200, 'the scratch folder is a workspace')
    return { double, server, api, work, opened, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Race one request from the page against `ms`: its status, or `timeout` when the browser never sent it. */
const raced = (ms) => `Promise.race([
  fetch('/api/settings').then((response) => response.status, () => 'failed'),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ${ms})),
])`

const type = (text) => `(() => {
  const field = document.querySelector('#prompt textarea')
  field.value = ${JSON.stringify(text)}
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  return true
})()`

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('five turns running from one tab leave its other requests answering, a sixth is sent, and each ends on the page', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('turns')
  const browser = await openBrowser({ width: 1280, height: 900 })
  at.opened.push(() => browser.close())
  try {
    await browser.goto(at.server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is ready')
    const statuses = []
    /** A turn in a new session of its own, sent from the composer the way a person sends it. */
    const sendInNewSession = async (turn) => {
      const before = (await (await at.api('/api/sessions')).json()).length
      await browser.evaluate(`document.getElementById('new-session').click()`)
      assert.ok(await until(async () => (await (await at.api('/api/sessions')).json()).length === before + 1, 15_000), `New session ${turn} made a session`)
      assert.ok(
        await browser.waitFor(`document.getElementById('stop').hidden === true && document.querySelector('#prompt textarea') !== null`, 15_000),
        `session ${turn} is shown with Send, not the running turn before it`,
      )
      await browser.evaluate(type(`HOLD turn ${turn}`))
      assert.ok(await until(() => at.double.holds() === turn, 15_000), `turn ${turn} reached the model (${at.double.holds()} running)`)
    }
    for (let turn = 1; turn <= 5; turn += 1) {
      await sendInNewSession(turn)
      statuses.push(await browser.evaluate(raced(2000), 10_000))
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200], 'with each more turn running, a request from the page is still answered within 2 s')
    await sendInNewSession(6)
    at.double.release()
    assert.ok(
      await browser.waitFor(`document.getElementById('log').innerText.includes('held for: HOLD turn 6') && document.getElementById('stop').hidden === true`, 30_000),
      'the shown turn ends on the page: its answer is whole and Send is back',
    )
    const sentBefore = at.double.prompts.length
    await browser.evaluate(type('NEXT after the held turns'))
    assert.ok(await until(() => at.double.prompts.length > sentBefore, 15_000), 'and the next message is sent, not left queued')
    assert.ok(await browser.waitFor(`document.getElementById('log').innerText.includes('answer to: NEXT after the held turns')`, 15_000), 'and answered')
  } finally {
    await at.close()
  }
})

/** One browser, many tabs, over the browser tool; closed the way the one-page wrapper closes. */
async function openTabs() {
  const profile = trackScratch(mkdtempSync(join(tmpdir(), 'heddle-check-browser-')))
  let browser
  try {
    browser = await openToolBrowser({ headless: true, width: 1280, height: 900, profile })
  } catch (error) {
    rmSync(profile, { recursive: true, force: true })
    throw error
  }
  trackScratch(profile, browser.running?.child)
  let first = true
  return {
    /** A new tab at `url`; the first call uses the tab the browser opened with. */
    async open(url) {
      const page = first ? browser.page() : await browser.newPage({ background: false })
      first = false
      try {
        await page.navigate({ url, timeoutMs: 10_000 })
      } catch {
        // a tab whose document never arrived is judged by the readiness wait below
      }
      return page
    },
    closePage: (page) => browser.closePage(page.pageId),
    async close() {
      try {
        browser.running?.child?.kill('SIGKILL')
      } catch {
        // already gone
      }
      releaseChromeOutput(browser.running?.child)
      browser.connection?.close()
      await browser.close()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true })
          untrackScratch(profile)
          return
        } catch {
          await sleep(100)
        }
      }
    },
  }
}

async function truthy(page, expression, timeoutMs) {
  try {
    return await page.waitForExpression(expression, timeoutMs)
  } catch {
    return false
  }
}

test('eight tabs of one server all load and follow the stream, and a turn sent from one ends there after the tab holding the stream closes', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const at = await world('tabs')
  const tabs = await openTabs()
  at.opened.push(() => tabs.close())
  const LOG = `document.getElementById('log').innerText`
  try {
    /** One session, so every tab opens on it and draws what the stream says about it. */
    const first = await at.api('/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'SHORT first', folder: at.work }) })
    assert.equal(first.status, 200)
    await first.text()
    const session = (await (await at.api('/api/sessions')).json())[0]?.id
    assert.ok(typeof session === 'string', 'the first turn made a session')
    const pages = []
    const readiness = []
    for (let index = 1; index <= 8; index += 1) {
      const page = await tabs.open(at.server.url)
      pages.push(page)
      readiness.push(await truthy(page, `document.body.dataset.ready === 'true' && ${LOG}.includes('answer to: SHORT first')`, 10_000))
    }
    assert.deepEqual(readiness, [true, true, true, true, true, true, true, true], 'every tab finished loading and shows the session')
    const answered = await pages[1].evaluate(raced(2000), { timeoutMs: 10_000 })
    assert.equal(answered, 200, 'a loaded tab still answers with eight open')
    const feeds = await Promise.all(pages.map((page) => page.evaluate(`document.body.dataset.feed ?? 'none'`, { timeoutMs: 5_000 })))
    assert.equal(feeds.filter((feed) => feed === 'leader').length, 1, `one tab holds the stream for all of them: ${feeds.join(', ')}`)

    /** A rename is pushed on the stream, and every tab's header follows it. */
    const renamed = await at.api(`/api/sessions/${session}/title`, { method: 'POST', body: JSON.stringify({ title: 'Renamed with eight tabs' }) })
    assert.equal(renamed.status, 200)
    for (const [index, page] of pages.entries()) {
      assert.ok(
        await truthy(page, `document.getElementById('session-title')?.textContent === 'Renamed with eight tabs'`, 15_000),
        `tab ${index + 1} follows the rename`,
      )
    }

    /** A follower sends a turn, and the tab holding the stream closes while it runs. */
    const leader = pages[feeds.indexOf('leader')]
    const sender = pages.find((page) => page !== leader)
    await sender.evaluate(type('HOLD from a follower'), { timeoutMs: 5_000 })
    assert.ok(await until(() => at.double.holds() === 1, 15_000), 'the follower\'s turn reached the model')
    await tabs.closePage(leader)
    const rest = pages.filter((page) => page !== leader)
    assert.ok(
      await until(async () => (await Promise.all(rest.map((page) => page.evaluate(`document.body.dataset.feed`, { timeoutMs: 5_000 })))).includes('leader'), 15_000),
      'another tab took the stream over',
    )
    at.double.release()
    for (const [index, page] of rest.entries()) {
      assert.ok(await truthy(page, `${LOG}.includes('held for: HOLD from a follower')`, 20_000), `remaining tab ${index + 1} drew the whole answer`)
    }
    assert.ok(await truthy(sender, `document.getElementById('stop').hidden === true`, 15_000), 'the turn ended in the tab that sent it')
    const sentBefore = at.double.prompts.length
    await sender.evaluate(type('NEXT from the follower'), { timeoutMs: 5_000 })
    assert.ok(await until(() => at.double.prompts.length > sentBefore, 15_000), 'and its next message is sent, not queued behind a turn it still thinks is running')
    for (const [index, page] of rest.entries()) {
      assert.ok(await truthy(page, `${LOG}.includes('answer to: NEXT from the follower')`, 15_000), `remaining tab ${index + 1} still follows the stream`)
    }
  } finally {
    await at.close()
  }
})
