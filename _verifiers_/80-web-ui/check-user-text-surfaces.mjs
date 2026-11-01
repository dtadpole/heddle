import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, isTitleRequest, removeDir, repoRoot, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * ---
 * title: Queued and goal-command user text through the delivered Web UI
 * version: 1.0.0
 * description: Queue previews and goal input surfaces mask synthetic credentials without changing raw data.
 * grounded_in:
 *   - source: issue 84 part 2 owner scope and product source 60c67da5
 * ---
 * AUTHOR-ONLY source pin, not runtime proof. Source/menu-owner review and execution of the actual
 * TypeScript and HEDDLE_BIN builds belong to the parent. Headless; no product imports or DOM fixture
 * injection. Existing part 1 verifies sent user bubbles, reveal/remount and Copy; do not repeat it here.
 *
 * This contract covers only #queue .preview text/title, /goal Command input and .hc-args. The queue's
 * .preview is the actual queue-preview surface (not a class named .queue-preview). It has no reveal
 * controls; its separate existing Edit action deliberately opens RAW editable text. /goal .hc-text
 * result and the goal bar are INTENTIONALLY OUT OF SCOPE and can contain the raw objective. This is
 * NOT whole-screen privacy and NOT backend/log/transport redaction. All keys are deterministic FAKEs.
 *
 * A private final profile patch removes goal-driver before /goal can arm a goal. No automatic model
 * rounds are planned. The offline provider also refuses every model call beyond the two explicit queue
 * turns; named sessions reject title calls. No live Settings/auth files or host/private keys are read.
 */

const FAKE_SK_SUFFIX_MIN = 20
const FAKE_GHP_SUFFIX_MIN = 36
const fakeSk = 'sk-' + 'FAKEqueueA1'.repeat(4)
const fakeGhp = 'ghp_' + 'FAKEgoalB2'.repeat(4)
const mask = (value) => value.slice(0, 8) + '*'.repeat(value.length - 8)
// Start sk- at index 185 so visible suffix characters cross the 200-character preview boundary.
// Mask BEFORE truncating: scanning the truncated preview would miss this incomplete credential.
const queuePrefix = 'FAKE queue boundary ' + 'x'.repeat(164) + ' '
const queueText = `${queuePrefix}${fakeSk} / ${fakeGhp} FAKE tail`
const maskedQueue = `${queuePrefix}${mask(fakeSk)} / ${mask(fakeGhp)} FAKE tail`
const savedQueueText = `${queueText} saved FAKE data`
const savedMaskedQueue = `${maskedQueue} saved FAKE data`
const objective = `FAKE goal objective ${fakeSk} / ${fakeGhp}`
const maskedObjective = `FAKE goal objective ${mask(fakeSk)} / ${mask(fakeGhp)}`
const holdPrompt = 'Ordinary FAKE hold-turn fixture.'
const FIELD = 'document.querySelector("#prompt textarea")'
const PREVIEW = 'document.querySelector("#queue .row .preview")'
const EDITOR = 'document.querySelector("#queue .editor")'
const COMMAND_INPUT = `document.querySelector('#log [data-command-input][role="group"][aria-label="Command input"]')`
const GOAL_ARGS = 'document.querySelector("#log .hc-command .hc-args")'

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
  assert.ok(predicate(), 'the local provider receives its expected request within the bound')
}

function previewOf(text) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : chars.join('')
}

