import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Content search in the sidebar (R-developer-eight-19), as DSH's workspace browser has it.
 *
 * A query shows the local name matches at once, with skeleton rows under a status named "Searching session history…";
 * 250 ms after the last keystroke the page asks the host (`GET /api/sessions/search`, DSH's `session.search`), and the
 * sessions whose conversation holds the phrase join the list after the name matches, each with its snippet
 * (dsh-client-ui-workspace `lib/client.js:1169-1221`, `:2800`, `:3480-3491`, `:3727-3767`). "No matching sessions"
 * waits for the host's answer. The server half is judged in `_verifiers_/70-workspaces-sessions`; this is the page.
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

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, text: await response.text() }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

/** What the search list shows: its hits (title and snippet), the pending status, and the no-match line. */
const READ = `() => ({
  hits: [...document.querySelectorAll('#search-results .hit')].map((hit) => ({
    title: hit.querySelector('.hit-title').textContent,
    snippet: hit.querySelector('.hit-snippet')?.textContent ?? null,
  })),
  pending: (() => {
    const box = document.getElementById('search-pending')
    return box === null || box.hidden ? null : { role: box.getAttribute('role'), label: box.getAttribute('aria-label'), rows: box.querySelectorAll('.skeleton-row').length }
  })(),
  note: document.getElementById('search-note').hidden ? null : document.getElementById('search-note').textContent,
})`

