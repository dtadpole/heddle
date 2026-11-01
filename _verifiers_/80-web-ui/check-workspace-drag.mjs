import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Workspaces are reordered by dragging them (DSH parity C37, R-developer-eight-5).
 *
 * DSH's workspace browser makes each workspace header draggable (dsh-client-ui-workspace lib/client.js:1971-1977); a
 * drop lands among the dragged workspace's siblings only (client.js:3155), before or after the section by which half of
 * it the pointer is over (client.js:3001-3004), and asks the host for workspace/insertBefore with the anchor that
 * results (client.js:3120-3138); the host keeps the order (dsh-workspace lib/index.js:473-499), so a reload shows it.
 * Judged in a browser with the events a pointer drag dispatches, and over HTTP for what the host stored.
 */

const CAPABILITY = 'the Web UI'

/** Spawn heddle web on a free port and resolve with its URL once it prints one. */
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

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('a workspace dragged onto a sibling lands before or after it, the host keeps the order, and a reload shows it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('workspace-drag')
  const folders = Object.fromEntries(['one', 'two', 'three'].map((name) => [name, fixtureDir(`workspace-drag-${name}`)]))
  const child = join(folders.one, 'child')
  const loose = fixtureDir('workspace-drag-loose')
  mkdirSync(child, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const titles = {}
    for (const path of [folders.one, folders.two, folders.three, child]) {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      titles[added.body.record.id] = added.body.record.title
    }
    const label = (path) => path.split('/').filter(Boolean).pop()
    const [one, two, three] = [folders.one, folders.two, folders.three].map(label)
    /** A session where no workspace is registered, so Ungrouped is drawn too. */
    const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'work in the loose folder', folder: loose }) })
    assert.equal(turn.status, 200, `a turn ran in an unregistered folder (${turn.status})`)
    const stored = async () =>
      ((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? [])
        .filter((view) => view.origin !== 'auto' && view.parent === null)
        .map((view) => titles[view.id])

    browser = await openBrowser()
    const top = `JSON.stringify([...document.querySelectorAll('#tree > li')].map((li) => li.querySelector(':scope > .row .label').textContent))`
    const ready = async () => {
      await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
      await browser.waitFor(`document.querySelectorAll('#tree > li[data-kind="workspace"]').length === 3`, 15_000)
    }
    /**
     * Drag one header onto another section with the events a pointer drag dispatches: dragstart on the source header,
     * dragenter and dragover on the target (at its top or bottom edge), drop when it was accepted, dragend.
     */
    const drag = (source, target, edge) => `(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const headerOf = (text) => [...document.querySelectorAll('#tree li > .row')].find((row) => row.querySelector('.label')?.textContent === text)
      const from = headerOf(${JSON.stringify(source)})
      const to = headerOf(${JSON.stringify(target)})
      if (from === undefined || to === undefined) return JSON.stringify({ error: 'rows not found' })
      const section = to.closest('li').getBoundingClientRect()
      const at = { clientX: Math.round(section.left + section.width / 2), clientY: Math.round(${JSON.stringify(edge)} === 'top' ? section.top + 3 : section.bottom - 3) }
      const dataTransfer = new DataTransfer()
      const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...at }))
      const draggable = from.draggable
      fire(from, 'dragstart')
      fire(to, 'dragenter')
      const accepted = !fire(to, 'dragover')
      const marker = to.closest('li').dataset.workspaceDrop ?? null
      if (accepted) fire(to, 'drop')
      fire(from, 'dragend')
      await wait(1200)
      return JSON.stringify({ draggable, accepted, marker, left: document.querySelectorAll('#tree li[data-workspace-drop]').length })
    })()`

    await browser.goto(server.url)
    await ready()
    const before = JSON.parse(await browser.evaluate(top))
    assert.deepEqual(before, [three, two, one, 'Ungrouped'], `newest workspace first, Ungrouped last\nsaw: ${JSON.stringify(before)}`)
    const handles = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree > li')].map((li) => li.querySelector(':scope > .row').draggable))`))
    assert.deepEqual(handles, [true, true, true, false], 'each workspace header is draggable, Ungrouped is not')

    /** The oldest workspace dragged onto the top edge of the newest lands before it. */
    const first = JSON.parse(await browser.evaluate(drag(one, three, 'top'), 15_000))
    assert.equal(first.error, undefined, `the rows were found\nsaw: ${JSON.stringify(first)}`)
    assert.equal(first.accepted, true, 'a sibling section accepts the drag')
    assert.equal(first.marker, 'before', 'and draws the line on the half it would land on')
    assert.equal(first.left, 0, 'the line is gone once the drag ends')
    await browser.waitFor(`${top} === ${JSON.stringify(JSON.stringify([one, three, two, 'Ungrouped']))}`, 10_000)
    assert.deepEqual(await stored(), [one, three, two], 'the host stored the order')

    /** The lower edge of the last sibling: it goes last. */
    const last = JSON.parse(await browser.evaluate(drag(three, two, 'bottom'), 15_000))
    assert.equal(last.accepted, true)
    assert.equal(last.marker, 'after')
    await browser.waitFor(`${top} === ${JSON.stringify(JSON.stringify([one, two, three, 'Ungrouped']))}`, 10_000)
    assert.deepEqual(await stored(), [one, two, three])

    /** A nested workspace is not a sibling of a top-level one, and Ungrouped is not a place to land. */
    await browser.evaluate(`(() => { const li = [...document.querySelectorAll('#tree > li')].find((each) => each.querySelector(':scope > .row .label').textContent === ${JSON.stringify(one)}); if (li.dataset.open !== 'true') li.querySelector(':scope > .row').click() })()`)
    await browser.waitFor(`[...document.querySelectorAll('#tree > li > ul > li[data-kind="workspace"] > .row .label')].some((label) => label.textContent === 'child')`, 10_000)
    const nested = JSON.parse(await browser.evaluate(drag('child', two, 'top'), 15_000))
    assert.equal(nested.draggable, true, 'a nested workspace header is draggable too')
    assert.equal(nested.accepted, false, `but a top-level section does not take it\nsaw: ${JSON.stringify(nested)}`)
    assert.equal(nested.marker, null, 'and draws no line')
    const ungrouped = JSON.parse(await browser.evaluate(drag(two, 'Ungrouped', 'top'), 15_000))
    assert.equal(ungrouped.accepted, false, 'Ungrouped does not take a workspace')
    assert.deepEqual(await stored(), [one, two, three], 'and neither refused drop moved anything')

    /** A reload draws the host's order. */
    await browser.goto(server.url)
    await ready()
    assert.deepEqual(JSON.parse(await browser.evaluate(top)), [one, two, three, 'Ungrouped'], 'the order survives a reload')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, loose, ...Object.values(folders)]) removeDir(dir)
  }
})

