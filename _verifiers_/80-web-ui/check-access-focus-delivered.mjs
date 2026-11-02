import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Headless delivered-surface regression for #103, not the source fixture in check-access-focus.mjs.
 * Runs the built CLI (or HEDDLE_BIN) on private port 0 with a private HOME/workspace and an offline script.
 * Real pointer/menu actions and native keys exercise the unchanged delivered risk card. Never activate Enable,
 * confirm full access, or send a permission write. A pass-through fetch recorder observes requests only; it
 * substitutes no response, handler, DOM or source function. Both deployment and session stay workspace-write.
 * This is functional focus containment, not a complete accessibility audit or evidence for an unrun build.
 */

const START_MS = 15_000
const REQUEST_MS = 8_000
const CLEANUP_MS = 8_000

/** Bound operations whose helpers have no caller timeout, including browser startup/cleanup. */
async function bounded(operation, ms, label) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function startServer(home, work, config, signal) {
  const safePatch = join(home, 'safe.patch.yml')
  writeFileSync(safePatch, '- patch:\n    - id: sandbox\n      config:\n        mode: workspace-write\n')
  // Do not inherit endpoint/profile overrides that could turn an offline check into an operator model call.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HEDDLE_')))
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--patch', join(repoRoot, 'heddle.patch.yml'), '--patch', safePatch,
      '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work, '--max-rounds', '2']),
    { cwd: work, env: { ...env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  const abort = () => child.kill('SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  const url = new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`the server printed no URL within ${START_MS}ms\n${output}`))
    }, START_MS)
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-64_000)
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) finish(null, match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (error) => finish(error))
    child.once('exit', (code, reason) => finish(new Error(`the server exited ${code ?? reason} before printing a URL\n${output}`)))
    signal.addEventListener('abort', () => finish(new Error('test aborted during server startup')), { once: true })
  })
  return {
    url,
    async close() {
      signal.removeEventListener('abort', abort)
      const result = await endChild(child, { graceMs: 3000 })
      child.stdout.destroy()
      child.stderr.destroy()
      assert.notEqual(result, 'stuck', 'the private CLI exits within its cleanup bound')
    },
  }
}

