import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session row says when its session waits for a person, and when it finished while another session was open.
 *
 * DSH's rows (`dsh-client-ui-workspace`, Pending interactions): an approval waiting shows the shared warning dot, the
 * row says **Approval** where its age was and *Waiting for approval* on hover; a turn that finished while another
 * session was open shows the done dot until the session is opened (`completionUnread`, `dsh-client-ui-session`); a
 * session that finishes while open is not unread. The page drew the spinner alone, so with session Y open a wait or an
 * answer in session X could not be seen (DSH parity R-developer-seven-3, rows S28 and S29).
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

function startServer(label, stepsFor) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`row-status-${label}`)
      const work = fixtureDir(`row-status-${label}-work`)
      const outsideDir = fixtureDir(`row-status-${label}-outside`)
      const { config } = scriptedConfig({ home, steps: stepsFor(join(outsideDir, 'outside.txt')) })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
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
            work,
            close: async () => {
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
              removeDir(outsideDir)
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
    })()
  })
}

/** X's turn is denied, asks to widen, and waits for the answer; after it, X ends and Y's own turn answers. */
const steps = (outsidePath) => [
  { toolCall: { name: 'bash', arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}` } } },
  {
    toolCall: {
      name: 'bash',
      arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}`, sandbox_permissions: 'danger-full-access', justification: 'row status check' },
    },
  },
  { text: 'x is done' },
  { text: 'y is done' },
]

function call(browser, method, path, body) {
  return browser.evaluate(
    `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }${
      body === undefined ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`
    } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`,
  )
}

/** The row's status mark and trailing cell, or null when the row is not drawn. */
function rowState(browser, id) {
  return browser.evaluate(`(() => {
    const row = document.querySelector('#tree li[data-session-id="${id}"] > .row')
    if (row === null) return null
    const mark = row.querySelector(':scope > .status-dot')
    return { state: mark?.dataset.state ?? 'none', label: mark?.getAttribute('aria-label') ?? null, trailing: row.querySelector('.age')?.textContent ?? null }
  })()`)
}

async function until(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    value = await read()
  }
  return value
}

test('a row shows a waiting approval and an unseen finished turn, as DSH does', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main', steps)
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    assert.ok((await call(browser, 'POST', '/api/workspaces', { path: server.work })).status < 300, 'a workspace is registered')
    const x = (await call(browser, 'POST', '/api/sessions', { branch: server.work, title: 'session x' })).json.session
    const y = (await call(browser, 'POST', '/api/sessions', { branch: server.work, title: 'session y' })).json.session
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    await browser.waitFor(`!!document.querySelector('#tree li[data-session-id="${y}"] > .row')`)
    await browser.evaluate(`document.querySelector('#tree li[data-session-id="${y}"] > .row').click()`)
    await browser.waitFor(`!!document.querySelector('#tree li[data-session-id="${x}"] > .row')`)

    /** X's turn runs in the background while Y is open, as another window or the CLI would run it. */
    void call(browser, 'POST', '/api/turn', { session: x, prompt: 'write outside' })

    await t.test('with Y open, X waiting for an approval shows the warning dot and says Approval', async () => {
      const seen = await until(() => rowState(browser, x), (row) => row?.state === 'warning')
      assert.deepEqual(seen, { state: 'warning', label: 'Waiting for approval', trailing: 'Approval' })
      assert.notEqual((await rowState(browser, y))?.state, 'warning', 'only the waiting session says so')
    })

    await t.test('once answered, X finishes unseen and shows the done dot, with its age back', async () => {
      const pending = (await call(browser, 'GET', '/api/approvals')).json?.requests ?? []
      const request = pending.find((entry) => entry.session === x)
      assert.ok(request, 'the approval is pending for X')
      assert.equal((await call(browser, 'POST', `/api/approvals/${encodeURIComponent(request.id)}`, { outcome: 'rejected' })).status, 200)
      const seen = await until(() => rowState(browser, x), (row) => row?.state === 'done', 15_000)
      assert.equal(seen?.state, 'done', `X is unread: ${JSON.stringify(seen)}`)
      assert.equal(seen?.label, 'Completed')
      assert.notEqual(seen?.trailing, 'Approval', 'the age is shown again')
    })

    await t.test('opening X reads it: the done dot goes', async () => {
      await browser.evaluate(`document.querySelector('#tree li[data-session-id="${x}"] > .row').click()`)
      const seen = await until(() => rowState(browser, x), (row) => row?.state !== 'done')
      assert.notEqual(seen?.state, 'done')
    })

    await t.test('a turn that finishes in the open session is not unread', async () => {
      await call(browser, 'POST', '/api/turn', { session: x, prompt: 'answer while open' })
      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.notEqual((await rowState(browser, x))?.state, 'done')
    })
  } finally {
    await browser.close()
    await server.close()
  }
})
