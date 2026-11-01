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
 * #189, developer-six's J170 replayed. One visible session holds a rare word in a longer answer; 21 more hold it in
 * shorter answers and are archived, so all 21 outrank the visible one. The host used to rank every session and cut at
 * twenty — DSH's host does too (dsh-api-session-controller lib/index.js:2016-2084) — so it answered twenty archived
 * sessions with `hasMore`, the page dropped them under the default Hide archived, and the list said "No matching
 * sessions" over a session in the tree that matched. Now the page sends its archive filter and the host skips what the
 * page hides before its cut: the visible session is found. Under *All conversations (show archived)* every session is a
 * row, so twenty show with DSH's "Showing the first 20 results. Narrow your search." (`lib/client.js:3496-3498`, `:4910`).
 * The titles do not hold the word, so every hit here is the host's.
 */
test('content search: a visible match outranked by 21 archived ones is found, and Show archived lists twenty with the cut sentence (#189)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('content-search-crowd')
  const root = fixtureDir('content-search-crowd-repo')
  mkdirSync(root, { recursive: true })
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
    const sessionIds = async () => JSON.parse((await api(server.url, cookie, '/api/sessions')).text).map((meta) => meta.id)
    /** A new session in the folder per turn, answered with its own text; the session it made is the one id that is new. */
    const turn = async (prompt, answer) => {
      writeFileSync(script, `${JSON.stringify({ steps: [{ text: answer }] })}\n`)
      const known = new Set(await sessionIds())
      const ran = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt, folder: root, new: true }) })
      assert.equal(ran.status, 200, `the turn "${prompt}" ran (${ran.status})`)
      const made = (await sessionIds()).filter((id) => !known.has(id))
      assert.equal(made.length, 1, `the turn "${prompt}" made one session`)
      return made[0]
    }
    const longer = 'zorbliquant, and a few more words than the archived notes have'
    await turn('plain note 0', longer)
    const archived = []
    for (let index = 1; index <= 21; index += 1) archived.push(await turn(`plain note ${index}`, 'zorbliquant noted'))
    for (const id of archived) {
      const flagged = await api(server.url, cookie, `/api/sessions/${id}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
      assert.equal(flagged.status, 200, `archived ${id} (${flagged.text})`)
    }

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    /** READ, plus DSH's cut sentence under the hits. */
    const readAll = `() => ({ ...(${READ})(), more: document.getElementById('search-more').hidden ? null : document.getElementById('search-more').textContent })`
    /** Run `act` in the page, then wait until the host was asked and its answer drawn; answer what the list shows and what was asked. */
    const settle = async (act, done) =>
      JSON.parse(
        await browser.evaluate(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const read = ${readAll}
            const asked = []
            const original = window.fetch
            window.fetch = (input, init) => {
              const url = String(input instanceof Request ? input.url : input)
              if (url.includes('/api/sessions/search')) asked.push(new URL(url, location.href).search)
              return original(input, init)
            }
            await (${act})()
            const deadline = performance.now() + 10000
            while (performance.now() < deadline && !(asked.length > 0 && read().pending === null && (${done})(read()))) await wait(25)
            await wait(150)
            window.fetch = original
            return JSON.stringify({ shown: read(), asked })
          })()`,
          30_000,
        ),
      )

    const typed = await settle(
      `async () => { const field = document.getElementById('session-search'); field.value = 'zorbliquant'; field.dispatchEvent(new Event('input', { bubbles: true })) }`,
      `(shown) => shown.hits.length > 0 || shown.note !== null`,
    )
    assert.deepEqual(
      typed.shown,
      { hits: [{ title: 'plain note 0', snippet: longer }], pending: null, note: null, more: null },
      `Hide archived: the visible session that holds the word is found, and the list is complete\nsaw: ${JSON.stringify(typed)}`,
    )
    assert.deepEqual(typed.asked, ['?q=zorbliquant&archived=hide'], 'the host was asked with the page\'s filter')

    await browser.evaluate(`document.querySelector('#view-options button').click()`)
    await browser.waitFor(`[...document.querySelectorAll('#view-options [role^=menuitem]')].some((entry) => entry.textContent.trim() === 'All conversations (show archived)')`, 5_000)
    const shown = await settle(
      `async () => { [...document.querySelectorAll('#view-options [role^=menuitem]')].find((entry) => entry.textContent.trim() === 'All conversations (show archived)').click() }`,
      `(shown) => shown.hits.length >= 20`,
    )
    assert.deepEqual(
      { rows: shown.shown.hits.length, note: shown.shown.note, more: shown.shown.more, pending: shown.shown.pending },
      { rows: 20, note: null, more: 'Showing the first 20 results. Narrow your search.', pending: null },
      `Show archived: twenty of the 22 rows, and DSH's sentence says the list was cut\nsaw: ${JSON.stringify(shown)}`,
    )
    assert.ok(
      shown.shown.hits.every((hit) => /^plain note \d+$/.test(hit.title) && typeof hit.snippet === 'string' && hit.snippet.includes('zorbliquant')),
      `each row is a session found inside its answer, with its snippet\nsaw: ${JSON.stringify(shown.shown.hits)}`,
    )
    assert.deepEqual(shown.asked, ['?q=zorbliquant&archived=show'], 'the new filter asked the host again')
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
