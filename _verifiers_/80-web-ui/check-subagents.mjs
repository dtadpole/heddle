import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A subagent's session in the sidebar, after DSH (parity rows C23 and C31, with the reload of C28 and C33).
 *
 * The claim, in DSH's terms: a delegated child is reached from its parent, never from the sidebar — the tree, the flat
 * list and the search all leave it out (dsh-client-ui-workspace `sessionVisible`, `lib/client.js:964`); a reload reopens
 * the session that was open (`restoreSelection`, `:1605`), and a first start opens a fresh one (`:1620`, `:1626`), rather
 * than the newest one, which can be that hidden child; and
 * a one-shot child, opened, shows DSH's read-only record where the composer was (dsh-client-ui-subagent
 * `SubagentReadOnlyComposer`, `lib/client.js:678`), while any other session gets the composer back.
 *
 * Phase A measured both builds listing the child in the flat list and the search, opening it on every reload, and
 * offering it a writable composer (R-developer-eight-1, -26, -28, -2). The data is made over HTTP — the delegation is a
 * real turn on a scripted endpoint — and judged in a browser, because each of those is a page behaviour.
 *
 * NOTE: the in-page scripts are template literals; write no backtick inside them.
 */

const CAPABILITY = 'the Web UI'
const CHILD_TITLE = 'child task for the sidebar'
const PARENT_TITLE = 'Delegating parent'

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
 * A home with one registered workspace holding two titled sessions and a delegating parent whose one-shot child is the
 * newest session of all — the order phase A measured, where `sessions[0]` was the hidden child.
 */
async function seeded() {
  const home = isolatedHome('subagent-sidebar')
  const root = fixtureDir('subagent-sidebar-repo')
  const { config } = scriptedConfig({
    home,
    steps: [{ text: 'an answer' }],
    extraEndpoints: [{ name: 'delegate', kind: 'scripted', baseUrl: `${home}/delegate.json`, model: 'scripted' }],
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    `${home}/delegate.json`,
    JSON.stringify({
      steps: [
        { toolCall: { name: 'delegate', arguments: { prompt: CHILD_TITLE } } },
        { text: 'the parent started its child' },
        { purpose: 'subagent', text: 'the child answered' },
        { purpose: 'subagent-notice', text: 'the parent read the notice' },
      ],
    }),
  )
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', `${home}/sessions`],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const cookie = await cookieFor(server.url)
  const close = () => {
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
  try {
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    for (const title of ['Alpha notes', 'Beta notes']) {
      const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title }) })
      assert.equal(made.status, 200, `created ${title} (${JSON.stringify(made.body)})`)
      await new Promise((done) => setTimeout(done, 20))
    }
    const turn = await api(server.url, cookie, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ prompt: PARENT_TITLE, folder: root, new: true, endpoint: 'delegate' }),
    })
    assert.equal(turn.status, 200, `the delegating turn ran (${turn.status})`)
    /** The child runs in the background and the parent answers its notice; both are settled before the page opens. */
    let sessions = []
    for (let attempt = 0; attempt < 100; attempt += 1) {
      sessions = (await api(server.url, cookie, '/api/sessions')).body
      const child = Array.isArray(sessions) ? sessions.find((meta) => meta.origin === 'subagent') : undefined
      if (child !== undefined && (child.turns ?? 0) >= 1 && sessions.every((meta) => meta.running !== true)) break
      await new Promise((done) => setTimeout(done, 150))
    }
    const child = sessions.find((meta) => meta.origin === 'subagent')
    assert.ok(child !== undefined, `the delegation made a subagent child\nsaw: ${JSON.stringify(sessions)}`)
    assert.equal(child.title, CHILD_TITLE)
    assert.equal(sessions[0].id, child.id, 'the child is the newest session the store lists, as in phase A')
    return { url: server.url, cookie, child, close }
  } catch (error) {
    close()
    throw error
  }
}

