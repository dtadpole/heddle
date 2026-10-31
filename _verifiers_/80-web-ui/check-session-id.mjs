import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Copy Session ID, the last item of a session row's menu (DSH parity row C20, R-developer-eight-23).
 *
 * DSH's session-row menu ends with Copy Session ID (dsh-client-ui-workspace lib/client.js:4730-4740, order 450, after
 * Archive). It closes the menu, writes the complete id and shows the Toast "Session ID copied". When the clipboard
 * refuses, it shows "Copy failed. Try again." as a warning (lib/client.js:4590-4605, 4929-4931). Phase A found the
 * menu held only Pin session, Rename, Fork session and Archive session on both builds.
 *
 * The clipboard is replaced in the page by a recorder before the click. The claim is what the page writes and says,
 * and a headless browser's own clipboard is not the page's to judge.
 */

const CAPABILITY = 'the Web UI'

/** Spawn the web server on a free port and resolve with its URL once it prints one. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
  })
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('the session row menu ends with Copy Session ID, which copies the full id and says so, or says the copy failed', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('session-id')
  const work = fixtureDir('session-id-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  let server
  let browser
  try {
    server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', `${home}/sessions`], {
      HEDDLE_HOME: home,
      HEDDLE_CONFIG: config,
    })
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    assert.equal((await post('/api/workspaces', { path: work })).status, 200, 'the folder is a workspace')
    const made = await post('/api/sessions', { branch: work, title: 'copy my id' })
    assert.equal(made.status, 200, `a session is made (${JSON.stringify(made.body)})`)
    const id = String(made.body.session)

    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    /** Open the row's menu, record what the clipboard is given, press the last item, and read the Toast. */
    const press = (refuse) =>
      browser.evaluate(
        `(async () => {
          const wait = (ms) => new Promise((done) => setTimeout(done, ms))
          const written = []
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text) => { if (${refuse ? 'true' : 'false'}) throw new Error('refused'); written.push(text) } },
          })
          let row
          for (let attempt = 0; attempt < 40 && row === undefined; attempt += 1) {
            row = [...document.querySelectorAll('#tree li[data-kind="session"] > .row')].find((entry) => entry.querySelector('.label')?.textContent === 'copy my id')
            if (row === undefined) {
              const group = [...document.querySelectorAll('#tree li[data-kind="workspace"]')].find((li) => li.dataset.open !== 'true')
              if (group !== undefined) group.querySelector(':scope > .row')?.click()
              await wait(150)
            }
          }
          if (row === undefined) return JSON.stringify({ error: 'no row for the session' })
          const menuButton = [...row.querySelectorAll('button')].find((button) => button.textContent === '…')
          if (menuButton === undefined) return JSON.stringify({ error: 'the row carries no menu' })
          menuButton.click()
          await wait(200)
          const items = [...document.querySelectorAll('#tree .menu:not([hidden]) button')]
          const labels = items.map((button) => button.textContent.trim())
          const last = items[items.length - 1]
          const marked = Boolean(last?.querySelector('.menu-glyph svg'))
          last?.click()
          await wait(300)
          const toast = document.getElementById('session-toast')
          return JSON.stringify({
            labels,
            marked,
            menuClosed: document.querySelector('#tree .menu:not([hidden])') === null,
            written,
            toast: toast === null ? null : { text: toast.textContent, role: toast.getAttribute('role'), tone: toast.dataset.tone, top: Math.round(toast.getBoundingClientRect().top) },
          })
        })()`,
        20_000,
      )

    const copied = JSON.parse(await press(false))
    assert.equal(copied.error, undefined, `the row and its menu are there\nsaw: ${JSON.stringify(copied)}`)
    assert.equal(copied.labels.at(-1), 'Copy Session ID', `the menu ends with DSH's item\nsaw: ${copied.labels.join(', ')}`)
    assert.deepEqual(copied.labels, ['Pin session', 'Rename', 'Fork session', 'Archive session', 'Copy Session ID'], 'after the four it already had')
    assert.equal(copied.marked, true, 'and it carries its mark, as every menu item does')
    assert.equal(copied.menuClosed, true, 'pressing it closes the menu')
    assert.deepEqual(copied.written, [id], 'and the complete session id is what the clipboard is given')
    assert.equal(copied.toast?.text, 'Session ID copied', `DSH's success notice is shown\nsaw: ${JSON.stringify(copied.toast)}`)
    assert.equal(copied.toast?.role, 'alert', 'announced as DSH announces a Toast')
    assert.equal(copied.toast?.tone, 'success')

    const refused = JSON.parse(await press(true))
    assert.deepEqual(refused.written, [], 'a refused clipboard holds nothing')
    assert.equal(refused.toast?.text, 'Copy failed. Try again.', `and the page says the copy failed rather than claiming it\nsaw: ${JSON.stringify(refused.toast)}`)
    assert.equal(refused.toast?.tone, 'warning')
  } finally {
    browser?.close()
    server?.kill()
    removeDir(home)
    removeDir(work)
  }
})