async function providerDouble() {
  const requests = []
  const errors = []
  let titleRequests = 0
  let releaseHeld
  const server = createServer((request, response) => {
    let body = ''
    const timer = setTimeout(() => { errors.push('provider body timed out'); request.destroy(); response.destroy() }, 5000)
    const clear = () => clearTimeout(timer)
    request.once('close', clear)
    request.once('error', clear)
    request.on('data', (chunk) => {
      body += chunk.toString()
      if (body.length > 2_000_000) { errors.push('provider body exceeded bound'); clear(); request.destroy(); response.destroy() }
    })
    request.on('end', () => {
      clear()
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-user-text-model', object: 'model' }] }))
        return
      }
      if (isTitleRequest(body)) {
        titleRequests += 1
        errors.push('named fixture unexpectedly requested a title')
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'FAKE fixture refuses title calls' } }))
        return
      }
      if (!path.endsWith('/chat/completions')) {
        errors.push('unexpected provider route')
        response.writeHead(404)
        response.end()
        return
      }
      if (requests.length >= 2) {
        errors.push('model call exceeded the two explicit queue turns; automatic goal calls are forbidden')
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'FAKE fixture model-call cap exceeded' } }))
        return
      }
      try { requests.push(JSON.parse(body)) } catch { errors.push('invalid provider JSON'); response.writeHead(400); response.end(); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Ordinary output only: never echo credentials into assistant/result surfaces.
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Ordinary FAKE provider response.' }, finish_reason: null }] })}\n\n`)
      const finish = () => {
        if (response.destroyed || response.writableEnded) return
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`)
      }
      if (requests.length !== 1) { finish(); return }
      // Hold the ACTUAL first CLI/provider turn while a human queues, cancels and saves. This has an
      // independent ceiling even if the browser fails before it can release the response.
      const holdTimer = setTimeout(() => { errors.push('hold turn reached its 70s ceiling'); finish() }, 70_000)
      response.once('close', () => clearTimeout(holdTimer))
      releaseHeld = () => { clearTimeout(holdTimer); finish() }
    })
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  try {
    await bounded(new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) }), 5000, 'provider startup')
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  const address = server.address()
  assert.ok(address && typeof address === 'object' && address.port > 0)
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, errors,
    titleRequests: () => titleRequests,
    release: () => { assert.equal(typeof releaseHeld, 'function', 'the first provider response is held'); releaseHeld() },
    close: () => bounded(new Promise((done) => { server.close(done); server.closeAllConnections() }), 3000, 'provider cleanup'),
  }
}

function startCli(args, env, cwd, onChild) {
  return new Promise((done, reject) => {
    // Do not inherit provider credentials, proxy variables, HEDDLE overrides or machine profile paths.
    // heddleCommand still honours the parent's actual HEDDLE_BIN before spawning with this private env.
    const child = spawn(...heddleCommand(args), { cwd, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    onChild(child)
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

// A single abort bound includes headers AND JSON body consumption.
async function api(url, cookie, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
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

async function typeAndEnter(browser, text) {
  await browser.waitFor(`${FIELD} && !${FIELD}.disabled`, 10_000)
  await browser.evaluate(`(() => { const field = ${FIELD}; field.focus(); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await browser.send('Input.insertText', { text })
  assert.equal(await browser.evaluate(`${FIELD}.value`), text, 'the actual composer holds the exact FAKE input')
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await browser.waitFor(`${FIELD}.value === ''`, 10_000)
}

async function assertQueueMasked(browser, expectedFull) {
  const expectedPreview = previewOf(expectedFull)
  await browser.waitFor(`${PREVIEW}?.textContent === ${JSON.stringify(expectedPreview)}`, 10_000)
  const state = JSON.parse(await browser.evaluate(`JSON.stringify((() => {
    const preview = ${PREVIEW}
    const queue = document.getElementById('queue')
    return { text: preview?.textContent, title: preview?.title, tag: preview?.tagName,
      role: preview?.getAttribute('role'), tabIndex: preview?.getAttribute('tabindex'),
      previewActions: preview?.querySelectorAll('button, a, [role="button"], input, textarea').length,
      toggles: queue.querySelectorAll('.user-secret-toggle').length,
      secretControls: [...queue.querySelectorAll('button')].filter(n => /show secret|hide secret|显示密钥|隐藏密钥/i.test(n.getAttribute('aria-label') + ' ' + n.title)).length,
      attributes: [...queue.querySelectorAll('*')].flatMap(n => [...n.attributes].map(a => a.value)) }
  })())`))
  assert.equal(state.text, expectedPreview, 'actual queue-preview masks before the 200-character display cut')
  assert.equal(state.text.length, 201, '200 characters plus the displayed ellipsis')
  assert.equal(state.title, expectedFull, 'TITLE retains the full MASKED text, including both complete masks')
  assert.equal(state.tag, 'SPAN', 'preview itself is not an interactive reveal surface')
  assert.equal(state.role, null)
  assert.equal(state.tabIndex, null)
  assert.equal(state.previewActions, 0)
  assert.equal(state.toggles, 0, 'queue dock adds no eye/reveal buttons')
  assert.equal(state.secretControls, 0)
  for (const attribute of state.attributes) assert.ok(!attribute.includes(fakeSk) && !attribute.includes(fakeGhp), 'queue title/aria/attributes contain no raw FAKE keys')
}

async function editQueue(browser, text) {
  await browser.evaluate(`document.querySelector('#queue [aria-label="Edit queued message"]').click()`)
  await browser.waitFor(`${EDITOR} !== null`, 5000)
  assert.equal(await browser.evaluate(`${EDITOR}.value`), queueText, 'Edit opens the full exact raw queued value, not mask or truncated preview')
  await browser.evaluate(`(() => { const field = ${EDITOR}; field.focus(); field.select() })()`)
  await browser.send('Input.insertText', { text })
  assert.equal(await browser.evaluate(`${EDITOR}.value`), text, 'the actual queue editor contains the raw replacement')
}

async function assertGoalMasked(browser) {
  await browser.waitFor(`${COMMAND_INPUT}?.textContent === ${JSON.stringify(`/goal ${maskedObjective}`)} && ${GOAL_ARGS}?.textContent === ${JSON.stringify(maskedObjective)}`, 10_000)
  const state = JSON.parse(await browser.evaluate(`JSON.stringify((() => {
    const input = ${COMMAND_INPUT}
    const args = ${GOAL_ARGS}
    // Scope deliberately excludes .hc-text result and #goal-bar; they are NOT privacy surfaces here.
    const nodes = [input, ...input.querySelectorAll('*'), args, ...args.querySelectorAll('*')]
    return { input: input.textContent, args: args.textContent,
      controls: input.querySelectorAll('button, a, time, [role="button"], .user-secret-toggle').length + args.querySelectorAll('button, a, [role="button"], .user-secret-toggle').length,
      attributes: nodes.flatMap(n => [...n.attributes].map(a => a.value)) }
  })())`))
  assert.equal(state.input, `/goal ${maskedObjective}`, 'actual command-input bubble displays asterisks')
  assert.equal(state.args, maskedObjective, 'actual hc-args displays asterisks')
  assert.equal(state.controls, 0, 'goal input and args add no interactive reveal controls')
  for (const attribute of state.attributes) assert.ok(!attribute.includes(fakeSk) && !attribute.includes(fakeGhp), 'goal input/args have no raw title/aria/attributes')
}

test('queue preview/title mask before truncation, edits preserve raw provider text, and /goal input masks without changing the backend objective', { timeout: 150_000 }, async (context) => {
  // UI=0 returns the standard labelled unjudged skip before fixtures or CLI/provider startup.
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine and the UI verification target')) return
  assert.ok(fakeSk.slice(3).length >= FAKE_SK_SUFFIX_MIN && /\d/.test(fakeSk.slice(3)))
  assert.ok(fakeGhp.slice(4).length >= FAKE_GHP_SUFFIX_MIN)
  assert.equal(queuePrefix.length, 185)
  assert.ok(queueText.indexOf(fakeSk) < 200 && queueText.indexOf(fakeSk) + fakeSk.length > 200, 'complete FAKE sk key straddles display boundary')
  assert.ok(queueText.indexOf(fakeGhp) > 200, 'full title also judges a key wholly beyond preview')
  const home = isolatedHome('user-text-surfaces')
  const work = fixtureDir('user-text-surfaces-work')
  chmodSync(home, 0o700)
  let provider, child, browser
  let browserAbandoned = false
  try {
    provider = await providerDouble()
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'fake-user-text', endpoints: [{ name: 'fake-user-text', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'fake-user-text-model', stream: true, contextWindow: 1_000_000, timeoutMs: 90_000 }],
    })
    const noDriver = join(home, 'no-goal-driver.yml')
    writeFileSync(noDriver, '- remove:\n    - goal-driver\n', { mode: 0o600 })
    const url = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--patch', join(repoRoot, 'heddle.patch.yml'), '--patch', noDriver, '--endpoint', 'fake-user-text', '--max-rounds', '1', '--session-root', join(home, 'sessions')], {
      HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config,
    }, work, (owned) => { child = owned })
    const cookie = await cookieFor(url)
    await api(url, cookie, '/api/workspaces', { path: work })
    const made = await api(url, cookie, '/api/sessions', { branch: work, title: 'FAKE user text surfaces fixture' })
    assert.equal(typeof made.session, 'string')
    const opening = openBrowser({ width: 1440, height: 1000 }).then(async (opened) => {
      if (browserAbandoned) { await bounded(opened.close(), 5000, 'late browser cleanup'); throw new Error('browser startup abandoned') }
      browser = opened
      return opened
    })
    try { await bounded(opening, 20_000, 'browser startup') } catch (error) { browserAbandoned = true; throw error }
    await browser.gotoSession(url, made.session)
    await browser.waitFor('document.body.dataset.connection === "open" && document.querySelector("#prompt textarea") !== null', 20_000)
    await typeAndEnter(browser, holdPrompt)
    await until(() => provider.requests.length === 1)
    await browser.waitFor('document.getElementById("stop")?.hidden === false', 10_000)
    await typeAndEnter(browser, queueText)
    await browser.waitFor('document.getElementById("queue")?.hidden === false && document.querySelector("#queue .row")?.dataset.status === "pending"', 10_000)
    await assertQueueMasked(browser, maskedQueue)
    assert.equal(provider.requests.length, 1, 'pending queue text has not started a second provider call')

    await editQueue(browser, `${queueText} CANCELLED FAKE edit`)
    await browser.evaluate(`document.querySelector('#queue [aria-label="Cancel edit"]').click()`)
    await browser.waitFor(`${EDITOR} === null`, 5000)
    await assertQueueMasked(browser, maskedQueue)
    // Reopening proves Cancel retained RAW data, not only an unchanged display.
    await editQueue(browser, savedQueueText)
    await browser.evaluate(`document.querySelector('#queue [aria-label="Save queued message"]').click()`)
    await browser.waitFor(`${EDITOR} === null`, 5000)
    await assertQueueMasked(browser, savedMaskedQueue)
    assert.equal(provider.requests.length, 1, 'cancel/save do not send or mutate the held provider turn')

    provider.release()
    await until(() => provider.requests.length === 2, 20_000)
    await browser.waitFor('document.getElementById("queue")?.hidden === true && document.getElementById("stop")?.hidden === true', 20_000)
    const firstUsers = provider.requests[0].messages.filter(n => n.role === 'user')
    const secondUsers = provider.requests[1].messages.filter(n => n.role === 'user')
    assert.ok(firstUsers.some(n => n.content === holdPrompt), 'the actual held provider turn received its ordinary prompt')
    assert.ok(!firstUsers.some(n => n.content === queueText || n.content === savedQueueText), 'queued data was not injected into the already-running request')
    assert.ok(secondUsers.some(n => n.content === savedQueueText), 'the real second CLI/provider request receives the exact saved raw keys and suffix')
    assert.ok(!JSON.stringify(provider.requests).includes('CANCELLED FAKE edit'), 'cancelled edits never reach provider data')

    // No goal-driver in this private process: /goal is an actual host command, NOT a model request.
    await typeAndEnter(browser, `/goal ${objective}`)
    await browser.waitFor('document.querySelector("#log .hc-command")?.dataset.state === "done"', 15_000)
    await assertGoalMasked(browser)
    const goal = (await api(url, cookie, `/api/goal?session=${encodeURIComponent(made.session)}`)).goal
    assert.ok(goal, 'the goal command really created backend state')
    assert.equal(goal.objective, objective, 'raw backend goal objective is byte-for-byte exact, not masked')
    assert.equal(goal.roundsStarted, 0, 'private profile starts no automatic goal rounds')
    // History reconstruction exercises the goal input/args without repeating part 1 bubble/remount tests.
    await browser.goto(url)
    await browser.waitFor('document.body.dataset.connection === "open"', 20_000)
    await assertGoalMasked(browser)
    const reloadedGoal = (await api(url, cookie, `/api/goal?session=${encodeURIComponent(made.session)}`)).goal
    assert.equal(reloadedGoal.objective, objective, 'history reload leaves raw backend objective untouched')
    assert.equal(reloadedGoal.roundsStarted, 0)
    assert.equal(provider.requests.length, 2, 'goal create and reload make no model, automatic round or compaction request')
    assert.equal(provider.titleRequests(), 0)
    assert.deepEqual(provider.errors, [])
    context.diagnostic('Only queue preview/title and goal input/args judged; goal result and bar intentionally OUT, not whole-screen privacy. Source 60c67da5 author pin is not runtime provenance.')
  } finally {
    browserAbandoned = true
    const cleanup = []
    if (browser) cleanup.push(bounded(browser.close(), 5000, 'browser cleanup'))
    if (child) cleanup.push(endChild(child, { graceMs: 2000 }).then(result => { assert.notEqual(result, 'stuck', 'CLI cleanup is bounded') }))
    if (provider) cleanup.push(provider.close())
    const results = await Promise.allSettled(cleanup)
    // Resolve and validate ONLY the exact allocated fixture directories before removal.
    for (const path of [home, work]) {
      const absolute = resolve(path)
      assert.equal(absolute, path)
      assert.ok(absolute.startsWith(join(repoRoot, '.heddle-tmp') + '/') && /user-text-surfaces/.test(absolute), 'cleanup target belongs to this check')
      removeDir(absolute)
    }
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
})
