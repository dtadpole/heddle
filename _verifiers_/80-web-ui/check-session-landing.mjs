import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The page lands on a session a person can see, never on a hidden subagent child.
 *
 * DSH hides `origin: 'subagent'` sessions from the ordinary list and reaches them through their parent, so a
 * page opened with nothing selected must open an ordinary session. The page selects the newest session when
 * nothing is selected yet, and a delegation's child is always newer than its parent: when that default counted
 * the hidden child, every reload after a delegation opened the child's conversation while the sidebar showed
 * only the parent, and a prompt sent from there went to the child (R-developer-five-12).
 *
 * The state is built on disk the way a delegation leaves it — a parent with its conversation, then a newer
 * child with `parentSession`, `origin: 'subagent'` and `delegationDepth` — so the claim does not depend on a
 * model turn, and the page is loaded with nothing selected.
 */

const CAPABILITY = 'the Web UI'
const PARENT = 'session-33333333-3333-4333-8333-333333333333'
const CHILD = 'session-44444444-4444-4444-8444-444444444444'

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  // Handled here; the test reports the rejection at `await server.url` (see check-team-view.mjs).
  url.catch(() => {})
  return {
    url,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('after a delegation the page opens the parent, not the newer hidden child', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('session-landing')
  const work = fixtureDir('session-landing-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  // Written by the TypeScript store, the log format's implementation, from source (see check-team-view.mjs).
  const { SessionStore } = await import('../../src/session/store.ts')
  const sessions = new SessionStore(root)
  try {
    // The parent first, the child last: the child is the newest session, as after every delegation.
    const parent = sessions.create({ id: PARENT, cwd: work, endpoint: 'scripted', model: 'scripted', title: 'parent prompt' })
    sessions.message(parent, { role: 'user', content: [{ type: 'text', text: 'parent prompt' }] })
    sessions.message(parent, { role: 'assistant', content: [{ type: 'text', text: 'parent answer' }] })
    const child = sessions.create({ id: CHILD, cwd: work, endpoint: 'scripted', model: 'scripted', title: 'child task', parentSession: PARENT, origin: 'subagent', delegationDepth: 1 })
    sessions.message(child, { role: 'user', content: [{ type: 'text', text: 'child task' }] })
    sessions.message(child, { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] })

    const server = startServer(home, work, config)
    const browser = await openBrowser()
    try {
      const url = await server.url
      await browser.goto(url)
      await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(work)} }) })`)
      // A fresh load with nothing selected: the page's own default decides what opens.
      await browser.goto(url)
      await browser.waitFor(`document.querySelector('li[data-session-id="${PARENT}"]') !== null`, 15_000)
      await browser.waitFor(`document.getElementById('session-title').textContent.trim() !== 'No session'`, 15_000)
      await browser.waitFor(`document.getElementById('log').textContent.includes('answer')`, 15_000)
      const view = JSON.parse(
        await browser.evaluate(`JSON.stringify({
          title: document.getElementById('session-title').textContent.trim(),
          log: document.getElementById('log').textContent,
          selected: [...document.querySelectorAll('li[data-session-id][aria-selected="true"]')].map((li) => li.dataset.sessionId),
          rows: [...document.querySelectorAll('li[data-session-id]')].map((li) => li.dataset.sessionId),
        })`),
      )
      assert.ok(!view.rows.includes(CHILD), `the child stays out of the sidebar\nrows: ${view.rows.join(', ')}`)
      assert.equal(view.title, 'parent prompt', 'the page opened the parent, not the hidden child')
      assert.ok(view.log.includes('parent answer'), 'and shows the parent’s conversation')
      assert.ok(!view.log.includes('child answer'), 'not the child’s')
      assert.deepEqual(view.selected, [PARENT], 'and the open session is the selected row')
    } finally {
      await browser.close()
      await server.close()
    }
  } finally {
    removeDir(home)
    removeDir(work)
  }
})