test("another client's workspace reorder redraws an open page in the host's order, without a reload (#136)", async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * GitHub issue #136: a reorder made elsewhere (a second tab, or POST /api/workspaces/insertBefore) never reached an open
   * page, which kept the old order at +3 s and +12 s and showed the host's only after a reload, while a rename or a new
   * workspace made elsewhere was redrawn within seconds. DSH clients follow the host's workspace list, order included
   * (dsh-workspace lib/index.js:479-499 commits the order to the registry state every client hears). The host now
   * pushes a workspace frame for a move, as it does for the other workspace edits, and the page redraws from the host.
   */
  const home = isolatedHome('workspace-drag-pushed')
  const folders = ['one', 'two', 'three'].map((name) => fixtureDir(`workspace-drag-pushed-${name}`))
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const ids = []
    for (const path of folders) {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      ids.push(added.body.record.id)
    }
    const [one, two, three] = folders.map((path) => path.split('/').filter(Boolean).pop())
    const [oneId, , threeId] = ids
    browser = await openBrowser()
    const top = `JSON.stringify([...document.querySelectorAll('#tree > li[data-kind="workspace"]')].map((li) => li.querySelector(':scope > .row .label').textContent))`
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`document.querySelectorAll('#tree > li[data-kind="workspace"]').length === 3`, 15_000)
    assert.deepEqual(JSON.parse(await browser.evaluate(top)), [three, two, one], 'newest workspace first')
    await browser.evaluate('window.__samePage = true')

    /** Another client moves the oldest workspace before the newest. */
    const moved = await api(server.url, cookie, '/api/workspaces/insertBefore', { method: 'POST', body: JSON.stringify({ workspaceId: oneId, beforeWorkspaceId: threeId }) })
    assert.equal(moved.status, 200, `the host takes the move (${JSON.stringify(moved.body)})`)
    assert.ok(
      await browser.waitFor(`${top} === ${JSON.stringify(JSON.stringify([one, three, two]))}`, 5_000),
      `the open page redraws in the host's new order within seconds\nsaw: ${await browser.evaluate(top)}`,
    )
    assert.equal(await browser.evaluate('window.__samePage === true'), true, 'without a reload')

    /** And again: the newest goes last. */
    const last = await api(server.url, cookie, '/api/workspaces/insertBefore', { method: 'POST', body: JSON.stringify({ workspaceId: threeId }) })
    assert.equal(last.status, 200, `the host takes the second move (${JSON.stringify(last.body)})`)
    assert.ok(
      await browser.waitFor(`${top} === ${JSON.stringify(JSON.stringify([one, two, three]))}`, 5_000),
      `the page follows the second move too\nsaw: ${await browser.evaluate(top)}`,
    )
    assert.equal(await browser.evaluate('window.__samePage === true'), true, 'still the same page')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, ...folders]) removeDir(dir)
  }
})