test('content search: a phrase found only inside a turn joins the hits with its snippet, after the 250 ms debounce', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('content-search')
  const root = fixtureDir('content-search-repo')
  const folders = ['named', 'inside', 'none'].map((name) => join(root, name))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'noted' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${added.text})`)
    /** One session per folder, each answered with its own text: the script is read on every call. */
    const turn = async (folder, prompt, answer) => {
      writeFileSync(script, `${JSON.stringify({ steps: [{ text: answer }] })}\n`)
      const ran = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt, folder }) })
      assert.equal(ran.status, 200, `the turn "${prompt}" ran (${ran.status})`)
    }
    /** A name match whose own prompt also holds the phrase; a session that holds it only in its answer; one with neither. */
    await turn(folders[0], 'quokka ledger plans', 'noted')
    await turn(folders[1], 'tell me about the colony', 'The Qu\u00f6kka-Ledger is balanced, says the colony.')
    await turn(folders[2], 'unrelated', 'nothing to see')

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)

    /**
     * Four keystrokes 40 ms apart, read 40 ms after the last: the name match is there, the host has not been asked, and
     * the status shows one skeleton row under it. Then wait for the host's hit, counting every request the page made.
     */
    const typed = JSON.parse(
      await browser.evaluate(
        `(async () => {
          const wait = (ms) => new Promise((done) => setTimeout(done, ms))
          const read = ${READ}
          /** The first search loads the page's session index; do that first, so the timed reads judge the search alone. */
          const warm = document.getElementById('session-search')
          warm.value = 'warm'
          warm.dispatchEvent(new Event('input', { bubbles: true }))
          const loaded = performance.now() + 5000
          while (performance.now() < loaded && document.getElementById('search-results').hidden) await wait(20)
          warm.value = ''
          warm.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(50)
          const asked = []
          const original = window.fetch
          window.fetch = (input, init) => {
            const url = String(input instanceof Request ? input.url : input)
            if (url.includes('/api/sessions/search')) asked.push({ url, at: performance.now() })
            return original(input, init)
          }
          const field = document.getElementById('session-search')
          let typedAt = 0
          for (const value of ['q', 'quo', 'quokka led', 'quokka ledger']) {
            field.value = value
            field.dispatchEvent(new Event('input', { bubbles: true }))
            typedAt = performance.now()
            await wait(40)
          }
          const early = read()
          const askedEarly = asked.length
          const deadline = performance.now() + 5000
          while (performance.now() < deadline && !read().hits.some((hit) => hit.title.includes('colony'))) await wait(25)
          const settled = read()
          window.fetch = original
          return JSON.stringify({
            early,
            askedEarly,
            asked: asked.map((entry) => ({ q: new URL(entry.url, location.href).searchParams.get('q'), after: Math.round(entry.at - typedAt) })),
            settled,
          })
        })()`,
        20_000,
      ),
    )
    assert.deepEqual(typed.early.hits, [{ title: 'quokka ledger plans', snippet: null }], `the name match shows at once\nsaw: ${JSON.stringify(typed)}`)
    assert.deepEqual(typed.early.pending, { role: 'status', label: 'Searching session history…', rows: 1 }, 'with one skeleton row under it while the host is asked')
    assert.equal(typed.early.note, null, 'and no "No matching sessions" before the host answers')
    assert.equal(typed.askedEarly, 0, 'the host is not asked inside the debounce')
    assert.equal(typed.asked.length, 1, `one request for four keystrokes\nsaw: ${JSON.stringify(typed.asked)}`)
    assert.equal(typed.asked[0].q, 'quokka ledger', 'for the last query')
    assert.ok(typed.asked[0].after >= 240, `250 ms after the last keystroke\nsaw: ${typed.asked[0].after} ms`)
    assert.deepEqual(
      typed.settled.hits,
      [
        { title: 'quokka ledger plans', snippet: 'quokka ledger plans' },
        { title: 'tell me about the colony', snippet: 'The Qu\u00f6kka-Ledger is balanced, says the colony.' },
      ],
      `the name match first, then the session found inside its answer, each with its snippet\nsaw: ${JSON.stringify(typed.settled)}`,
    )
    assert.equal(typed.settled.pending, null, 'and the status is gone')

    /** A phrase nobody wrote: two skeleton rows while asking, then DSH's sentence. */
    const nothing = JSON.parse(
      await browser.evaluate(
        `(async () => {
          const wait = (ms) => new Promise((done) => setTimeout(done, ms))
          const read = ${READ}
          const field = document.getElementById('session-search')
          field.value = 'zebra crossing'
          field.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(40)
          const early = read()
          const deadline = performance.now() + 5000
          while (performance.now() < deadline && read().pending !== null) await wait(25)
          return JSON.stringify({ early, settled: read() })
        })()`,
        20_000,
      ),
    )
    assert.deepEqual(nothing.early, { hits: [], pending: { role: 'status', label: 'Searching session history…', rows: 2 }, note: null }, `two skeleton rows and no sentence yet\nsaw: ${JSON.stringify(nothing)}`)
    assert.deepEqual(nothing.settled, { hits: [], pending: null, note: 'No matching sessions' }, 'then the sentence, once the host has answered')

    /** A content hit opens like any hit: the query clears and the session is shown. */
    await browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = 'quokka ledger'; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await browser.waitFor(`[...document.querySelectorAll('#search-results .hit .hit-title')].some((title) => title.textContent.includes('colony'))`, 5_000)
    await browser.evaluate(`[...document.querySelectorAll('#search-results .hit')].find((hit) => hit.querySelector('.hit-title').textContent.includes('colony')).click()`)
    await browser.waitFor(`document.getElementById('session-title').textContent.includes('tell me about the colony')`, 10_000)
    const after = JSON.parse(await browser.evaluate(`JSON.stringify({ query: document.getElementById('session-search').value, resultsHidden: document.getElementById('search-results').hidden, pending: document.getElementById('search-pending')?.hidden ?? true })`))
    assert.deepEqual(after, { query: '', resultsHidden: true, pending: true }, 'the search is put away')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})

/**
 * A failed host request (#58). DSH's README, Search: "a failed content search leaves metadata matches visible without an
 * additional warning" — its error state draws the name matches and no sentence (dsh-client-ui-workspace
 * `lib/client.js:3753-3760`, `:3492`). A failure is not the query's answer either: the next search for the same query
 * asks the host again, and the session found inside a conversation joins the hits. The browser's own `fetch` is
 * switched to fail `/api/sessions/search` the way a lost network does, then back.
 */
test('content search: a failed host request leaves the name matches with no warning, and the same query asks the host again', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('content-search-down')
  const root = fixtureDir('content-search-down-repo')
  const folders = ['named', 'inside'].map((name) => join(root, name))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'noted' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${added.text})`)
    const turn = async (folder, prompt, answer) => {
      writeFileSync(script, `${JSON.stringify({ steps: [{ text: answer }] })}\n`)
      const ran = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt, folder }) })
      assert.equal(ran.status, 200, `the turn "${prompt}" ran (${ran.status})`)
    }
    await turn(folders[0], 'quokka ledger plans', 'noted')
    await turn(folders[1], 'tell me about the colony', 'The Qu\u00f6kka-Ledger is balanced, says the colony.')

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)

    const outcome = JSON.parse(
      await browser.evaluate(
        `(async () => {
          const wait = (ms) => new Promise((done) => setTimeout(done, ms))
          const read = ${READ}
          const original = window.fetch
          let down = true
          let asked = 0
          window.fetch = (input, init) => {
            const url = String(input instanceof Request ? input.url : input)
            if (url.includes('/api/sessions/search')) {
              asked += 1
              if (down) return Promise.reject(new TypeError('Failed to fetch'))
            }
            return original(input, init)
          }
          const field = document.getElementById('session-search')
          field.value = 'quokka ledger'
          field.dispatchEvent(new Event('input', { bubbles: true }))
          let deadline = performance.now() + 5000
          while (performance.now() < deadline && (asked === 0 || read().pending !== null)) await wait(25)
          await wait(150)
          const failed = read()
          const askedWhileDown = asked
          down = false
          /** The same query again, as a person re-entering it does. */
          field.dispatchEvent(new Event('input', { bubbles: true }))
          deadline = performance.now() + 5000
          while (performance.now() < deadline && !read().hits.some((hit) => hit.title.includes('colony'))) await wait(25)
          const again = read()
          window.fetch = original
          return JSON.stringify({ failed, askedWhileDown, again, asked })
        })()`,
        20_000,
      ),
    )
    assert.deepEqual(
      outcome.failed,
      { hits: [{ title: 'quokka ledger plans', snippet: null }], pending: null, note: null },
      `the name match stays, the status goes, and no warning is added\nsaw: ${JSON.stringify(outcome)}`,
    )
    assert.ok(outcome.askedWhileDown >= 1, `the host was asked, and the request failed\nsaw: ${JSON.stringify(outcome)}`)
    assert.deepEqual(
      outcome.again.hits,
      [
        { title: 'quokka ledger plans', snippet: 'quokka ledger plans' },
        { title: 'tell me about the colony', snippet: 'The Qu\u00f6kka-Ledger is balanced, says the colony.' },
      ],
      `the same query asks the host again, and the session found inside its answer joins the hits\nsaw: ${JSON.stringify(outcome)}`,
    )
    assert.ok(outcome.asked > outcome.askedWhileDown, `the failure was not kept as the query's answer\nsaw: ${JSON.stringify(outcome)}`)
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})

