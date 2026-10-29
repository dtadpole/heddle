import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, runCli, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session that vanished under an open page opens to an error state, not to a blank start page (R-developer-six-4,
 * DSH parity S84).
 *
 * DSH's Chat shows "Failed to load history: {message} ({code})" when a session's history cannot be read, and its
 * composer reads "Session unavailable". Measured on both builds before the fix: a session whose files were removed
 * after the tree was drawn, clicked in that stale tree, gave the title "No session" and the blank "Start a
 * conversation" page, with the stale row still selected and the server's 404 shown nowhere. The check draws the
 * tree on a real `heddle web` (the TypeScript build, or the binary through `HEDDLE_BIN`), moves one session's files
 * out of the store, clicks its row, and reads the page.
 */

const CAPABILITY = 'the Web UI'
const KEPT = 'session-55555555-5555-4555-8555-555555555555'
const GONE = 'session-66666666-6666-4666-8666-666666666666'

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
  url.catch(() => {})
  return {
    url,
    logs: () => output,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('a session removed under an open page opens to an error state, and its stale row is let go', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('stale-session')
  const work = fixtureDir('stale-session-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  // The sessions are written by the TypeScript store, imported from the source so a binary-only lane can build them.
  const { SessionStore } = await import('../../src/session/store.ts')
  const sessions = new SessionStore(root)
  for (const id of [GONE, KEPT]) {
    const session = sessions.create({ id, cwd: work, endpoint: 'scripted', model: 'scripted' })
    sessions.message(session, { role: 'user', content: [{ type: 'text', text: `the ${id === GONE ? 'doomed' : 'kept'} session` }] })
    sessions.append(session, { type: 'assistant/completed', text: 'idle' })
  }

  const server = startServer(home, work, config)
  const browser = await openBrowser()
  try {
    const url = await server.url
    await browser.goto(url)
    await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(work)} }) })`)
    await browser.goto(url)
    await browser.waitFor(`document.querySelector('li[data-session-id="${GONE}"] > .row') !== null`, 15_000)

    // The session leaves the store while the page still draws its row: its log and its metadata are moved away.
    const log = transcriptFile(join(root, GONE))
    const gone = join(home, 'gone')
    mkdirSync(gone, { recursive: true })
    renameSync(log, join(gone, basename(log)))
    renameSync(join(dirname(log), `${GONE}.json`), join(gone, `${GONE}.json`))

    const seen = JSON.parse(
      await browser.evaluate(`(async () => {
        document.querySelector('li[data-session-id="${GONE}"] > .row').click()
        await new Promise((resolve) => setTimeout(resolve, 2500))
        const empty = document.getElementById('empty-state')
        const row = document.querySelector('li[data-session-id="${GONE}"]')
        return JSON.stringify({
          title: document.getElementById('session-title').textContent,
          log: document.getElementById('log').innerText,
          emptyState: empty !== null && !empty.hidden,
          placeholder: document.querySelector('#prompt textarea').placeholder,
          staleRowSelected: row !== null && (row.getAttribute('aria-selected') === 'true' || row.querySelector(':scope > .row')?.getAttribute('aria-selected') === 'true'),
        })
      })()`, 15_000),
    )
    assert.match(seen.log, /Failed to load history: .*\(404\)/, `the page says the history could not be loaded and why; it showed ${JSON.stringify(seen)}`)
    assert.equal(seen.emptyState, false, 'not the blank start page')
    assert.equal(seen.placeholder, 'Session unavailable', 'the composer says the session is unavailable, as DSH\'s does')
    assert.equal(seen.staleRowSelected, false, 'the stale row is not left selected')
  } finally {
    await browser.close()
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})
