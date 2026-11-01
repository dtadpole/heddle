import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, isTitleRequest, removeDir, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * ---
 * title: Sent user secret masking through the delivered Web UI
 * version: 1.0.0
 * description: Synthetic credentials stay masked on screen while provider and Copy receive original text.
 * grounded_in:
 *   - source: issue 84 owner scope and product source 659588
 *   - source: current source 422c7d2a shares the 659588 product source as confirmed by parent
 * ---
 * Author-only source pin, not a runtime result. Parent owns the exact source review and both execution gates.
 * Drives heddleCommand, including HEDDLE_BIN, rather than importing a product renderer. No real credentials,
 * no real clipboard reads and no claim about server logs, stored text or transport redaction. Queue, goal,
 * assistant and automatic messages are deliberately outside this sent-human-bubble contract.
 */

// Literal installed prefixes and numeric minimums are intentional. sk- also needs a digit in its suffix.
const FAKE_SK_SUFFIX_MIN = 20
const FAKE_GHP_SUFFIX_MIN = 36
const fakeSk = 'sk-' + 'FAKEfixtureA1'.repeat(3)
const fakeGhp = 'ghp_' + 'FAKEfixtureB2'.repeat(3)
const prompt = `FAKE values only: ${fakeSk} / ${fakeGhp}`
const mask = (value) => value.slice(0, 8) + '*'.repeat(value.length - 8)
const maskedPrompt = `FAKE values only: ${mask(fakeSk)} / ${mask(fakeGhp)}`
const bubble = 'document.querySelector("#log .turn.user .bubble")'
const toggles = `${bubble}.querySelectorAll('.user-secret-toggle')`
const values = `${bubble}.querySelectorAll('.user-secret-value')`

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 40))
  assert.ok(predicate(), 'the local provider received the expected request within the bound')
}

async function providerDouble() {
  const requests = []
  const errors = []
  let titleRequests = 0
  const server = createServer((request, response) => {
    let body = ''
    const timer = setTimeout(() => { errors.push('provider request body timed out'); request.destroy(); response.destroy() }, 5000)
    const clear = () => clearTimeout(timer)
    request.once('close', clear)
    request.once('error', clear)
    request.on('data', (chunk) => {
      body += chunk.toString()
      if (body.length > 2_000_000) { errors.push('provider request body exceeded bound'); request.destroy(); response.destroy() }
    })
    request.on('end', () => {
      clear()
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-secret-mask-model', object: 'model' }] }))
        return
      }
      if (isTitleRequest(body)) {
        titleRequests += 1
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'named fixture must not request a title' } }))
        return
      }
      if (!path.endsWith('/chat/completions')) {
        errors.push('unexpected provider route')
        response.writeHead(404)
        response.end()
        return
      }
      try { requests.push(JSON.parse(body)) } catch { errors.push('invalid provider JSON'); response.writeHead(400); response.end(); return }
      // No echo: assistant output is not the subject and must not leak the fake values into the preview.
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Synthetic fixture accepted.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  try {
    await bounded(new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) }), 5000, 'provider startup')
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  const address = server.address()
  assert.ok(address && typeof address === 'object' && address.port > 0, 'provider uses an allocated loopback port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, errors,
    titleRequests: () => titleRequests,
    close: () => bounded(new Promise((done) => { server.close(done); server.closeAllConnections() }), 3000, 'provider cleanup'),
  }
}

function startCli(args, env, cwd, onChild) {
  return new Promise((done, reject) => {
    const child = spawn(...heddleCommand(args), { cwd, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    onChild(child) // owned even when startup rejects
    let output = ''
    let settled = false
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { child.kill('SIGKILL'); reject(error) } else done(url)
    }
    const timer = setTimeout(() => finish(new Error('web startup printed no URL within 20s')), 20_000)
    const receive = (chunk) => {
      output = (output + chunk.toString()).slice(-64_000)
      const found = /heddle web: (http:\/\/\S+)/.exec(output)
      if (found) finish(null, found[1])
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(new Error(`web server exited before startup (${code})`)))
  })
}

// One abort bound covers connection, headers AND reading the response body, not fetch alone.
async function jsonRequest(url, path, cookie, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(new URL(path, url), {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    })
    assert.equal(response.status, 200, `${path} succeeds`)
    return await response.json()
  } finally { clearTimeout(timer) }
}

async function cookieFor(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    await response.body?.cancel()
    assert.ok(cookie, 'the private server handshake supplies its cookie')
    return cookie
  } finally { clearTimeout(timer) }
}

async function sendThroughUI(browser, text) {
  await browser.waitFor('document.querySelector("textarea") && !document.querySelector("textarea").disabled && document.getElementById("stop")?.hidden === true', 10_000)
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await browser.waitFor('document.querySelector("#send") && !document.querySelector("#send").disabled', 10_000)
  await browser.evaluate('document.getElementById("send").click()')
}

