import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Unarchive and stop-and-archive, judged in a browser through the controls a person uses (R-developer-eight-14, -13).
 *
 * DSH's sidebar (`dsh-client-ui-workspace`): an archived session comes back from the **Archived only** filter through
 * its row menu's `Unarchive session`, and from **search**, where an archived result carries an `Unarchive session`
 * button and choosing the result explains that it cannot be opened ("Archived sessions cannot be opened. Unarchive it
 * to view.") without clearing the query or navigating. Archiving a session with running work asks first: the Host
 * refuses the plain archive and names the work, and the stop-and-archive dialog lists it ("The turn in progress", and
 * its running bash call as "1 background job: sleep 40"),
 * Cancel leaves it running, and Stop and archive stops it, archives it and shows a notice with `undo`.
 *
 * The row menu is judged where it was found wanting: on 29 Oct its right part lay under the conversation panel
 * ("Renai", "Unarc"), so a click on the right of an item missed. Every item is hit-tested at its right edge here.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`archive-${label}`)
  const work = fixtureDir(`archive-${label}-work`)
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config, HOME: home } },
  )
  return {
    home,
    work,
    script,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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

/** The token in the printed URL, exchanged for the cookie everything else uses. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

/** One API call, with the cookie, answering parsed JSON. */
async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('an archived session is restored from Archived only and from search, and a running one asks before it is stopped and archived', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page')
  const browser = await openBrowser({ width: 1440, height: 900 })
  const pending = []
  /** A session's own row in the tree, and an expression for its element. */
  const rowSelector = (id) => `#tree li[data-kind=session][data-session-id="${id}"] > .row`
  const el = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const box = async (expression) =>
    JSON.parse(
      await browser.evaluate(`JSON.stringify((() => { const node = ${expression}; if (!node) return null; node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom } })())`),
    )
  const pointer = (type, x, y) => browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  const click = async (x, y) => {
    await pointer('mouseMoved', x, y)
    await pointer('mousePressed', x, y)
    await pointer('mouseReleased', x, y)
  }
  const visibleItems = `[...document.querySelectorAll('#tree .menu:not([hidden]) [role=menuitem]')]`
  /**
   * Wait for the tree to stop redrawing: a redraw re-opens remembered groups one level at a time, and a row drawn by
   * the first pass is replaced by the next, taking an open menu with it.
   */
  const settle = async () => {
    let last = ''
    for (let quiet = 0, attempt = 0; quiet < 3 && attempt < 40; attempt += 1) {
      const now = await browser.evaluate(`document.getElementById('tree').innerHTML.length + ':' + document.querySelectorAll('#tree li').length`)
      quiet = now === last ? quiet + 1 : 0
      last = now
      await new Promise((done) => setTimeout(done, 200))
    }
  }
  /** Open a session row's `…` menu the way a pointer does: hover the row, then press the control it reveals. */
  const openRowMenu = async (id) => {
    await settle()
    const row = await box(el(rowSelector(id)))
    assert.ok(row, `the row of ${id} is drawn`)
    await pointer('mouseMoved', row.x, row.y)
    await browser.waitFor(`${el(`${rowSelector(id)} [aria-haspopup]`)}?.offsetParent !== null`, 5_000)
    const trigger = await box(el(`${rowSelector(id)} [aria-haspopup]`))
    await click(trigger.x, trigger.y)
    await browser.waitFor(`${visibleItems}.length > 0`, 5_000)
    return JSON.parse(
      await browser.evaluate(
        `JSON.stringify(${visibleItems}.map((item) => { const r = item.getBoundingClientRect(); const missed = []; for (let x = r.left + 4; x <= r.right - 4; x += 4) { const probe = document.elementFromPoint(x, r.top + r.height / 2); if (!item.contains(probe)) missed.push([Math.round(x), probe === null ? null : probe.tagName + '.' + probe.className]) } return { label: item.textContent.trim(), right: Math.round(r.right), reachable: missed.length === 0, missed: missed.slice(0, 3) } }))`,
      ),
    )
  }
  /** Choose a menu item by pressing its **right** part — the part the conversation panel used to cover. */
  const chooseItem = async (label) => {
    const item = await box(`${visibleItems}.find((entry) => entry.textContent.trim() === ${JSON.stringify(label)})`)
    assert.ok(item, `the menu offers ${label}`)
    await click(item.right - 10, item.y)
  }
  const chooseView = async (label) => {
    await browser.evaluate(`document.querySelector('#view-options button').click()`)
    await browser.waitFor(`[...document.querySelectorAll('#view-options [role^=menuitem]')].some((entry) => entry.textContent.trim() === ${JSON.stringify(label)})`, 5_000)
    await browser.evaluate(`[...document.querySelectorAll('#view-options [role^=menuitem]')].find((entry) => entry.textContent.trim() === ${JSON.stringify(label)}).click()`)
  }
  const search = (value) =>
    browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  /** The archive notice's words once a notice of `kind` is showing, or `null` if none shows within 10 s. */
  const noticeText = async (kind) => {
    const shown = await browser
      .waitFor(`document.getElementById('archive-notice').hidden === false && document.getElementById('archive-notice').dataset.kind === ${JSON.stringify(kind)}`, 10_000)
      .catch(() => false)
    return shown ? browser.evaluate(`document.getElementById('archive-notice').textContent`) : null
  }
  try {
    const cookie = await cookieFor(server.url)
    const meta = async (id) => ((await api(server.url, cookie, '/api/sessions')).body ?? []).find((entry) => entry.id === id)
    const until = async (probe, ms = 15_000) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const value = await probe()
        if (value) return value
        await new Promise((done) => setTimeout(done, 200))
      }
      return undefined
    }
    assert.equal((await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })).status, 200, 'the workspace registers')
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'kestrel quarterly figures', folder: server.work }),
    }).then((response) => response.text())
    const kestrel = /"session":"(session-[^"]+)"/.exec(turn)?.[1]
    assert.ok(kestrel, `the turn names its session\n${turn.slice(0, 300)}`)
    assert.equal((await api(server.url, cookie, `/api/sessions/${kestrel}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })).status, 200)

    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 })
    /** The page's own requests, so a failure can say what the controls asked the server. */
    await browser.evaluate(`(() => { window.__posts = []; const send = window.fetch.bind(window); window.fetch = async (input, init) => { const response = await send(input, init); if (init?.method === 'POST') window.__posts.push([String(input), init.body ?? null, response.status]); return response } })()`)

    /** Archived only: the row is there, and its menu restores it — reachable across the whole width of every item. */
    await chooseView('Archived only')
    assert.ok(await browser.waitFor(`${el(rowSelector(kestrel))} !== null`, 10_000), 'Archived only draws the archived session')
    const items = await openRowMenu(kestrel)
    /** DSH's `session-id` item (order 450) has no archived guard, so Copy Session ID ends an archived row's menu too (row C20). */
    assert.deepEqual(items.map((item) => item.label), ['Rename', 'Fork session', 'Unarchive session', 'Copy Session ID'], `an archived row's menu, DSH's items\nsaw: ${JSON.stringify(items)}`)
    assert.deepEqual(items.filter((item) => !item.reachable).map((item) => item.label), [], `every item can be pressed across its whole width, nothing lies over the menu\nsaw: ${JSON.stringify(items)}`)
    await chooseItem('Unarchive session')
    assert.equal(await until(async () => (await meta(kestrel))?.archived !== true), true, 'Unarchive session restores it')
    assert.ok(await browser.waitFor(`${el(rowSelector(kestrel))} === null`, 10_000), 'and it leaves the Archived only view')

    /** Back to the default view, archived again from the row: no question for a quiet session, and DSH's notice. */
    await chooseView('Hide archived')
    assert.ok(await browser.waitFor(`${el(rowSelector(kestrel))} !== null`, 10_000), 'the restored session is an ordinary row again')
    const quietItems = await openRowMenu(kestrel)
    await chooseItem('Archive session')
    const pageState = async () =>
      browser.evaluate(
        `JSON.stringify({ note: document.getElementById('tree-note').textContent, dialog: document.getElementById('session-archive').open, notice: document.getElementById('archive-notice').textContent, menu: ${visibleItems}.map((entry) => entry.textContent.trim()), posts: window.__posts ?? [] })`,
      )
    assert.equal(
      await until(async () => (await meta(kestrel))?.archived === true),
      true,
      `a quiet session archives at once\nmenu: ${JSON.stringify(quietItems)}\npage: ${await pageState()}`,
    )
    assert.equal(await noticeText('archived'), 'Session archived. You can undo or filter archived sessions', "and DSH's notice offers undo and the filter")

    /** Search: an archived result carries Unarchive, and choosing the result explains rather than opens. */
    const opened = await browser.evaluate(`document.getElementById('session-title').textContent`)
    await search('kestrel')
    assert.ok(await browser.waitFor(`document.querySelector('#search-results .hit[data-archived="true"]') !== null`, 10_000), 'the archived session is a search result, marked archived')
    const hit = JSON.parse(
      await browser.evaluate(
        `JSON.stringify((() => { const hit = document.querySelector('#search-results .hit[data-archived="true"]'); return { description: hit.getAttribute('aria-description'), buttons: [...hit.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')) } })())`,
      ),
    )
    assert.equal(hit.description, 'Archived sessions cannot be opened. Unarchive it to view.', 'it says why it cannot be opened')
    assert.deepEqual(hit.buttons, ['Unarchive session'], 'and offers Unarchive session')
    const hitBox = await box(`document.querySelector('#search-results .hit[data-archived="true"] .hit-title')`)
    await click(hitBox.x, hitBox.y)
    assert.ok(await browser.waitFor(`document.getElementById('archive-notice').hidden === false && document.getElementById('archive-notice').dataset.kind === 'archivedNotOpenable'`, 5_000), 'choosing it shows a notice')
    assert.equal(await noticeText('archivedNotOpenable'), 'Archived sessions cannot be opened. Unarchive it to view.', "in DSH's words")
    assert.equal(await browser.evaluate(`document.getElementById('session-search').value`), 'kestrel', 'the query stays')
    assert.equal(await browser.evaluate(`document.getElementById('search-results').hidden`), false, 'and so do the results')
    assert.equal(await browser.evaluate(`document.getElementById('session-title').textContent`), opened, 'and nothing was opened')
    const restore = await box(`document.querySelector('#search-results .hit[data-archived="true"] .hit-unarchive')`)
    await click(restore.x, restore.y)
    assert.equal(await until(async () => (await meta(kestrel))?.archived !== true), true, 'Unarchive session in the result restores it')
    assert.ok(await browser.waitFor(`document.querySelector('#search-results .hit[data-archived="true"]') === null && document.querySelectorAll('#search-results .hit').length === 1`, 10_000), 'and the result redraws as an ordinary one')
    await search('')

    /** A running session: the archive asks first, lists the work, Cancel keeps it running, Stop and archive stops it. */
    writeFileSync(server.script, `${JSON.stringify({ steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 40', timeoutMs: 60000 } } }, { text: 'slept' }] }, null, 2)}\n`)
    const long = fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'osprey long job', folder: server.work }),
    }).then((response) => response.text())
    pending.push(long)
    const osprey = (await until(async () => ((await api(server.url, cookie, '/api/sessions')).body ?? []).find((entry) => entry.running === true)))?.id
    assert.ok(osprey, 'the long turn is running')
    await browser.goto(server.url.split('?')[0])
    await browser.waitFor(`${el(rowSelector(osprey))} !== null`, 10_000)
    await openRowMenu(osprey)
    await chooseItem('Archive session')
    assert.ok(await browser.waitFor(`document.getElementById('session-archive').open`, 10_000), 'archiving a running session asks first')
    const dialog = JSON.parse(
      await browser.evaluate(
        `JSON.stringify({ title: document.getElementById('session-archive-title').textContent, desc: document.getElementById('session-archive-desc').textContent, work: [...document.querySelectorAll('#session-archive-activity li')].map((entry) => entry.textContent), action: document.getElementById('session-archive-confirm').textContent })`,
      ),
    )
    const title = (await meta(osprey))?.title ?? ''
    assert.equal(dialog.title, 'Stop and archive this session?', "DSH's question")
    assert.equal(
      dialog.desc,
      `“${title}” still has work in progress. Archiving stops it first; you can restore the session later from the “All conversations (show archived)” filter in the sidebar, and the stopped work will not resume on its own.`,
      'naming the session and the way back',
    )
    /**
     * The work the server named, family by family: the turn, and its running bash call, which is a job as well (dsh-tool-bash
     * registers every call's process with `ctx.jobs` as it starts, lib/index.js:210-216). Judged as a set: DSH's order is
     * turn, job, subagent, schedule, and the server's order, with the schedule family, is fixed in
     * hd/developer-eight-archive-activity (R-developer-eight-13).
     */
    assert.deepEqual([...dialog.work].sort(), ['1 background job: sleep 40', 'The turn in progress'], `and listing the work the server named\nsaw: ${JSON.stringify(dialog.work)}`)
    assert.equal(dialog.action, 'Stop and archive')
    await browser.evaluate(`[...document.querySelectorAll('#session-archive [data-ws-close]')].find((button) => button.textContent.trim() === 'Cancel').click()`)
    assert.equal(await browser.evaluate(`document.getElementById('session-archive').open`), false, 'Cancel closes it')
    const kept = await meta(osprey)
    assert.equal(kept?.running, true, 'and the session keeps running')
    assert.notEqual(kept?.archived, true, 'unarchived')

    await openRowMenu(osprey)
    await chooseItem('Archive session')
    await browser.waitFor(`document.getElementById('session-archive').open`, 10_000)
    await browser.evaluate(`document.getElementById('session-archive-confirm').click()`)
    assert.ok(await browser.waitFor(`!document.getElementById('session-archive').open`, 10_000), 'Stop and archive closes the dialog')
    assert.equal(await until(async () => (await meta(osprey))?.archived === true), true, 'the session is archived')
    assert.equal(await until(async () => (await meta(osprey))?.running === false), true, 'and its turn stopped')
    assert.equal(await noticeText('stoppedAndArchived'), 'Session stopped and archived. You can undo or filter archived sessions', "with DSH's stop-and-archive notice")
    await browser.evaluate(`document.querySelector('#archive-notice button[data-action="undo"]').click()`)
    assert.equal(await until(async () => (await meta(osprey))?.archived !== true), true, 'undo restores it')
    assert.equal((await meta(osprey))?.running, false, 'without resuming the stopped work')
  } finally {
    browser.close()
    await server.close()
    await Promise.allSettled(pending)
  }
})
