import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * An archived session in the tree cannot be opened until it is restored, as in DSH (live-testing draft developer-six-7).
 *
 * DSH's workspace browser guards opening (dsh-client-ui-workspace lib/client.js:3532-3538, guardedOpen): an archived row
 * raises "Archived sessions cannot be opened. Unarchive it to view." (toast.archivedNotOpenable, :4934) and opens nothing,
 * and the row carries that sentence as its aria-description (:2279); Rename, Fork and Unarchive stay in its menu (README,
 * "Visible archived rows are grayed and carry an accessible explanation"). Measured before: with All conversations shown,
 * clicking an archived row opened it, with its title in the header and a working composer.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
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

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

test('an archived session row says it cannot be opened until restored, and clicking it opens nothing', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('archived-readonly')
  const root = fixtureDir('archived-readonly-repo')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal((await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })).status, 200, 'the workspace is registered')
    const live = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title: 'a live session' }) })
    const kept = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title: 'a put-away session' }) })
    assert.equal(live.status, 200)
    assert.equal(kept.status, 200)
    const archived = await api(server.url, cookie, `/api/sessions/${kept.body.session}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
    assert.equal(archived.status, 200, `the second session is archived (${JSON.stringify(archived.body)})`)

    await browser.goto(server.url)
    await browser.evaluate(`localStorage.setItem('heddle.tree.archived.v1', 'show')`)
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const rowOf = (label) => `[...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.textContent.includes(${JSON.stringify(label)}))`
    assert.ok(await browser.waitFor(`${rowOf('a put-away session')} !== undefined && ${rowOf('a live session')} !== undefined`, 15_000), 'All conversations draws both rows')

    /** The live row opens, so the guard is judged against a page that opens sessions at all. */
    await browser.evaluate(`${rowOf('a live session')}.querySelector(':scope > .row').click()`)
    assert.ok(await browser.waitFor(`document.getElementById('session-title').textContent.includes('a live session')`, 10_000), 'a live row opens its session')

    const before = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const li = ${rowOf('a put-away session')}
        return { archived: li.dataset.archived ?? null, description: li.getAttribute('aria-description') }
      })())`),
    )
    assert.equal(before.archived, 'true', 'the archived row says so on the item')
    assert.equal(before.description, 'Archived sessions cannot be opened. Unarchive it to view.', "and explains, in DSH's words, that it cannot be opened")

    await browser.evaluate(`${rowOf('a put-away session')}.querySelector(':scope > .row').click()`)
    const said = await browser.waitFor(
      `[...document.querySelectorAll('#tree-note, #archive-notice')].some((node) => !node.hidden && node.textContent.includes('Archived sessions cannot be opened. Unarchive it to view.'))`,
      5_000,
    )
    assert.ok(said, 'clicking it says why it will not open')
    const after = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        title: document.getElementById('session-title').textContent,
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.textContent.trim()),
      })`),
    )
    assert.match(after.title, /a live session/, `and nothing opens: the open session stays the live one\nsaw: ${JSON.stringify(after)}`)
    assert.ok(after.selected.every((text) => !text.includes('a put-away session')), 'and the archived row is not selected')
  } finally {
    await browser.close()
    server.kill()
    removeDir(home)
    removeDir(root)
  }
})
