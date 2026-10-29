import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session row's Rename and Archive say so when the server cannot be reached (R-developer-six-3, DSH parity S81).
 *
 * DSH resolves every call to ok or error and shows the failure: Rename keeps its dialog open with the reason, Pin and
 * Unpin raise a warning toast, and a rejected call is logged. Measured on both builds before the fix: with the server
 * stopped under an open page, Rename and Archive changed nothing on screen and left `Failed to fetch` as an unhandled
 * rejection. The check opens the page on a real `heddle web` (the TypeScript build, or the binary through `HEDDLE_BIN`),
 * stops the server, uses each action from the row's menu, and reads the sidebar note and the page's unhandled
 * rejections.
 */

const CAPABILITY = 'the Web UI'
const SESSION = 'session-44444444-4444-4444-8444-444444444444'

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

/** Use one item of the session row's menu, then read what the page shows; the note is read after two seconds. */
const useRowAction = (label) => `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const row = document.querySelector('li[data-session-id="${SESSION}"]')
  const button = row?.querySelector(':scope > .row .menu-wrap > button')
  if (!button) return JSON.stringify({ error: 'no row menu', html: row ? row.outerHTML.slice(0, 1500) : 'no row' })
  button.click()
  await sleep(300)
  const item = [...row.querySelectorAll('.menu [role=menuitem], .menu button')].find((element) => element.textContent.trim() === ${JSON.stringify(label)})
  if (!item) return JSON.stringify({ error: 'no menu item ${label}', items: [...row.querySelectorAll('.menu [role=menuitem], .menu button')].map((element) => element.textContent.trim()) })
  item.click()
  await sleep(2000)
  const note = document.getElementById('tree-note')
  return JSON.stringify({ note: note && !note.hidden ? note.textContent : '', rejections: window.__rejections.slice() })
})()`

test('with the server down, Rename and Archive show their failure instead of failing silently', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('row-errors')
  const work = fixtureDir('row-errors-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  // The session is written by the TypeScript store, imported from the source so a binary-only lane can build it.
  const { SessionStore } = await import('../../src/session/store.ts')
  const sessions = new SessionStore(join(home, 'sessions'))
  const session = sessions.create({ id: SESSION, cwd: work, endpoint: 'scripted', model: 'scripted' })
  sessions.message(session, { role: 'user', content: [{ type: 'text', text: 'a session to rename and archive' }] })
  sessions.append(session, { type: 'assistant/completed', text: 'idle' })

  const server = startServer(home, work, config)
  const browser = await openBrowser()
  try {
    const url = await server.url
    await browser.goto(url)
    await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(work)} }) })`)
    await browser.goto(url)
    // The tree's row carries the menu (the flat list's rows do not); a first visit opens the workspace that holds it.
    await browser.waitFor(`document.querySelector('li[data-session-id="${SESSION}"] > .row .menu-wrap > button') !== null`, 15_000)
    // The rename prompt is answered, and every unhandled rejection is kept for the verdict.
    await browser.evaluate(`(() => {
      window.__rejections = []
      window.addEventListener('unhandledrejection', (event) => window.__rejections.push(String(event.reason && event.reason.message || event.reason)))
      window.prompt = () => 'renamed while the server is down'
      window.confirm = () => true
      return true
    })()`)

    await server.close()

    const rename = JSON.parse(await browser.evaluate(useRowAction('Rename'), 15_000))
    const archive = JSON.parse(await browser.evaluate(useRowAction('Archive session'), 15_000))
    assert.equal(rename.error, undefined, JSON.stringify(rename))
    assert.equal(archive.error, undefined, JSON.stringify(archive))
    assert.match(rename.note, /^could not rename that session: /, `Rename shows its failure; the page showed ${JSON.stringify(rename)}`)
    assert.match(archive.note, /^could not archive that session: /, `Archive shows its failure; the page showed ${JSON.stringify(archive)}`)
    assert.deepEqual(archive.rejections, [], 'neither action leaves an unhandled rejection')
  } finally {
    await browser.close()
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})
