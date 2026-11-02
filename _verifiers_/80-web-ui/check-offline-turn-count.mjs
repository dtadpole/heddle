import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, isTitleRequest, readTranscript, refuseTitleRequest, repoRoot, removeDir, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * ---
 * title: Offline submission is not a counted turn
 * description: A real browser offline send leaves one persisted turn while an accepted provider failure counts as two.
 * status: unverified
 * grounded_in:
 *   - source: issue 116 offline turn counter and issue 128 stream-open submission gate
 * ---
 *
 * Author-only contract, not runtime evidence. Judge the actual built CLI selected by HEDDLE_BIN (dist otherwise),
 * with a private home, workspace and provider double. The parent must build both artifacts and run this unchanged
 * against each. No private/live server, endpoint, prompt or store is touched.
 *
 * CDP Network offline is the browser's DevTools Network offline setting, not a mocked fetch or EventSource.
 * #128 may reject a send while waiting for the stream to open, before any POST; that is a valid failed submission.
 * A provider HTTP 400 AFTER acceptance is different: its persisted user message is a legitimate counted turn,
 * even though no assistant answer succeeds. Neither backend gets a waiver or a different turn definition.
 *
 * One test has a 90 s bound, its entire startup/browser/body has a 75 s bound, and cleanup is separately bounded.
 * HEDDLE_VERIFY_UI=0 uses the shared labelled skip, without asserting anything about that environment variable.
 */

const FIRST = 'fixture-116 accepted initial user message'
const OFFLINE = 'fixture-116 offline unsent draft'
const REFUSED = 'fixture-116 accepted provider refusal'
const ANSWER = 'fixture-116 initial answer'
const REFUSAL = 'fixture-116 provider deliberately refused the accepted request'
const COUNTER = `document.querySelector('#composer-status [data-stat="turns"]')`
const USERS = `Array.from(document.querySelectorAll('#log .turn[data-kind="user"]')).map((row) => row.querySelector('.bubble')?.textContent ?? row.dataset.copyText)`
const FIELD = `document.querySelector('#prompt textarea')`

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

const messageText = (message) => typeof message?.content === 'string'
  ? message.content
  : (message?.content ?? []).map((part) => part.text ?? '').join('')
const userFacts = (events) => events.filter((event) => event.type === 'message' && event.message?.role === 'user')

