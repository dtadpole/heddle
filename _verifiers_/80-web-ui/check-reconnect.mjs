import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A change that reached the server just before the connection dropped shows once the connection is back (#91).
 *
 * DSH re-acquires the Workspace and Session baselines on every new connection: its connection layer publishes
 * `connected` and calls `onConnected` only after the stream's `ready` item (dsh-client-connection lib/client.browser.js
 * :1094-1100, README "Connection generation"), a browser `offline` publishes `disconnected` and the next `online`
 * reconnects at the 500 ms tier (:989-999, :1359-1376), and the Session list and the Workspace state are read again there
 * (dsh-api-session-controller lib/client.js:4289-4296, :3570-3584; dsh-api-workspace-controller lib/client.js:473-490,
 * :183-194). #91: on both builds a rename or a workspace delete the server applied while the network went away left the
 * tree on the old title and the deleted workspace after the network came back, the note "could not read the workspaces:
 * Failed to fetch" stayed, and the console logged an unhandled rejection; only a reload showed the truth.
 *
 * The cut lands exactly where the issue's did: the page's own request reaches the server and its answer is held in the
 * page (a wrapper over `fetch` that only delays a response that already arrived), the network is cut, and only then is
 * the answer handed to the page, which closes its dialog and tries to redraw. Two cuts: the browser going offline and
 * back online (`Network.emulateNetworkConditions`, DevTools' Offline), and the server going away and coming back on the
 * same port, which the page's `EventSource` reconnects to on its own (its new `ready` frame is DSH's new generation).
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` and resolve with its URL and a way to stop it that waits for the exit. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise((done) => child.on('exit', () => done()))
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({
          url: match[1],
          stop: async () => {
            child.kill('SIGKILL')
            await exited
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

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
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

/**
 * Hold the answer of the page's next write whose URL contains `window.__holdFor`, after its body has arrived: the server
 * has applied it, and the page has not been told. `window.__landed` counts the held answers, `window.__release()` hands
 * them over. And record every unhandled rejection, which is what #91's console showed.
 */
const INSTRUMENT = `(() => {
  window.__unhandled = []
  window.addEventListener('unhandledrejection', (event) => window.__unhandled.push(String(event.reason && event.reason.message ? event.reason.message : event.reason)))
  window.__holdFor = null
  window.__landed = 0
  window.__held = []
  window.__release = () => { for (const release of window.__held.splice(0)) release(); return true }
  const original = window.fetch
  window.fetch = async (input, init) => {
    const response = await original(input, init)
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const url = String(input instanceof Request ? input.url : input)
    if (method !== 'GET' && window.__holdFor !== null && url.includes(window.__holdFor)) {
      window.__holdFor = null
      await response.clone().text()
      window.__landed += 1
      await new Promise((release) => window.__held.push(release))
    }
    return response
  }
  return true
})()`

const OFFLINE = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
const ONLINE = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }

const sessionRow = (id) => `document.querySelector('#tree li[data-kind="session"][data-session-id="${id}"]')`
const sessionLabel = (id) => `(${sessionRow(id)}?.querySelector(':scope > .row .label')?.textContent ?? null)`
const workspaceRow = (path) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(path)})`

/** Open a row's `…` menu and choose one item. */
async function choose(browser, rowExpression, item) {
  const chosen = await browser.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms))
    const row = ${rowExpression}
    const trigger = row?.querySelector('[aria-haspopup]')
    if (trigger === undefined || trigger === null) return 'the row carries no menu'
    trigger.click(); await wait(200)
    const entry = [...document.querySelectorAll('#tree .menu:not([hidden]) [role=menuitem]')].find((node) => node.textContent.trim() === ${JSON.stringify(item)})
    if (entry === undefined) return 'the menu carries no ${item}'
    entry.click()
    return 'chosen'
  })()`)
  assert.equal(chosen, 'chosen', `${item} is chosen from the row's menu`)
}

/** Rename one session through its row's menu and the Rename session dialog. */
async function renameThroughDialog(browser, id, title) {
  await choose(browser, `${sessionRow(id)}?.querySelector(':scope > .row')`, 'Rename')
  assert.ok(await browser.waitFor(`document.getElementById('session-rename').open === true`, 5_000), 'the Rename session dialog opens')
  await browser.evaluate(`(() => {
    const input = document.getElementById('session-rename-input')
    input.value = ${JSON.stringify(title)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('session-rename-confirm').click()
    return true
  })()`)
}

/** Open the workspace row until its sessions are drawn. */
async function openWorkspace(browser, path, until) {
  await browser.evaluate(
    `(async () => {
      for (let attempt = 0; attempt < 40 && !(${until}); attempt += 1) {
        const row = ${workspaceRow(path)}
        if (row !== undefined && row.closest('li').dataset.open !== 'true') row.click()
        await new Promise((done) => setTimeout(done, 250))
      }
      return true
    })()`,
    15_000,
  )
}

