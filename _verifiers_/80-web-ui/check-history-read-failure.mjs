import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, harnessEntry, heddleCommand, removeDir, repoRoot, scratchRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * ---
 * title: History read failure in a scratch browser
 * description: Rejected history fetch and JSON reads keep the conversation unavailable until another session opens.
 * grounded_in:
 *   - source: approved candidate 884c1cd601cce46168c7658b027ed1db2eb8972f
 * ---
 * Headless, offline, built harness only. Explicit parent workspace gate below.
 * Own port 0, private home/config/session root/workspace, TWO distinct named sessions.
 * Exact A history GET interception only. Real server SSE proves buffered/live rows reached this page.
 * Authoring and syntax checks are not browser proof. No live URL or settings route is used.
 */
const CALL_MS = 10000
const FETCH_MS = 8000
const js = JSON.stringify
async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
function privateEnvironment(home, config) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('HEDDLE_')) delete env[key]
  return { ...env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache') }
}
async function startServer(world, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted',
    '--session-root', join(world.home, 'sessions')]), {
    cwd: world.work, env: privateEnvironment(world.home, config), stdio: ['ignore', 'pipe', 'pipe'],
  })
  world.child = child // register before awaiting startup, including on failure
  let output = ''
  world.url = await bounded(new Promise((done, reject) => {
    const read = chunk => {
      output = (output + chunk.toString()).slice(-16000)
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) done(match[1])
    }
    child.stdout.on('data', read); child.stderr.on('data', read)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`scratch server exited ${code ?? signal}\n${output}`)))
  }), 12000, 'scratch server startup').catch(error => { throw new Error(`${error.message}\n${output}`) })
  assert.equal(new URL(world.url).hostname, '127.0.0.1')
  assert.notEqual(new URL(world.url).port, '', 'owned allocated port')
}
async function request(world, path, body) {
  const url = new URL(path, world.url)
  url.searchParams.set('token', new URL(world.url).searchParams.get('token') ?? '')
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: js(body) }),
    signal: AbortSignal.timeout(FETCH_MS) })
  const text = await response.text() // abort bounds body as well as headers
  assert.equal(response.status, 200, `${path}: ${response.status} ${text.slice(0, 500)}`)
  return path === '/api/turn' ? text : JSON.parse(text)
}
const stateExpression = `(() => ({
  title: document.getElementById('session-title')?.textContent,
  lines: [...document.querySelectorAll('#log > *')].map(node => node.textContent),
  alerts: [...document.querySelectorAll('#log .load-error[role="alert"]')].map(node => node.textContent),
  emptyHidden: document.getElementById('empty-state')?.hidden,
  disabled: document.querySelector('#prompt textarea')?.disabled,
  readOnly: document.querySelector('#prompt textarea')?.readOnly,
  placeholder: document.querySelector('#prompt textarea')?.placeholder,
  sendDisabled: document.getElementById('send')?.disabled,
  composer: document.body.dataset.composer,
  saved: JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null,
  writes: window.__historyProbe?.writes ?? [], intercepted: window.__historyProbe?.intercepted ?? 0
}))()`
async function assertUnavailable(browser, reason) {
  const seen = await browser.evaluate(stateExpression)
  assert.deepEqual(seen.lines, [`Failed to load history: ${reason}`], js(seen))
  assert.deepEqual(seen.alerts, seen.lines, 'one real failure alert')
  assert.equal(seen.title, 'Session unavailable')
  assert.equal(seen.placeholder, 'Session unavailable')
  assert.equal(seen.disabled, true); assert.equal(seen.readOnly, true)
  assert.equal(seen.sendDisabled, true); assert.equal(seen.composer, 'unavailable')
  assert.equal(seen.emptyHidden, true, 'empty hero does not obscure failure')
  assert.equal(seen.saved, null, 'failed selection not persisted')
  assert.equal(seen.intercepted, 1, 'only intended history GET intercepted')
  assert.ok(!seen.lines[0].includes('(0)'), 'no invented HTTP status for exceptions')
  return seen
}
for (const mode of ['fetch', 'json']) {
  test(`history ${mode} rejection blocks buffered/live rows and recovers on named B`, { timeout: 60000 }, async t => {
    assert.equal(resolve(process.env.HEDDLE_VERIFY_HISTORY_FAILURE_WORKSPACE ?? '/'), repoRoot,
      'parent must explicitly gate workspace with HEDDLE_VERIFY_HISTORY_FAILURE_WORKSPACE="$PWD"')
    if (!skipUnless(t, existsSync(harnessEntry()), 'parent must build harness first')) return
    if (!skipUnless(t, browserAvailable(), 'headless browser unavailable or UI disabled')) return
    const root = fixtureDir(`history-read-failure-${mode}`)
    const world = { home: join(root, 'home'), work: join(root, 'workspace'), child: null, browser: null }
    mkdirSync(world.home); mkdirSync(world.work)
    const watchdog = setTimeout(() => { world.child?.kill('SIGKILL'); void world.browser?.close(); process.exit(1) }, 65000)
    try {
      const { config } = scriptedConfig({ home: world.home, steps: Array.from({ length: 12 }, () => ({ text: 'offline fixture answer' })) })
      await startServer(world, config)
      await request(world, '/api/workspaces', { path: world.work, name: 'history-failure-scratch' })
      const a = (await request(world, '/api/sessions', { branch: world.work, title: 'History failure A' })).session
      const b = (await request(world, '/api/sessions', { branch: world.work, title: 'History recovery B' })).session
      assert.equal(typeof a, 'string'); assert.equal(typeof b, 'string'); assert.notEqual(a, b, 'TWO distinct named sessions')
      const turn = (session, prompt) => request(world, '/api/turn', { session, prompt })
      await turn(a, 'A_HISTORY_MARKER'); await turn(b, 'B_HISTORY_MARKER')
      const opening = openBrowser({ width: 1280, height: 900 })
      let expired = false
      void opening.then(browser => { if (expired) void browser.close() }, () => {})
      try { world.browser = await bounded(opening, CALL_MS, 'browser startup') } catch (error) { expired = true; throw error }
      const browser = world.browser
      await bounded(browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__historyFrames = [];
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(...args) { super(...args); this.addEventListener('session', message => window.__historyFrames.push(message.data)); }
        };
      ` }), CALL_MS, 'install stream observer')
      await browser.gotoSession(world.url, b, CALL_MS)
      await browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('log').textContent.includes('B_HISTORY_MARKER')`, CALL_MS)
      await browser.evaluate(`(() => {
        const original = window.fetch.bind(window);
        const probe = window.__historyProbe = { entered: false, intercepted: 0, writes: [], result: 'pending' };
        let release; const held = new Promise(done => { release = done; });
        const timer = setTimeout(release, ${FETCH_MS});
        probe.release = () => { clearTimeout(timer); release(); };
        window.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (method !== 'GET') probe.writes.push(method + ' ' + url.pathname);
          // Completion may trigger a separate statistics GET of this same path; only the opening read fails.
          if (method !== 'GET' || url.pathname !== ${js(`/api/sessions/${a}`)} || probe.intercepted !== 0) return original(input, init);
          probe.intercepted++;
          if (${js(mode)} === 'fetch') { probe.entered = true; await held; throw new TypeError('scratch fetch rejected'); }
          const response = await original(input, { ...init, signal: AbortSignal.timeout(${FETCH_MS}) });
          if (!response.ok) throw new Error('fixture GET unexpectedly failed: ' + response.status);
          response.json = async () => { probe.entered = true; await held; throw new SyntaxError('scratch JSON rejected'); };
          return response;
        };
        // Current exposed API takes an ID and resolves a boolean, not a session meta object.
        probe.open = showSession(${js(a)}).then(value => { probe.result = value; }, error => { probe.result = 'unexpected rejection: ' + error.message; });
        return true;
      })()`)
      await browser.waitFor('window.__historyProbe.entered === true', CALL_MS)
      await turn(a, 'A_BUFFERED_MARKER')
      await browser.waitFor(`window.__historyFrames.some(frame => frame.includes('A_BUFFERED_MARKER'))`, CALL_MS)
      assert.equal(await browser.evaluate('document.getElementById("log").childElementCount'), 0, 'real A SSE stays buffered during read')
      await browser.evaluate('window.__historyProbe.release(); true')
      await browser.waitFor('window.__historyProbe.result !== "pending"', CALL_MS)
      assert.equal(await browser.evaluate('window.__historyProbe.result'), false, 'showSession resolves false')
      const reason = mode === 'fetch' ? 'scratch fetch rejected' : 'scratch JSON rejected'
      await assertUnavailable(browser, reason)
      await turn(a, 'A_LIVE_BLOCKED_MARKER'); await turn(b, 'B_LIVE_BLOCKED_MARKER')
      await browser.waitFor(`['A_LIVE_BLOCKED_MARKER', 'B_LIVE_BLOCKED_MARKER'].every(marker => window.__historyFrames.some(frame => frame.includes(marker)))`, CALL_MS)
      await assertUnavailable(browser, reason)
      await browser.evaluate(`(() => {
        const form = document.getElementById('prompt'); const field = form.querySelector('textarea');
        field.value = 'FAILED_DRAFT_MUST_NOT_SEND'; field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        form.requestSubmit(); document.getElementById('send').click(); return true;
      })()`)
      await browser.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
      assert.deepEqual((await assertUnavailable(browser, reason)).writes, [], 'draft/Enter/submit/Send issue no writes')
      assert.equal(await browser.evaluate(`showSession(${js(b)})`, CALL_MS), true, 'B opens successfully with current API')
      const recovered = await browser.evaluate(stateExpression)
      assert.equal(recovered.title, 'History recovery B')
      assert.equal(recovered.disabled, false); assert.equal(recovered.readOnly, false)
      assert.equal(recovered.composer, 'writable'); assert.notEqual(recovered.placeholder, 'Session unavailable')
      assert.deepEqual(recovered.alerts, [], 'B clears failure'); assert.equal(recovered.saved, b)
      const text = recovered.lines.join('\n')
      assert.ok(text.includes('B_HISTORY_MARKER') && text.includes('B_LIVE_BLOCKED_MARKER'), 'B shows own history including blocked live row')
      assert.ok(!/A_HISTORY_MARKER|A_BUFFERED_MARKER|A_LIVE_BLOCKED_MARKER|Failed to load history/.test(text), 'no A tail/failure leaks into B')
      assert.deepEqual(recovered.writes, [], 'page never writes settings or sessions')
      t.diagnostic(`scratch ${mode} failure/recovery judged on ${a} / ${b}, port ${new URL(world.url).port}`)
    } finally {
      try { if (world.browser) await bounded(world.browser.close(), 4000, 'browser cleanup') }
      finally {
        try {
          if (world.child) {
            const ended = await endChild(world.child, { graceMs: 1000 })
            world.child.stdout?.destroy(); world.child.stderr?.destroy()
            assert.notEqual(ended, 'stuck', 'scratch server exits within cleanup bound')
          }
        } finally {
          const inside = relative(scratchRoot, resolve(root))
          assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), 'delete only this run-owned scratch allocation')
          removeDir(root); clearTimeout(watchdog)
        }
      }
    }
  })
}