async function snapshot(browser) {
  return JSON.parse(await browser.evaluate(`JSON.stringify((() => {
    const body = ${bubble}
    return { text: body?.textContent, values: [...(body?.querySelectorAll('.user-secret-value') ?? [])].map(n => n.textContent),
      controls: [...(body?.querySelectorAll('.user-secret-toggle') ?? [])].map(n => ({ type: n.type, label: n.getAttribute('aria-label'), pressed: n.getAttribute('aria-pressed'), icon: !!n.querySelector('svg'), text: n.textContent })),
      // The existing raw Copy snapshot is explicitly allowed, not a new credential attribute.
      attributes: [...document.querySelectorAll('#log .turn.user, #log .turn.user *')].flatMap(n => [...n.attributes].filter(a => !(n.matches('.turn.user') && a.name === 'data-copy-text')).map(a => a.value)) }
  })())`))
}

function assertNoNewRawAttributes(state) {
  for (const attribute of state.attributes) {
    assert.ok(!attribute.includes(fakeSk) && !attribute.includes(fakeGhp), 'no new raw attribute, title or aria value')
  }
}

async function assertMasked(browser, label) {
  await browser.waitFor(`${bubble}?.textContent === ${JSON.stringify(maskedPrompt)}`, 10_000)
  const state = await snapshot(browser)
  assert.equal(state.text, maskedPrompt, label)
  assert.deepEqual(state.values, [mask(fakeSk), mask(fakeGhp)], 'both values contain actual asterisk characters')
  assert.equal(state.controls.length, 2, 'two independent occurrence controls')
  for (const control of state.controls) {
    assert.equal(control.type, 'button')
    assert.equal(control.icon, true, 'each reveal control has an actual SVG icon')
    assert.equal(control.text, '', 'controls are icon-only')
    assert.equal(control.pressed, 'false')
    assert.match(control.label, /^(Show secret|显示密钥)$/)
  }
  assertNoNewRawAttributes(state)
}

async function selectSession(browser, id) {
  const selector = `#tree li[data-session-id="${id}"] > .row`
  await browser.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 10_000)
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await browser.waitFor(`document.querySelector('#tree li[data-session-id="${id}"]')?.getAttribute('aria-selected') === 'true'`, 10_000)
}