/** The same launch-token authentication as existing delivered CLI checks; timeout covers fetch AND body. */
async function request(url, path, signal, body) {
  assert.ok(!/\/permission(?:\?|$)/.test(path), 'this verifier never sends a permission request')
  const base = new URL(url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  const response = await fetch(target, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `${path} succeeds: ${text.slice(0, 300)}`)
  return text
}

/** Trusted pointer input, not element.click() or an invocation of page handlers. */
async function clickAt(browser, selector) {
  const point = JSON.parse(await browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return JSON.stringify({ error: 'no element' })
    const box = element.getBoundingClientRect()
    return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height,
      visible: !element.closest('[hidden], [inert]'), disabled: element.matches(':disabled') })
  })()`))
  assert.equal(point.error, undefined, `${selector} exists`)
  assert.ok(point.visible && !point.disabled && point.width > 0 && point.height > 0, `${selector} is clickable`)
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await browser.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 })
  }
}

async function key(browser, key, code, modifiers = 0) {
  const virtual = key === 'Tab' ? 9 : key === 'Escape' ? 27 : key === 'Enter' ? 13 : 32
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined
  await browser.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', key, code, modifiers,
    windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, ...(text === undefined ? {} : { text, unmodifiedText: text }) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual })
}

test('the delivered risk card cycles native focus and cancels without any permission POST', { timeout: 90_000 }, async (context) => {
  if (!skipUnless(context, browserAvailable(), 'headless browser for delivered risk-dialog focus (HEDDLE_VERIFY_UI=0 disables UI checks)')) return
  const home = isolatedHome('access-focus-delivered')
  const work = fixtureDir('access-focus-delivered-work')
  let server
  let browser
  try {
    const { config } = scriptedConfig({ home, steps: [{ text: 'offline focus session ready' }] })
    server = startServer(home, work, config, context.signal)
    const url = await server.url
    const initial = JSON.parse(await request(url, '/api/status', context.signal))
    assert.equal(initial.sandbox?.mode, 'workspace-write', 'the server starts only under the safe configured mode')
    const turn = await request(url, '/api/turn', context.signal, { prompt: 'open the offline focus-check session', folder: work })
    const sessionBlock = turn.split('\n\n').find((block) => /^event: session$/m.test(block))
    const session = JSON.parse(/^data: (.+)$/m.exec(sessionBlock ?? '')?.[1] ?? '{}').session
    assert.ok(typeof session === 'string' && session.length > 0, 'the actual scripted turn names its session')
    async function safeModes() {
      const status = JSON.parse(await request(url, '/api/status', context.signal))
      const held = JSON.parse(await request(url, `/api/sessions/${encodeURIComponent(session)}`, context.signal))
      assert.equal(status.sandbox?.mode, 'workspace-write', 'deployment mode remains workspace-write')
      assert.equal(held.permission?.mode, 'workspace-write', 'the named session remains workspace-write')
    }
    await safeModes()
    const opening = openBrowser({ width: 1280, height: 900 })
    // A browser that finishes starting after our bound must still be closed.
    let abandoned = false
    opening.then((late) => { if (abandoned) void late.close() }, () => {})
    try { browser = await bounded(opening, START_MS, 'browser startup') } catch (error) { abandoned = true; throw error }
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch
      window.__riskFocusRequests = []
      window.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href)
        window.__riskFocusRequests.push({ path: url.pathname, method: String(init?.method ?? input?.method ?? 'GET').toUpperCase() })
        return Reflect.apply(nativeFetch, this, arguments)
      }
    })()` })
    await browser.gotoSession(url, session, 15_000)
    await browser.waitFor('document.getElementById("access")?.disabled === false && document.getElementById("access-label")?.textContent === "Workspace Write"', 10_000)
    const focused = () => browser.evaluate('document.activeElement?.id')
    async function open() {
      await clickAt(browser, '#access')
      await browser.waitFor('document.getElementById("access-menu").hidden === false', 3000)
      await clickAt(browser, '#access-menu [data-mode="danger-full-access"]')
      await browser.waitFor('document.getElementById("access-dialog").hidden === false', 3000)
      assert.equal(await focused(), 'access-risk', 'opening focuses acknowledgement')
      assert.equal(await browser.evaluate('document.getElementById("access-risk").checked'), false, 'each opening resets acknowledgement')
      assert.equal(await browser.evaluate('document.getElementById("access-enable").disabled'), true, 'Enable is excluded before acknowledgement')
    }
    async function cycle(ids, modifiers = 0) {
      for (const id of ids) {
        await key(browser, 'Tab', 'Tab', modifiers)
        assert.equal(await focused(), id, `native ${modifiers ? 'Shift+Tab' : 'Tab'} stays in the current candidate cycle`)
      }
    }
    async function closed() {
      assert.equal(await browser.evaluate('document.getElementById("access-dialog").hidden'), true, 'the risk card closes')
      assert.equal(await focused(), 'access', 'dismissal returns focus to the access chip')
      const requests = JSON.parse(await browser.evaluate('JSON.stringify(window.__riskFocusRequests)'))
      assert.ok(requests.some((entry) => entry.method === 'GET' && entry.path === `/api/sessions/${session}`), 'the pass-through recorder observed the actual named session read')
      const writes = requests.filter((entry) => entry.method === 'POST' && (/\/permission$/.test(entry.path) || entry.path.startsWith('/api/settings')))
      assert.deepEqual(writes, [], 'no permission or Settings POST was attempted')
      await safeModes()
    }
    await open()
    await cycle(['access-cancel', 'access-dialog-close', 'access-risk', 'access-cancel', 'access-dialog-close', 'access-risk'])
    await cycle(['access-dialog-close', 'access-cancel', 'access-risk', 'access-dialog-close', 'access-cancel', 'access-risk'], 8)
    await key(browser, 'Escape', 'Escape')
    await closed()

    await open()
    await key(browser, ' ', 'Space')
    assert.equal(await browser.evaluate('document.getElementById("access-risk").checked'), true, 'native Space acknowledges risk without confirming access')
    assert.equal(await browser.evaluate('document.getElementById("access-enable").disabled'), false, 'four controls are now candidates')
    await cycle(['access-cancel', 'access-enable', 'access-dialog-close', 'access-risk', 'access-cancel', 'access-enable', 'access-dialog-close', 'access-risk'])
    await cycle(['access-dialog-close', 'access-enable', 'access-cancel', 'access-risk', 'access-dialog-close', 'access-enable', 'access-cancel', 'access-risk'], 8)
    await cycle(['access-dialog-close'], 8)
    assert.equal(await focused(), 'access-dialog-close', 'only Close, never Enable, receives native Enter')
    await key(browser, 'Enter', 'Enter')
    await closed()

    await open()
    await cycle(['access-cancel'])
    assert.equal(await focused(), 'access-cancel', 'native Enter is safely directed at Cancel')
    await key(browser, 'Enter', 'Enter')
    await closed()
    assert.equal(await browser.evaluate('document.getElementById("access-label").textContent'), 'Workspace Write')
  } finally {
    try {
      if (browser) await bounded(browser.close(), CLEANUP_MS, 'browser cleanup')
    } finally {
      try { if (server) await bounded(server.close(), CLEANUP_MS, 'server cleanup') }
      finally { removeDir(home); removeDir(work) }
    }
  }
})