test('a rename and a workspace delete the server applied as the browser went offline show once it is back online, with no stale note and nothing left to the console (#91)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('reconnect-offline')
  const outer = fixtureDir('reconnect-offline-outer')
  const inner = join(outer, 'inner')
  mkdirSync(inner, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const register = async (path) => {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      return added.body.record.path
    }
    const outerPath = await register(outer)
    const innerPath = await register(inner)
    const made = async (branch, title) => {
      const answer = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch, title }) })
      assert.equal(answer.status, 200, `created ${title} (${JSON.stringify(answer.body)})`)
      await new Promise((done) => setTimeout(done, 15))
      return answer.body.session
    }
    const moved = await made(inner, 'inner notes')
    const renamed = await made(outer, 'before the cut')
    const kept = await made(outer, 'kept notes')

    const state = () =>
      browser.evaluate(`JSON.stringify({
        online: navigator.onLine,
        note: document.getElementById('tree-note').hidden ? '' : document.getElementById('tree-note').textContent,
        renamed: ${sessionLabel(renamed)},
        innerRow: ${workspaceRow(innerPath)} !== undefined,
        movedRow: ${sessionRow(moved)} !== null,
        renameOpen: document.getElementById('session-rename').open,
        deleteOpen: document.getElementById('workspace-delete').open,
        deleteStatus: document.getElementById('workspace-delete-status').hidden ? null : document.getElementById('workspace-delete-status').textContent,
        landed: window.__landed ?? null,
        unhandled: window.__unhandled ?? null,
      })`)
    const until = async (expression, what, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    /**
     * DevTools' Offline: `emulateNetworkConditions` fails the page's requests and, being the deprecated whole-page form,
     * also moves `navigator.onLine` and fires `offline` / `online`. Its successor splits the two, so the navigator half
     * is also asked for by name where the browser has it (`overrideNetworkState`, experimental; refused elsewhere).
     */
    const network = async (conditions) => {
      await browser.send('Network.emulateNetworkConditions', conditions)
      try {
        await browser.send('Network.overrideNetworkState', conditions)
      } catch {
        // A browser without the split method moved navigator.onLine with the call above.
      }
      await until(`navigator.onLine === ${!conditions.offline}`, `the page reads navigator.onLine as ${!conditions.offline}`, 5_000)
    }

    await browser.gotoSession(server.url, kept)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`document.getElementById('session-title')?.textContent === 'kept notes'`, 'the page opens the session it was given by name')
    await openWorkspace(browser, outerPath, `${sessionRow(renamed)} !== null && ${workspaceRow(innerPath)} !== undefined`)
    await until(`${sessionLabel(renamed)} === 'before the cut' && ${workspaceRow(innerPath)} !== undefined`, 'the session to rename and the nested workspace are drawn')
    await browser.evaluate(INSTRUMENT)

    /** Rename: the request lands, the browser goes offline, then the page gets the answer and tries to redraw. */
    await browser.evaluate(`window.__holdFor = '/title'; true`)
    await renameThroughDialog(browser, renamed, 'after the cut')
    await until('window.__landed === 1', 'the rename request reached the server')
    const titled = (await api(server.url, cookie, '/api/sessions')).body.find((meta) => meta.id === renamed)
    assert.equal(titled?.title, 'after the cut', `the server applied the rename (${JSON.stringify(titled)})`)
    await network(OFFLINE)
    await browser.evaluate('window.__release()')
    await until(`document.getElementById('session-rename').open === false`, 'the dialog closes on the answer')
    await until(`document.getElementById('tree-note').textContent.startsWith('could not read the workspaces')`, 'offline, the redraw says it could not read the workspaces')
    const offline = JSON.parse(await state())
    assert.equal(offline.renamed, 'before the cut', `offline, the row still shows what the page last read\nsaw: ${JSON.stringify(offline)}`)

    await network(ONLINE)
    await until(`${sessionLabel(renamed)} === 'after the cut'`, 'back online, the row shows the title the server holds, without a reload')
    await until(`document.getElementById('tree-note').hidden || !document.getElementById('tree-note').textContent.startsWith('could not read')`, 'and the stale note is gone')
    const back = JSON.parse(await state())
    assert.deepEqual(back.unhandled, [], `nothing was left to the console as an unhandled rejection\nsaw: ${JSON.stringify(back)}`)

    /** Delete workspace: the same cut, for the nested workspace whose session moves to its parent. */
    await browser.evaluate(`window.__holdFor = '/api/workspaces/'; true`)
    await choose(browser, workspaceRow(innerPath), 'Delete workspace')
    await until(`document.getElementById('workspace-delete').open === true`, 'the Delete workspace dialog opens')
    await browser.evaluate(`document.getElementById('workspace-delete-confirm').click()`)
    await until('window.__landed === 2', 'the delete request reached the server')
    const views = (await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []
    assert.ok(!views.some((view) => view.path === innerPath), `the server applied the delete (${JSON.stringify(views.map((view) => view.path))})`)
    await network(OFFLINE)
    await browser.evaluate('window.__release()')
    await until(`document.getElementById('workspace-delete').open === false`, 'the dialog closes on the answer')
    await until(`document.getElementById('tree-note').textContent.startsWith('could not read the workspaces')`, 'offline, the redraw says it could not read the workspaces')
    const cut = JSON.parse(await state())
    assert.equal(cut.innerRow, true, `offline, the deleted workspace's row is still what the page last read\nsaw: ${JSON.stringify(cut)}`)
    assert.equal(cut.deleteStatus, null, `the dialog's Deleting… line is not left set behind it\nsaw: ${JSON.stringify(cut)}`)

    await network(ONLINE)
    await until(`${workspaceRow(innerPath)} === undefined`, 'back online, the deleted workspace is gone from the tree, without a reload')
    await until(`${sessionRow(moved)} !== null`, 'and its session is drawn under the workspace above it')
    await until(`document.getElementById('tree-note').hidden || !document.getElementById('tree-note').textContent.startsWith('could not read')`, 'and the stale note is gone')
    const done = JSON.parse(await state())
    assert.equal(done.renamed, 'after the cut', 'the rename is still drawn')
    assert.deepEqual(done.unhandled, [], `nothing was left to the console as an unhandled rejection\nsaw: ${JSON.stringify(done)}`)
  } finally {
    browser.close()
    await server.stop()
    for (const dir of [home, outer]) removeDir(dir)
  }
})