/**
 * GitHub issue #151: a press on a search hit, or on an archived hit's Unarchive button, was lost when the hits redrew
 * between the press and the release. `applySearch` rebuilt every hit with `replaceChildren` on each redraw — the host's
 * content answer 250 ms after the last keystroke, and the tree's toggle re-applying a standing search — so the press and
 * the release landed on two different elements and the browser fired no click. DSH's result list is keyed by session
 * (dsh-client-ui-workspace, a React list), so its rows survive the update and the click lands.
 *
 * The host's answer is held back 1.5 s inside the page, so the press goes down before it and the release comes after the
 * redraw it causes. Each hit is a name match whose conversation does not hold the query, so the redraw adds no snippet line
 * that would move the control from under a still pointer. The press holds the button down (`buttons: 1`) as a person's
 * does; before the release the check asks what is under the pointer, and every failure message carries what the press did
 * (the mousedown, mouseup and click targets, and the flags requests with their status).
 */
test('a press on a search hit, or on its Unarchive button, lands though the host\'s answer redraws the hits between the press and the release (#151)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('content-search-redraw')
  const root = fixtureDir('content-search-redraw-repo')
  const folders = ['desk', 'shelf'].map((name) => join(root, name))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'noted' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${added.text})`)
    /** Two sessions named after the turn, so their titles hold the query and their conversations do not. */
    const ids = []
    for (const folder of folders) {
      const ran = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'a plain question', folder }) })
      assert.equal(ran.status, 200, `a turn ran in ${folder} (${ran.status})`)
      const listed = JSON.parse((await api(server.url, cookie, '/api/sessions')).text)
      const real = (await import('node:fs')).realpathSync(folder)
      ids.push(listed.find((meta) => meta.cwd === real)?.id)
    }
    const [desk, shelf] = ids
    assert.ok(desk && shelf, 'both sessions are listed')
    for (const [id, title] of [
      [desk, 'quokka desk'],
      [shelf, 'quokka shelf'],
    ]) {
      const renamed = await api(server.url, cookie, `/api/sessions/${id}/title`, { method: 'POST', body: JSON.stringify({ title }) })
      assert.equal(renamed.status, 200, `named ${title} (${renamed.text})`)
    }
    const archived = await api(server.url, cookie, `/api/sessions/${shelf}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
    assert.equal(archived.status, 200, `archived quokka shelf (${archived.text})`)
    const isArchived = async () => JSON.parse((await api(server.url, cookie, '/api/sessions')).text).find((meta) => meta.id === shelf)?.archived === true

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    /** All conversations, so the archived session is a hit, with its Unarchive button. */
    await browser.evaluate(`localStorage.setItem('heddle.tree.archived.v1', 'show')`)
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    /**
     * The host's answer held back 1.5 s, and a record of what the press did, for the failure message: every mousedown,
     * mouseup and click (its target, whether it is the pressed element or inside it, and the buttons it reported), and every
     * flags request with its status. A run on the Rust build failed at the unarchive with no way to tell a lost click from a
     * refused request (parent's report of 31 Oct 18:26).
     */
    await browser.evaluate(`(() => {
      const describe = (node) => node === null ? null : node.nodeType === 1 ? node.tagName.toLowerCase() + (node.getAttribute('class') ? '.' + node.getAttribute('class').split(' ').join('.') : '') : '#' + node.nodeName
      window.__d151 = { events: [], posts: [] }
      for (const type of ['mousedown', 'mouseup', 'click', 'pointercancel', 'dragstart']) {
        document.addEventListener(type, (event) => {
          const pressed = window.__pressed ?? null
          window.__d151.events.push({ type, target: describe(event.target), onPressed: pressed === null ? null : pressed.contains(event.target), buttons: event.buttons })
        }, true)
      }
      window.__describe = describe
      const original = window.fetch
      window.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('/flags')) {
          const entry = { url: url.replace(/session-[0-9a-f-]{36}/, '<id>'), body: String(init?.body ?? ''), status: null }
          window.__d151.posts.push(entry)
          return original(input, init).then((response) => { entry.status = response.status; return response }, (error) => { entry.status = String(error); throw error })
        }
        if (!url.includes('/api/sessions/search')) return original(input, init)
        return new Promise((done) => setTimeout(done, 1500)).then(() => original(input, init))
      }
      return true
    })()`)
    const type = (query) => browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const pending = `(() => { const box = document.getElementById('search-pending'); return box !== null && !box.hidden })()`
    const centre = async (expression) =>
      JSON.parse(await browser.evaluate(`JSON.stringify((() => { const node = ${expression}; if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })())`))
    /**
     * A person's press holds the button down, so the press says so (`buttons: 1`) and the release lets it go, as
     * _tools_/browser-use and check-access press: a press that reports no button held is one Chrome's own mouse moves
     * during the hold (it sends one when the content under a still pointer changes) can read as already let go.
     */
    const pointer = (kind, at) =>
      browser.send('Input.dispatchMouseEvent', {
        type: kind,
        x: at.x,
        y: at.y,
        button: kind === 'mouseMoved' ? 'none' : 'left',
        buttons: kind === 'mousePressed' ? 1 : 0,
        ...(kind === 'mouseMoved' ? {} : { clickCount: 1 }),
      })
    const hit = (title) => `[...document.querySelectorAll('#search-results .hit')].find((entry) => entry.querySelector('.hit-title')?.textContent === ${JSON.stringify(title)})`
    /**
     * Under the still pointer: what the point hits now, whether that is the pressed element or inside it, and the pressed
     * element's box and its hit's box, now and as they were at the press (`mark` stores them under that name).
     */
    const box = `((node) => { if (!node) return null; const r = node.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] })`
    const mark = (name) => browser.evaluate(`(() => { window.__d151.boxes = window.__d151.boxes ?? {}; window.__d151.boxes[${JSON.stringify(name)}] = { pressed: ${box}(window.__pressed), hit: ${box}(window.__pressed?.closest('.hit')) }; return true })()`)
    const under = async (at) => {
      await mark('release')
      return JSON.parse(await browser.evaluate(`JSON.stringify((() => { const node = document.elementFromPoint(${at.x}, ${at.y}); return { at: window.__describe(node), onPressed: window.__pressed?.contains(node) ?? null, boxes: window.__d151.boxes } })())`))
    }
    const record = async () => browser.evaluate('JSON.stringify(window.__d151)')
    /** The sidebar settles first, so nothing above the hits moves them while a press is held. */
    let last = ''
    for (let quiet = 0, round = 0; quiet < 5 && round < 50; round += 1) {
      const now = await browser.evaluate(`(() => { const r = document.getElementById('session-search').getBoundingClientRect(); return r.top + ':' + r.left + ':' + r.width })()`)
      quiet = now === last ? quiet + 1 : 0
      last = now
      await new Promise((done) => setTimeout(done, 200))
    }

    /** The Unarchive button: pressed while the host is still asked, released after its answer redrew the hits. */
    await type('quokka shelf')
    assert.ok(await browser.waitFor(`${hit('quokka shelf')}?.querySelector('.hit-unarchive') != null && ${pending}`, 10_000), 'the archived hit is drawn with its Unarchive button while the host is asked')
    const button = await centre(`${hit('quokka shelf')}.querySelector('.hit-unarchive')`)
    await browser.evaluate(`window.__pressed = ${hit('quokka shelf')}.querySelector('.hit-unarchive'); true`)
    await mark('press')
    await pointer('mouseMoved', button)
    await pointer('mousePressed', button)
    assert.ok(await browser.waitFor(`!${pending}`, 10_000), 'the host answered and the hits redrew while the button was held')
    assert.equal(await browser.evaluate(`window.__pressed.isConnected && ${hit('quokka shelf')}?.querySelector('.hit-unarchive') === window.__pressed`), true, 'the button the press went down on is still the hit\'s button')
    const atRelease = await under(button)
    assert.equal(atRelease.onPressed, true, `and it is still under the pointer, so the release lands on it\nunder the pointer: ${JSON.stringify(atRelease)}\nrecord: ${await record()}`)
    await pointer('mouseReleased', button)
    let restored = false
    for (const end = Date.now() + 5_000; Date.now() < end && !restored; ) {
      restored = !(await isArchived())
      if (!restored) await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(restored, true, `the release is a click on Unarchive: the session is unarchived\nrecord: ${await record()}`)

    /** A hit: pressed while the host is asked, released after the redraw, and it opens. */
    await browser.evaluate('window.__d151.events = []; window.__d151.posts = []; window.__d151.boxes = {}; true')
    await type('quokka desk')
    assert.ok(await browser.waitFor(`${hit('quokka desk')} != null && ${pending}`, 10_000), 'the hit is drawn while the host is asked')
    const title = await centre(`${hit('quokka desk')}.querySelector('.hit-title')`)
    await browser.evaluate(`window.__pressed = ${hit('quokka desk')}; true`)
    await mark('press')
    await pointer('mouseMoved', title)
    await pointer('mousePressed', title)
    assert.ok(await browser.waitFor(`!${pending}`, 10_000), 'the host answered and the hits redrew while the hit was held')
    assert.equal(await browser.evaluate(`window.__pressed.isConnected && ${hit('quokka desk')} === window.__pressed`), true, 'the hit the press went down on is still the hit')
    const onHit = await under(title)
    assert.equal(onHit.onPressed, true, `and it is still under the pointer\nunder the pointer: ${JSON.stringify(onHit)}\nrecord: ${await record()}`)
    await pointer('mouseReleased', title)
    assert.ok(
      await browser.waitFor(`document.getElementById('session-title').textContent.includes('quokka desk')`, 10_000),
      `the release is a click on the hit: the session opens\nsaw: ${await browser.evaluate(`JSON.stringify(document.getElementById('session-title').textContent)`)}\nrecord: ${await record()}`,
    )
    assert.equal(await browser.evaluate(`document.getElementById('session-search').value`), '', 'and the search is put away')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})