/** Record the actual raw wire requests, not just a double's prompt classifier. Title requests never count as turns. */
function providerDouble() {
  const rawRequests = []
  const turnRequests = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      rawRequests.push(body)
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      turnRequests.push(body)
      let parsed
      try { parsed = JSON.parse(body) } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid fixture request' } }))
        return
      }
      if ((parsed.messages ?? []).some((message) => message.role === 'user' && messageText(message) === REFUSED)) {
        // Non-retryable provider failure, not a mocked /api/turn rejection and not an acceptance simulation.
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: REFUSAL, type: 'invalid_request_error', code: 'invalid_request' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`)
      frame({ role: 'assistant', content: ANSWER })
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  return { server, rawRequests, turnRequests }
}

/** A real mouse press on Send, after typing through the browser input protocol. */
async function sendDraft(browser, text) {
  await browser.evaluate(`${FIELD}.focus()`)
  await browser.send('Input.insertText', { text })
  const point = await browser.evaluate(`(() => {
    const button = document.getElementById('send')
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled: button.disabled }
  })()`)
  assert.equal(point.disabled, false, 'Send is an enabled real control')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
}

function launch(child, output) {
  return new Promise((resolve, reject) => {
    let text = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`the CLI printed no URL within 20 s\n${text}`)), 20_000)
    function finish(error, url) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(url)
    }
    const receive = (chunk) => {
      text += chunk.toString()
      output.text = text
      const match = /heddle web: (http:\/\/\S+)/.exec(text)
      if (match) finish(null, match[1])
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.on('error', (error) => finish(error))
    child.on('exit', (code, signal) => finish(new Error(`the CLI exited before readiness (${code ?? signal})\n${text}`)))
  })
}

test('offline Send leaves count one and no accepted user fact; a real accepted provider failure counts as two', { timeout: 90_000 }, async (t) => {
  if (!skipUnless(t, browserAvailable(), 'a browser on this machine and the UI verification target')) return
  const home = isolatedHome('offline-turn-count')
  const work = fixtureDir('offline-turn-count-work')
  const sessionRoot = join(home, 'sessions')
  const double = providerDouble()
  let child
  let browser
  let closing = false
  const output = { text: '' }
  // Also close resources if node:test aborts the test rather than waiting for its normal finally.
  const emergency = () => {
    child?.kill('SIGKILL')
    if (browser) void browser.close().catch(() => {})
    double.server.closeAllConnections?.()
    double.server.close()
  }
  t.signal.addEventListener('abort', emergency, { once: true })
  try {
    await bounded((async () => {
      await new Promise((resolve, reject) => {
        double.server.once('error', reject)
        double.server.listen(0, '127.0.0.1', resolve)
      })
      const config = writeJson(join(home, 'heddle.json'), {
        default: 'offline-count-double',
        endpoints: [{ name: 'offline-count-double', kind: 'openai-chat', baseUrl: `http://127.0.0.1:${double.server.address().port}/v1`, model: 'fixture-model', contextWindow: 1_000_000, capabilities: ['chat', 'stream'] }],
      })
      // Do not inherit the operator's endpoint/home overrides; only the requested binary selects the artifact.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HEDDLE_')))
      Object.assign(env, { NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config })
      child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'offline-count-double', '--session-root', sessionRoot]), {
        cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const url = await launch(child, output)
      const api = async (path, options = {}) => {
        const target = new URL(path, url)
        target.searchParams.set('token', new URL(url).searchParams.get('token') ?? '')
        const response = await fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }, signal: AbortSignal.timeout(8000) })
        return { status: response.status, text: await response.text() }
      }
      // Seed exactly one accepted turn through the actual server, naming its private workspace.
      const initial = await api('/api/turn', { method: 'POST', body: JSON.stringify({ prompt: FIRST, folder: work, new: true }) })
      assert.equal(initial.status, 200, `initial turn succeeds: ${initial.text.slice(0, 300)}`)
      const listed = await api('/api/sessions')
      assert.equal(listed.status, 200)
      const sessions = JSON.parse(listed.text)
      assert.equal(sessions.length, 1, 'one private session, opened by its explicit id')
      const session = sessions[0].id
      const events = () => readTranscript(join(sessionRoot, session))
      const stats = async () => {
        const response = await api(`/api/sessions/${session}`)
        assert.equal(response.status, 200, 'the real server supplies the stats/transcript')
        return JSON.parse(response.text)
      }
      assert.equal(userFacts(events()).length, 1, 'one initial persisted user fact')
      assert.equal((await stats()).stats.turns, 1, 'initial server count is one')
      assert.equal(double.turnRequests.length, 1, 'one initial conversation provider request')

      browser = await bounded(openBrowser({ width: 1280, height: 900 }).then((opened) => {
        if (closing) { void opened.close().catch(() => {}); throw new Error('browser opened after scenario deadline') }
        return opened
      }), 20_000, 'browser startup')
      await browser.gotoSession(url, session)
      await browser.waitFor(`document.body.dataset.ready === 'true' && document.body.dataset.connection === 'open' && ${COUNTER}?.textContent === '1 turns' && document.getElementById('log').innerText.includes(${JSON.stringify(ANSWER)})`, 15_000)
      assert.deepEqual(await browser.evaluate(USERS), [FIRST], 'the named session starts with one user row')
      const requestCount = events().filter((event) => event.type === 'model/request').length
      // Capture every counter paint while Send is pending, not just its eventual rollback.
      await browser.evaluate(`(() => {
        window.__offlineCountPaints = [${COUNTER}.textContent]
        window.__offlineCountObserver = new MutationObserver(() => window.__offlineCountPaints.push(${COUNTER}.textContent))
        window.__offlineCountObserver.observe(${COUNTER}, { subtree: true, childList: true, characterData: true })
      })()`)
      await browser.send('Network.enable', {})
      await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
      assert.equal(await browser.evaluate('navigator.onLine'), false, 'DevTools Network really put the browser offline')
      await sendDraft(browser, OFFLINE)
      await browser.waitFor(`document.getElementById('log').innerText.includes('the message could not be sent') && ${FIELD}.value === ${JSON.stringify(OFFLINE)} && document.getElementById('stop').hidden`, 15_000)
      const paints = await browser.evaluate(`window.__offlineCountObserver.disconnect(); window.__offlineCountPaints`)
      assert.ok(paints.length > 0 && paints.every((value) => value === '1 turns'), `counter never increments for an unaccepted offline send: ${JSON.stringify(paints)}`)
      assert.equal(await browser.evaluate(`${COUNTER}.textContent`), '1 turns')
      assert.deepEqual(await browser.evaluate(USERS), [FIRST], 'offline draft made no matching user row')
      assert.ok(!double.rawRequests.some((body) => body.includes(OFFLINE)), 'no raw provider request contains the offline draft')
      assert.equal(double.turnRequests.length, 1, 'offline Send caused no conversation provider request')
      const offlineEvents = events()
      assert.deepEqual(userFacts(offlineEvents).map((event) => messageText(event.message)), [FIRST], 'no accepted offline user fact in the persisted log')
      assert.equal(offlineEvents.filter((event) => event.type === 'model/request').length, requestCount, 'no accepted model request was recorded')
      assert.equal((await stats()).stats.turns, 1, 'browser offline did not change the server count')

      await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await browser.waitFor(`navigator.onLine && document.body.dataset.connection === 'open' && ${FIELD}.value === ${JSON.stringify(OFFLINE)} && ${COUNTER}.textContent === '1 turns'`, 12_000)
      assert.deepEqual(await browser.evaluate(USERS), [FIRST], 'reconnect did not auto-submit the restored draft')
      assert.equal((await stats()).stats.turns, 1, 'reconnected count is still one')

      // Replace, rather than resend, the recovered unsent draft. This second message really reaches the provider.
      await browser.evaluate(`${FIELD}.value = ''; ${FIELD}.dispatchEvent(new Event('input', { bubbles: true }))`)
      await sendDraft(browser, REFUSED)
      await browser.waitFor(`document.getElementById('log').innerText.includes(${JSON.stringify(REFUSAL)}) && document.getElementById('stop').hidden && ${COUNTER}.textContent === '2 turns'`, 15_000)
      const persisted = events()
      assert.deepEqual(userFacts(persisted).map((event) => messageText(event.message)), [FIRST, REFUSED], 'provider failure persisted a real second user fact, never the offline draft')
      assert.ok(persisted.some((event) => event.type === 'turn/failed'), 'actual provider refusal is a persisted failed turn')
      assert.ok(double.rawRequests.some((body) => body.includes(REFUSED)), 'the refusal was a real raw provider request')
      assert.ok(!double.rawRequests.some((body) => body.includes(OFFLINE)), 'the unsent draft never reached the provider, even after reconnect')
      assert.equal(double.turnRequests.length, 2, 'one successful and one non-retried provider-refused conversation request')
      assert.equal((await stats()).stats.turns, 2, 'server stats count the legitimate failed accepted turn')
      assert.deepEqual(await browser.evaluate(USERS), [FIRST, REFUSED], 'the page counts the same two user facts')
      assert.equal(await browser.evaluate(`${FIELD}.value`), '', 'an accepted provider failure does not restore an already-delivered draft')
    })(), 75_000, 'offline turn-count startup/browser/body')
  } finally {
    closing = true
    t.signal.removeEventListener('abort', emergency)
    const cleanupErrors = []
    if (browser) await bounded(browser.close(), 5000, 'browser cleanup').catch((error) => cleanupErrors.push(error))
    if (child) await bounded(endChild(child, { graceMs: 1000 }), 3000, 'CLI cleanup').then((result) => {
      if (result === 'stuck') cleanupErrors.push(new Error('CLI did not exit after SIGKILL'))
    }).catch((error) => { child.kill('SIGKILL'); cleanupErrors.push(error) })
    double.server.closeAllConnections?.()
    await bounded(new Promise((resolve) => double.server.close(resolve)), 2000, 'provider cleanup').catch((error) => cleanupErrors.push(error))
    removeDir(home)
    removeDir(work)
    assert.equal(cleanupErrors.length, 0, `bounded cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}\n${output.text.slice(-1000)}`)
  }
})