test('a rename the server applied just before it went away shows once the page\'s stream reconnects to it, with no stale note and nothing left to the console (#91)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * No browser network event here: the server stops and starts again on the same port with the same home, so the page's
   * cookie still holds (its signing secret is kept in the home), and the only sign of the reconnect the page gets is its
   * stream's new `ready` frame — DSH's new generation, after which `onConnected` reads the baselines again.
   */
  const home = isolatedHome('reconnect-restart')
  const work = fixtureDir('reconnect-restart-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  const args = (port) => ['web', '--host', '127.0.0.1', '--port', String(port), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]
  let server = await startCli(args(0), env)
  const port = new URL(server.url).port
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const workPath = added.body.record.path
    const made = async (title) => {
      const answer = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: work, title }) })
      assert.equal(answer.status, 200, `created ${title} (${JSON.stringify(answer.body)})`)
      await new Promise((done) => setTimeout(done, 15))
      return answer.body.session
    }
    const renamed = await made('before the restart')
    const kept = await made('kept notes')

    const state = () =>
      browser.evaluate(`JSON.stringify({
        note: document.getElementById('tree-note').hidden ? '' : document.getElementById('tree-note').textContent,
        renamed: ${sessionLabel(renamed)},
        renameOpen: document.getElementById('session-rename').open,
        landed: window.__landed ?? null,
        unhandled: window.__unhandled ?? null,
      })`)
    const until = async (expression, what, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }

    await browser.gotoSession(server.url, kept)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`document.getElementById('session-title')?.textContent === 'kept notes'`, 'the page opens the session it was given by name')
    await openWorkspace(browser, workPath, `${sessionRow(renamed)} !== null`)
    await until(`${sessionLabel(renamed)} === 'before the restart'`, 'the session to rename is drawn')
    await browser.evaluate(INSTRUMENT)

    await browser.evaluate(`window.__holdFor = '/title'; true`)
    await renameThroughDialog(browser, renamed, 'after the restart')
    await until('window.__landed === 1', 'the rename request reached the server')
    const titled = (await api(server.url, cookie, '/api/sessions')).body.find((meta) => meta.id === renamed)
    assert.equal(titled?.title, 'after the restart', `the server applied the rename (${JSON.stringify(titled)})`)

    /** The server goes away; only then does the page get the answer, and its redraw cannot reach the server. */
    await server.stop()
    await until(`(async () => { try { await fetch('/api/status'); return false } catch { return true } })()`, 'the page can no longer reach its server')
    await browser.evaluate('window.__release()')
    await until(`document.getElementById('session-rename').open === false`, 'the dialog closes on the answer')
    await until(`document.getElementById('tree-note').textContent.startsWith('could not read the workspaces')`, 'the redraw says it could not read the workspaces')
    const down = JSON.parse(await state())
    assert.equal(down.renamed, 'before the restart', `while the server is away, the row still shows what the page last read\nsaw: ${JSON.stringify(down)}`)

    /** The server comes back on the same port; the page's EventSource reconnects on its own. */
    let restarted = null
    for (let attempt = 0; attempt < 10 && restarted === null; attempt += 1) {
      restarted = await startCli(args(port), env).catch(async () => {
        await new Promise((done) => setTimeout(done, 300))
        return null
      })
    }
    assert.ok(restarted !== null, `the server starts again on port ${port}`)
    server = restarted
    await until(`${sessionLabel(renamed)} === 'after the restart'`, 'once the stream reconnects, the row shows the title the server holds, without a reload', 15_000)
    await until(`document.getElementById('tree-note').hidden || !document.getElementById('tree-note').textContent.startsWith('could not read')`, 'and the stale note is gone')
    const back = JSON.parse(await state())
    assert.deepEqual(back.unhandled, [], `nothing was left to the console as an unhandled rejection\nsaw: ${JSON.stringify(back)}`)
  } finally {
    browser.close()
    await server.stop()
    for (const dir of [home, work]) removeDir(dir)
  }
})
