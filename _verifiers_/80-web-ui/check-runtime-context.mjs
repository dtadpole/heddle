import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, fixtureDir, heddleCommand, httpConfig, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The runtime-context snapshot as a **trajectory fact**, judged in a browser.
 *
 * The permission verifier judges what the model received; this file judges what a person reading afterwards can
 * see: the Trajectory view names the harness's runtime-context snapshots (so a mode change is legible after the
 * fact), while the Chat view — the conversation — does not draw them as something a person said. That split is
 * the claim: the snapshot is model history and an attributed record, not a chat turn.
 */

/**
 * Every local listener this file opens — a model double, or a server a check stands up — so a harness that fails to
 * start cannot leave one listening. A failed start rejects before the check reaches its own `finally`, the leaked
 * listener keeps this file's process alive, and the runner, which sets no test timeout, then waits forever instead of
 * reporting the failure: measured on 2026-10-22, four checks of `80-web-ui` never exited against a binary that does
 * not serve. `after` closes whatever is still open; a listener a check already closed is closed again harmlessly.
 */
const listeners = new Set()
function held(listener) {
  listeners.add(listener)
  return listener
}
after(() =>
  Promise.all(
    [...listeners].map((listener) =>
      typeof listener.close === 'function'
        ? listener.close()
        : new Promise((resolve) => listener.server.close(() => resolve())),
    ),
  ),
)

const CAPABILITY = 'a Web UI on localhost with a live stream'

/** Spawn `heddle web` on an ephemeral port with a local chat double, and resolve once it prints its URL. */
async function startServer(label) {
  const home = isolatedHome(`runtime-context-ui-${label}`)
  const work = fixtureDir(`runtime-context-ui-${label}-work`)
  const double = held(await chatDouble({ content: 'ok' }))
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')]),
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({
          url: match[1],
          close: async () => {
            child.kill('SIGKILL')
            await double.close()
            removeDir(home)
            removeDir(work)
          },
        })
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

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

async function sendMessage(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    return true
  })()`)
}

test('a mode change is named in the Trajectory view and not drawn as a chat turn', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('trajectory')
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await sendMessage(browser, 'first turn')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 20_000), 'the first turn finishes')

    const sessions = await request(server, '/api/sessions').then((response) => response.json())
    const session = sessions[0]?.id
    assert.ok(typeof session === 'string', 'the turn created a session')
    const changed = await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'read-only' }),
    })
    assert.equal(changed.status, 200, 'the mode can be narrowed while the session is open')
    await sendMessage(browser, 'second turn')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 20_000), 'the second turn finishes')
    assert.ok(
      await browser.waitFor('document.getElementById("access-label").textContent === "Read Only"', 10_000),
      'the chip shows the session’s new mode',
    )

    /** Chat is the conversation: the harness's snapshot must not appear as something a person typed. */
    assert.ok(
      !(await browser.evaluate('document.getElementById("log").innerText')).includes('Current runtime context'),
      'the Chat view does not draw the snapshot as a turn',
    )

    /** Trajectory is the record: both snapshots are named, and the later one says the new policy. */
    await browser.evaluate('document.getElementById("tab-trajectory").click()')
    assert.ok(await browser.waitFor('document.getElementById("ledger").hidden === false', 10_000), 'the Trajectory view opens')
    assert.ok(
      await browser.waitFor('document.getElementById("ledger").innerText.includes("runtime context")', 10_000),
      'the ledger names the runtime-context rows',
    )
    /**
     * The table names each row; the policy text itself lives in the details pane, which is where a reader
     * actually reads a snapshot's body. Opening both snapshot rows is therefore part of the claim.
     */
    const snapshotRows = JSON.parse(
      await browser.evaluate(`JSON.stringify(
        Array.from(document.querySelectorAll('#tr-table tbody tr'))
          .map((row, index) => ({ index, text: row.innerText }))
          .filter((row) => row.text.includes('Current runtime context')),
      )`),
    )
    assert.equal(snapshotRows.length, 2, 'the table has one row per snapshot')
    const detailFor = async (index) => {
      await browser.evaluate(`document.querySelectorAll('#tr-table tbody tr')[${index}].click()`)
      assert.ok(await browser.waitFor('document.getElementById("tr-details").hidden === false', 10_000), 'the row opens its details')
      return browser.evaluate('document.getElementById("tr-details").innerText')
    }
    assert.match(await detailFor(snapshotRows[0].index), /Current heddle file policy: workspace-write/, 'the first snapshot still says what the session ran under first')
    assert.match(await detailFor(snapshotRows[1].index), /Current heddle file policy: read-only/, 'and the second records what the mode became')
    const labels = await browser.evaluate('document.getElementById("ledger").innerText')
    assert.ok((labels.match(/runtime context/gi) ?? []).length >= 2, 'each row is attributed to the runtime context, not to a person')
  } finally {
    browser.close()
    await server.close()
  }
})