test('a subagent\'s child stays out of the sidebar, a reload reopens the open session, and a one-shot child shows DSH\'s read-only record', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const fixture = await seeded()
  const browser = await openBrowser()
  const title = `document.getElementById('session-title').textContent`
  const composerState = `JSON.stringify({
    form: getComputedStyle(document.getElementById('prompt')).display,
    disabled: document.querySelector('#prompt textarea').disabled,
    record: document.getElementById('subagent-readonly')?.hidden === false ? document.getElementById('subagent-readonly').textContent : null,
  })`
  try {
    /**
     * A first start, nothing saved: a fresh New session opens, as DSH's does (#17) — never the hidden child, which is the
     * newest session in the store, and never the newest conversation either.
     */
    const seeded = (await api(fixture.url, fixture.cookie, '/api/sessions')).body.map((meta) => meta.id)
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const first = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        title: ${title},
        blank: document.getElementById('session-title').hidden,
        saved: (() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })(),
      })`),
    )
    assert.ok(
      typeof first.saved === 'string' && !seeded.includes(first.saved) && first.blank === true,
      `the page starts on a fresh New session, never on the hidden child or the newest conversation\nsaw: ${JSON.stringify(first)}`,
    )

    /** The search finds titled sessions and never the child, whose title it is asked for. */
    const search = async (query) =>
      JSON.parse(
        await browser.evaluate(`(async () => {
          const field = document.getElementById('session-search')
          field.value = ${JSON.stringify(query)}
          field.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((done) => setTimeout(done, 700))
          const hits = [...document.querySelectorAll('#search-results .hit .hit-title')].map((hit) => hit.textContent)
          field.value = ''
          field.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise((done) => setTimeout(done, 200))
          return JSON.stringify(hits)
        })()`),
      )
    assert.deepEqual((await search('notes')).sort(), ['Alpha notes', 'Beta notes'], 'the search answers')
    assert.deepEqual(await search('child task'), [], 'and lists no subagent child, as DSH\'s deriveSearchResults')

    /** Open Beta notes, then switch to the one-column list: the reload reopens Beta, and the list has no child row. */
    await browser.evaluate(`showSession(${JSON.stringify((await api(fixture.url, fixture.cookie, '/api/sessions')).body.find((meta) => meta.title === 'Beta notes').id)})`)
    await browser.waitFor(`${title} === 'Beta notes'`, 10_000)
    await browser.evaluate(`localStorage.setItem('heddle.tree.grouping.v1', 'list')`)
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`document.querySelectorAll('#tree li[data-kind="session"]').length > 0`, 10_000)
    const reloaded = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        title: ${title},
        rows: [...document.querySelectorAll('#tree li[data-kind="session"] > .row .label')].map((label) => label.textContent),
        selected: [...document.querySelectorAll('#tree li[data-kind="session"][aria-selected="true"] > .row .label')].map((label) => label.textContent),
      })`),
    )
    assert.equal(reloaded.title, 'Beta notes', `a reload reopens the session that was open\nsaw: ${JSON.stringify(reloaded)}`)
    assert.deepEqual(reloaded.selected, ['Beta notes'], 'and its row is the selected one')
    assert.deepEqual([...reloaded.rows].sort(), ['Alpha notes', 'Beta notes', PARENT_TITLE].sort(), 'the one-column list draws every session but the child, once')

    /** The writable composer on an ordinary session; DSH's read-only record on the one-shot child. */
    assert.deepEqual(JSON.parse(await browser.evaluate(composerState)), { form: 'flex', disabled: false, record: null }, 'an ordinary session has its composer')
    await browser.evaluate(`showSession(${JSON.stringify(fixture.child.id)})`)
    await browser.waitFor(`${title} === ${JSON.stringify(CHILD_TITLE)}`, 10_000)
    assert.deepEqual(
      JSON.parse(await browser.evaluate(composerState)),
      { form: 'none', disabled: true, record: 'One-shot subagent recordOne-shot tasks do not accept follow-ups; review the full execution record here.' },
      'the one-shot child shows the read-only record in place of the composer, in DSH\'s words',
    )

    /** Back to an ordinary session: the composer returns. */
    await browser.evaluate(`[...document.querySelectorAll('#tree li[data-kind="session"] > .row')].find((row) => row.querySelector('.label').textContent === 'Alpha notes').click()`)
    await browser.waitFor(`${title} === 'Alpha notes'`, 10_000)
    assert.deepEqual(JSON.parse(await browser.evaluate(composerState)), { form: 'flex', disabled: false, record: null }, 'and leaving the child gives the composer back')
  } finally {
    await browser.close()
    fixture.close()
  }
})
