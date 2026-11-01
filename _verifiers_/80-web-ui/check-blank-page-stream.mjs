import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A page with nothing open draws no other session's turn, only its own first one (#142, developer-ten's finding on
 * first-visit-2 2349341f), judged with two pages on one server.
 *
 * Every session's events reach every page: the server pushes each session's events to every `/api/events` reader, in
 * both builds. The page's stream listener drew them while nothing was open (`current ?? unavailableSession` was null,
 * and "only with neither does the panel follow any session's turn"). On main a load starts a blank session, so the
 * listener filters; since #142 a first visit opens nothing, and a fresh tab drew every other person's live turn into its
 * blank panel, with their usage in the dock, and its own first message then landed under those rows. DSH's new-session
 * screen draws no other session's transcript.
 *
 * Page B loads fresh, with no session. Page A, another browser, sends a message in the same workspace, and its answer is
 * held open by the provider double so the turn is seen running. While it runs and after it ends, B's conversation stays
 * empty and B's dock hidden, but B's tree still follows A's session: its row is marked running, then not (only the
 * drawing half is held, developer-ten's edge 6). Then B sends its own message and shows only its own turn.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

const listeners = new Set()
after(() => Promise.all([...listeners].map((listener) => listener.close())))

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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

const type = (browser, text) =>
  browser.evaluate(`(() => { const field = document.querySelector('textarea'); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const press = (browser, init) =>
  browser.evaluate(`(() => { document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)})); return true })()`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

test('a page with nothing open draws no other session\'s turn, its tree still follows it, and its own first message shows only its own turn (#142)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('blank-page-stream')
  const work = fixtureDir('blank-page-stream-work')
  /** A held answer, so A's turn is observably running while B is sampled. */
  const double = await chatDouble({ content: 'the answer', holdOpenMs: 3000 })
  listeners.add(double)
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'held',
    endpoints: [{ name: 'held', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'held-model', stream: true }],
  })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'held', '--session-root', join(home, 'sessions')], {
    HEDDLE_CONFIG: config,
    HEDDLE_HOME: home,
  })
  const pageA = await openBrowser({ width: 1280, height: 900 })
  const pageB = await openBrowser({ width: 1280, height: 900 })
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const api = async (path, init = {}) => {
      const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    const added = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `the workspace is registered (${JSON.stringify(added.body)})`)
    const listed = async () => {
      const answer = await api('/api/sessions')
      return Array.isArray(answer.body) ? answer.body : []
    }

    /** B: a first visit, nothing open, aimed at the one workspace. */
    await pageB.goto(server.url)
    await pageB.waitFor('document.body.dataset.ready === "true"', 20_000)
    await pageB.waitFor(`document.getElementById('session-title').textContent === 'No session'`, 10_000)
    const stateB = () =>
      pageB.evaluate(`JSON.stringify({
        rows: [...document.querySelectorAll('#log > *')].map((node) => node.textContent.trim()).filter((text) => text.length > 0),
        dockHidden: document.getElementById('composer-status')?.hidden ?? null,
        title: document.getElementById('session-title')?.textContent ?? null,
      })`)
    const blank = JSON.parse(await stateB())
    assert.deepEqual(blank.rows, [], 'B opens blank')
    assert.equal(blank.dockHidden, true, 'with no dock')

    /** A: another first visit, sending a message; its answer is held open. */
    await pageA.goto(server.url)
    await pageA.waitFor('document.body.dataset.ready === "true"', 20_000)
    assert.ok(
      await pageA.waitFor(`document.getElementById('tree-note').textContent.startsWith('a new conversation in ')`, 15_000),
      'A is aimed at the one workspace, so its first message starts a session there (#142)',
    )
    await type(pageA, 'alpha prompt from page A')
    await press(pageA, { key: 'Enter' })
    let sessionA = null
    for (let attempt = 0; attempt < 80 && sessionA === null; attempt += 1) {
      sessionA = (await listed()).find((meta) => meta.running === true)?.id ?? null
      if (sessionA === null) await sleep(100)
    }
    assert.ok(sessionA !== null, 'A\'s turn runs in a session of its own')
    const rowA = `document.querySelector('#tree li[data-kind="session"][data-session-id="${sessionA}"] > .row')`

    /** While A's turn runs: B's panel stays empty and its dock hidden, and B's tree marks A's session running. */
    let sawRunning = false
    const samples = []
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const running = await pageB.evaluate(`${rowA}?.querySelector(':scope > .status-dot[aria-label="Running"]') != null`)
      const now = JSON.parse(await stateB())
      samples.push(now)
      assert.deepEqual(now.rows, [], `B's panel draws nothing of A's turn\nsaw: ${JSON.stringify(now)}`)
      assert.equal(now.dockHidden, true, `and B's dock stays hidden\nsaw: ${JSON.stringify(now)}`)
      sawRunning ||= running === true
      const meta = (await listed()).find((entry) => entry.id === sessionA)
      if (meta?.running !== true && (meta?.turns ?? 0) > 0) break
      await sleep(250)
    }
    assert.equal(sawRunning, true, `B's tree marked A's session running while it ran (only the drawing half is held)\nsamples: ${samples.length}`)
    assert.ok(
      await pageB.waitFor(`${rowA} !== null && ${rowA}.querySelector(':scope > .status-dot[aria-label="Running"]') === null`, 15_000),
      'and then no longer running, once A\'s turn ended',
    )
    const afterA = JSON.parse(await stateB())
    assert.deepEqual(afterA.rows, [], `after A's turn B's panel is still empty\nsaw: ${JSON.stringify(afterA)}`)
    assert.equal(afterA.dockHidden, true, 'and its dock hidden')

    /** B sends its own first message: it shows its own turn only. */
    const before = (await listed()).map((meta) => meta.id)
    await type(pageB, 'beta prompt from page B')
    await press(pageB, { key: 'Enter' })
    assert.ok(await pageB.waitFor(`document.getElementById('log').innerText.includes('beta prompt from page B')`, 15_000), 'B draws its own message')
    assert.ok(await pageB.waitFor(`document.getElementById('log').innerText.includes('the answer')`, 20_000), 'and its own answer')
    const own = JSON.parse(await stateB())
    assert.ok(!own.rows.some((text) => text.includes('alpha prompt from page A')), `and no row of A's\nsaw: ${JSON.stringify(own)}`)
    assert.equal(own.rows.filter((text) => text.includes('prompt from page')).length, 1, `one user message, its own\nsaw: ${JSON.stringify(own)}`)
    let sessionB = null
    for (let attempt = 0; attempt < 60 && sessionB === null; attempt += 1) {
      sessionB = (await listed()).find((meta) => !before.includes(meta.id))?.id ?? null
      if (sessionB === null) await sleep(100)
    }
    assert.ok(sessionB !== null && sessionB !== sessionA, 'B\'s message made a session of its own, not A\'s')
  } finally {
    pageA.close()
    pageB.close()
    server.kill()
    await double.close()
    listeners.delete(double)
    removeDir(home)
    removeDir(work)
  }
})