test('sent fake credentials mask independently, remount hidden, and preserve exact provider and Copy text', { timeout: 150_000 }, async (context) => {
  // Standard UI=0 yields the runner's labelled unjudged verdict; no environment assertions or CLI launch.
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine and the UI verification target')) return
  assert.ok(fakeSk.slice(3).length >= FAKE_SK_SUFFIX_MIN && /\d/.test(fakeSk.slice(3)))
  assert.ok(fakeGhp.slice(4).length >= FAKE_GHP_SUFFIX_MIN)
  const home = isolatedHome('user-secret-mask')
  const work = fixtureDir('user-secret-mask-work')
  chmodSync(home, 0o700)
  let provider, child, browser
  let browserAbandoned = false
  try {
    provider = await providerDouble()
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'fake-secret-mask', endpoints: [{ name: 'fake-secret-mask', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'fake-secret-mask-model', stream: true, contextWindow: 1_000_000 }],
    })
    const url = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'fake-secret-mask', '--session-root', join(home, 'sessions')], {
      HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config,
    }, work, (owned) => { child = owned })
    const cookie = await cookieFor(url)
    await jsonRequest(url, '/api/workspaces', cookie, { path: work })
    const made = await jsonRequest(url, '/api/sessions', cookie, { branch: work, title: 'FAKE secret mask fixture' })
    const other = await jsonRequest(url, '/api/sessions', cookie, { branch: work, title: 'FAKE remount destination' })
    assert.equal(typeof made.session, 'string')
    assert.equal(typeof other.session, 'string')
    const opening = openBrowser({ width: 1440, height: 1000 }).then(async (opened) => {
      if (browserAbandoned) { await bounded(opened.close(), 5000, 'late browser cleanup'); throw new Error('browser startup abandoned') }
      browser = opened
      return opened
    })
    try { await bounded(opening, 20_000, 'browser startup') } catch (error) { browserAbandoned = true; throw error }
    await browser.gotoSession(url, made.session)
    await browser.waitFor('document.body.dataset.connection === "open" && document.querySelector("textarea") !== null', 20_000)
    await sendThroughUI(browser, prompt)
    await assertMasked(browser, 'the actual sent user bubble defaults to masked')
    await until(() => provider.requests.length === 1)
    const rawUsers = provider.requests[0].messages.filter((message) => message.role === 'user')
    assert.ok(rawUsers.some((message) => message.content === prompt), 'the real provider request receives the exact original prompt')
    assert.equal(provider.titleRequests(), 0, 'the named fixture avoids automatic title calls')
    await browser.waitFor('document.querySelector("#log .turn.assistant")?.dataset.state === "settled"', 15_000)

    await browser.evaluate(`${toggles}[0].click()`)
    let state = await snapshot(browser)
    assert.deepEqual(state.values, [fakeSk, mask(fakeGhp)], 'reveal one never reveals the other')
    assert.equal(state.controls[0].pressed, 'true')
    assert.match(state.controls[0].label, /^(Hide secret|隐藏密钥)$/)
    assertNoNewRawAttributes(state)
    await browser.evaluate(`${toggles}[0].click()`)
    await assertMasked(browser, 'hide restores the first mask')
    await browser.evaluate(`${toggles}[1].click()`)
    state = await snapshot(browser)
    assert.deepEqual(state.values, [mask(fakeSk), fakeGhp], 'the second icon controls only the second value')
    assertNoNewRawAttributes(state)
    await browser.evaluate(`${toggles}[1].click()`)
    await assertMasked(browser, 'both are hidden again')

    // Invoke the real userActions -> copyAction handler, mocking only writeText. Never read OS/global clipboard.
    await browser.evaluate(`(() => {
      window.__fakeSecretCopies = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__fakeSecretCopies.push(text) } } })
      document.querySelector('#log .turn.user button.action[aria-label="Copy"]').click()
    })()`)
    await browser.waitFor('window.__fakeSecretCopies.length === 1', 5000)
    assert.deepEqual(JSON.parse(await browser.evaluate('JSON.stringify(window.__fakeSecretCopies)')), [prompt], 'real Copy writes the full exact raw original, not masked display')

    // A second ordinary human send makes the >=3-row minimap reachable without injecting product DOM.
    await sendThroughUI(browser, 'Ordinary FAKE fixture follow-up.')
    await until(() => provider.requests.length === 2)
    await browser.waitFor('document.querySelectorAll("#log .turn.assistant[data-state=settled]").length === 2', 15_000)
    const hasMinimap = await browser.evaluate('document.getElementById("minimap-hit") !== null')
    if (hasMinimap) await browser.waitFor('document.querySelectorAll("#minimap-rows .mm-row").length === 4', 5000)
    const minimapAccessible = await browser.evaluate(`(() => { const n = document.getElementById('minimap-hit'); const b = n?.getBoundingClientRect(); return !!b && b.width > 0 && b.height > 0 && !document.getElementById('minimap').hidden })()`)
    if (minimapAccessible) {
      await browser.evaluate(`document.getElementById('minimap-hit').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
      await browser.waitFor('document.getElementById("minimap-preview").hidden === false', 5000)
      const preview = await browser.evaluate('document.getElementById("minimap-preview").textContent')
      assert.ok(preview.includes(maskedPrompt), 'accessible first-user minimap preview includes both actual masks')
      assert.ok(!preview.includes(fakeSk) && !preview.includes(fakeGhp), 'accessible minimap preview contains no raw fake value')
      assert.equal(await browser.evaluate('document.querySelectorAll("#minimap-preview .user-secret-toggle").length'), 0, 'preview does not add reveal controls')
    } else context.diagnostic('Minimap preview unavailable at this delivered layout; bubble, Copy and provider remain judged.')

    await browser.evaluate(`window.__fakeOldBubble = ${bubble}; ${toggles}[0].click()`)
    await selectSession(browser, other.session)
    await browser.waitFor('window.__fakeOldBubble.isConnected === false', 10_000)
    await selectSession(browser, made.session)
    await assertMasked(browser, 'a real session-switch remount resets reveal state')
    await browser.evaluate(`${toggles}[1].click()`)
    // A real top-level navigation reloads the page while retaining this profile's stored selection.
    await browser.goto(url)
    await browser.waitFor('document.body.dataset.connection === "open"', 20_000)
    await assertMasked(browser, 'page reload restores history with both values masked')
    assert.equal(provider.requests.length, 2, 'remount and reload make no new model turn or compaction call')
    assert.equal(provider.titleRequests(), 0)
    assert.deepEqual(provider.errors, [])
  } finally {
    browserAbandoned = true
    const cleanup = []
    if (browser) cleanup.push(bounded(browser.close(), 5000, 'browser cleanup'))
    if (child) cleanup.push(endChild(child, { graceMs: 2000 }).then((result) => { assert.notEqual(result, 'stuck', 'CLI cleanup is bounded') }))
    if (provider) cleanup.push(provider.close())
    const results = await Promise.allSettled(cleanup)
    // Resolve and inspect exact owned fixture paths before deleting them; never touch the parent directory.
    for (const path of [home, work]) {
      const absolute = resolve(path)
      assert.equal(absolute, path)
      assert.ok(absolute.includes('/.heddle-tmp/') && /user-secret-mask/.test(absolute), 'cleanup target is this check fixture')
      removeDir(absolute)
    }
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
})