/**
 * GitHub issue #163: a standing search follows the live list. DSH derives its rows from the list on every change
 * (`deriveSearchResults` is a `useMemo` over the session list, the workspaces, the query, the archived ids and the filter,
 * dsh-client-ui-workspace `lib/client.js:3451-3460`), so another client's rename shows in the hits at once, an archived
 * session leaves them under the default filter (`sessionVisible`, `:964`), and a renamed workspace is the hit's new
 * place label. The page kept a cached index the stream never dropped: the hits kept the old title and the old workspace
 * name, even when the query was typed again, until a reload.
 *
 * A second client (the API) archives one session, renames another and renames the workspace. The archive pushes no stream
 * frame of its own yet (#167), so it is the renames' frames that bring it; the page then reads the newer list. Choosing the
 * archived hit, shown under All conversations, says why it cannot be opened and opens nothing (`openSearchResult`,
 * `:3664-3668`).
 */
test('a standing search follows another client\'s session rename, workspace rename and archive, and the archived hit opens nothing (#163)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('content-search-fresh')
  const root = fixtureDir('content-search-fresh-repo')
  const folders = ['alpha', 'beta', 'gamma'].map((name) => join(root, name))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'noted' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${added.text})`)
    const workspaceId = JSON.parse(added.text).record?.id
    assert.ok(typeof workspaceId === 'string' && workspaceId.length > 0, `the workspace has an id (${added.text})`)
    const { realpathSync } = await import('node:fs')
    const ids = []
    for (const folder of folders) {
      const ran = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'a plain question', folder }) })
      assert.equal(ran.status, 200, `a turn ran in ${folder} (${ran.status})`)
      const listed = JSON.parse((await api(server.url, cookie, '/api/sessions')).text)
      ids.push(listed.find((meta) => meta.cwd === realpathSync(folder))?.id)
    }
    const [alpha, beta, gamma] = ids
    assert.ok(alpha && beta && gamma, 'the three sessions are listed')
    for (const [id, title] of [
      [alpha, 'quokka alpha'],
      [beta, 'quokka beta'],
      [gamma, 'quokka gamma'],
    ]) {
      const renamed = await api(server.url, cookie, `/api/sessions/${id}/title`, { method: 'POST', body: JSON.stringify({ title }) })
      assert.equal(renamed.status, 200, `named ${title} (${renamed.text})`)
    }

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)

    /** The hits as a person reads them: each title, its place label (`workspace · age`), and whether it is drawn archived. */
    const read = async () =>
      JSON.parse(
        await browser.evaluate(
          `JSON.stringify({
            hits: [...document.querySelectorAll('#search-results .hit')].map((hit) => ({
              title: hit.querySelector('.hit-title').textContent,
              place: hit.querySelector('.hit-workspace').textContent,
              archived: hit.dataset.archived === 'true',
            })),
            query: document.getElementById('session-search').value,
            shown: !document.getElementById('search-results').hidden,
            opened: document.getElementById('session-title').textContent,
          })`,
        ),
      )
    /** Read until `wanted` holds or `ms` pass; the last reading either way, so a failure says what the page showed. */
    const until = async (wanted, ms) => {
      let seen = await read()
      for (const end = Date.now() + ms; !wanted(seen) && Date.now() < end; ) {
        await new Promise((done) => setTimeout(done, 100))
        seen = await read()
      }
      return seen
    }
    const type = (query) => browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    const titles = (seen) => seen.hits.map((hit) => hit.title).sort()
    /** The workspace a hit names: its place label before the age. */
    const places = (seen) => [...new Set(seen.hits.map((hit) => hit.place.split(' · ')[0]))]

    await type('quokka')
    const before = await until((seen) => seen.hits.length === 3, 10_000)
    assert.deepEqual(titles(before), ['quokka alpha', 'quokka beta', 'quokka gamma'], `the search lists the three sessions\nsaw: ${JSON.stringify(before)}`)
    assert.equal(places(before).length, 1, `all three in one workspace\nsaw: ${JSON.stringify(before)}`)
    assert.notEqual(places(before)[0], 'Garden')

    /** The second client: an archive, a session rename and a workspace rename, each answered 200. */
    const archived = await api(server.url, cookie, `/api/sessions/${beta}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
    assert.equal(archived.status, 200, `archived quokka beta (${archived.text})`)
    const renamed = await api(server.url, cookie, `/api/sessions/${gamma}/title`, { method: 'POST', body: JSON.stringify({ title: 'quokka renamed elsewhere' }) })
    assert.equal(renamed.status, 200, `renamed quokka gamma (${renamed.text})`)
    const garden = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'PATCH', body: JSON.stringify({ title: 'Garden' }) })
    assert.equal(garden.status, 200, `renamed the workspace (${garden.text})`)

    const followed = (seen) => JSON.stringify(titles(seen)) === JSON.stringify(['quokka alpha', 'quokka renamed elsewhere']) && JSON.stringify(places(seen)) === JSON.stringify(['Garden'])
    const after = await until(followed, 8_000)
    assert.ok(
      followed(after),
      `within a few seconds the standing search shows the new title, leaves out the archived session under Hide archived, and names the workspace Garden\nsaw: ${JSON.stringify(after)}`,
    )
    assert.equal(after.query, 'quokka', 'with the query untouched')

    /** Typed again, the query runs over the newer list too. */
    await type('')
    await until((seen) => !seen.shown, 5_000)
    await type('quokka')
    const again = await until(followed, 8_000)
    assert.ok(followed(again), `retyping shows the new names\nsaw: ${JSON.stringify(again)}`)

    /** Under All conversations the archived session is a hit again, drawn archived; choosing it opens nothing. */
    await browser.evaluate(`document.querySelector('#view-options button').click()`)
    await browser.waitFor(`[...document.querySelectorAll('#view-options [role^=menuitem]')].some((entry) => entry.textContent.trim() === 'All conversations (show archived)')`, 5_000)
    await browser.evaluate(`[...document.querySelectorAll('#view-options [role^=menuitem]')].find((entry) => entry.textContent.trim() === 'All conversations (show archived)').click()`)
    const shownArchived = await until((seen) => seen.hits.some((hit) => hit.title === 'quokka beta' && hit.archived), 8_000)
    assert.deepEqual(
      shownArchived.hits.filter((hit) => hit.title === 'quokka beta').map((hit) => hit.archived),
      [true],
      `the archived session is a hit, drawn archived\nsaw: ${JSON.stringify(shownArchived)}`,
    )
    await browser.evaluate(`[...document.querySelectorAll('#search-results .hit')].find((hit) => hit.querySelector('.hit-title').textContent === 'quokka beta').click()`)
    assert.ok(
      await browser.waitFor(`document.getElementById('archive-notice').hidden === false && document.getElementById('archive-notice').dataset.kind === 'archivedNotOpenable'`, 5_000),
      'choosing it shows the not-openable notice',
    )
    assert.equal(await browser.evaluate(`document.getElementById('archive-notice').textContent`), 'Archived sessions cannot be opened. Unarchive it to view.', "in DSH's words")
    const chosen = await read()
    assert.equal(chosen.opened, before.opened, `and nothing was opened\nsaw: ${JSON.stringify(chosen)}`)
    assert.equal(chosen.query, 'quokka', 'the query stays')
    assert.equal(chosen.shown, true, 'and so do the results')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})
