import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The left column is a **workspace tree** after DSH's workspace browser (owner goal G2, 2026-10-28).
 *
 * The claim, in DSH's terms: workspaces are groups, each with its sessions nested under it; a workspace registered
 * inside another nests under it (`Workspace Tree`) with its row **before** the parent's own sessions; a session no
 * registered workspace owns trails under **Ungrouped**; an open workspace shows five sessions and a `Show more`; the
 * selected session's workspace tints its folder; a workspace's `+` starts a session there; and the `Workspace` grouping
 * draws every workspace as a sibling section.
 *
 * The data is judged over HTTP first (`GET /api/workspaces`, the route both servers serve for this), then the page in a
 * browser, because a correct answer drawn wrong is the failure this check exists for.
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
 * A home with two registered workspaces (one nested in the other), seven sessions in the outer one, one in the inner
 * one, and one turn in a folder nobody registered — the shapes the tree has to place.
 */
async function seeded(label) {
  const home = isolatedHome(`tree-${label}`)
  const root = fixtureDir(`tree-${label}-repo`)
  const app = join(root, 'packages', 'app')
  const loose = fixtureDir(`tree-${label}-loose`)
  mkdirSync(app, { recursive: true })
  mkdirSync(loose, { recursive: true })
  const { config } = scriptedConfig({ home, steps: Array.from({ length: 6 }, () => ({ text: 'an answer' })) })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const cookie = await cookieFor(server.url)
  const registered = async (path) => {
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
    assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
    return added.body.record
  }
  const repo = await registered(root)
  const inner = await registered(app)
  const created = []
  for (let index = 1; index <= 7; index += 1) {
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title: `repo session ${index}` }) })
    assert.equal(made.status, 200, `created a session in the outer workspace (${JSON.stringify(made.body)})`)
    created.push(made.body.session)
    // Distinct update times, so newest-first has one answer.
    await new Promise((done) => setTimeout(done, 15))
  }
  const appSession = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: app, title: 'app session' }) })
  assert.equal(appSession.status, 200)
  const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'work in the loose folder', folder: loose }) })
  assert.equal(turn.status, 200, `a turn ran in an unregistered folder (${turn.status})`)
  return {
    url: server.url,
    cookie,
    repo,
    inner,
    created,
    appSession: appSession.body.session,
    close: () => {
      server.kill()
      for (const dir of [home, root, loose]) removeDir(dir)
    },
  }
}

test('GET /api/workspaces names each workspace\'s parent and the sessions whose nearest root it is', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await seeded('api')
  try {
    const answer = await api(fixture.url, fixture.cookie, '/api/workspaces')
    assert.equal(answer.status, 200, `the route answers (${JSON.stringify(answer.body)})`)
    const list = answer.body.workspaces
    assert.ok(Array.isArray(list), 'with a workspaces array')
    const byId = new Map(list.map((entry) => [entry.id, entry]))
    const repo = byId.get(fixture.repo.id)
    const inner = byId.get(fixture.inner.id)
    assert.ok(repo !== undefined && inner !== undefined, 'both registered workspaces are listed')
    assert.deepEqual(Object.keys(repo), ['id', 'path', 'title', 'origin', 'parent', 'createdAt', 'updatedAt', 'sessionIds'], 'in the one shape both servers write')
    assert.equal(repo.parent, null, 'a top-level workspace has no parent')
    assert.equal(inner.parent, fixture.repo.id, 'the nested one names the workspace above it')
    assert.equal(repo.origin, 'added')
    assert.deepEqual([...repo.sessionIds].sort(), [...fixture.created].sort(), 'the outer workspace owns its seven sessions')
    assert.deepEqual(inner.sessionIds, [fixture.appSession], 'and not the one its nested workspace owns')
    const adopted = list.filter((entry) => entry.origin === 'auto')
    assert.equal(adopted.length, 1, 'the unregistered folder was adopted')
    assert.equal(adopted[0].sessionIds.length, 1, 'with the session that ran there')
  } finally {
    fixture.close()
  }
})

test('the left column is DSH\'s workspace tree: groups, nested workspaces first, sessions, Show more, Ungrouped, a + per workspace', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const fixture = await seeded('page')
  const browser = await openBrowser()
  try {
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor('document.querySelectorAll(\'#tree > li[data-kind="workspace"] li[data-kind="session"]\').length > 0', 15_000)

    /** The top level: the outer workspace, then Ungrouped — the nested workspace is not a top-level row. */
    const top = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree > li')].map((li) => [li.dataset.kind, li.querySelector(':scope > .row .label').textContent]))`))
    const repoLabel = fixture.repo.title
    const appLabel = fixture.inner.title
    assert.deepEqual(top, [['workspace', repoLabel], ['ungrouped', 'Ungrouped']], `the top level is the outer workspace, then Ungrouped\nsaw: ${JSON.stringify(top)}`)

    /** Inside the open outer workspace: the nested workspace row first, then the sessions, newest first, five of seven. */
    const inside = JSON.parse(await browser.evaluate(`(() => {
      const group = document.querySelector('#tree > li[data-kind="workspace"] > ul[role="group"]')
      return JSON.stringify([...group.children].map((li) => [li.dataset.kind ?? li.className, (li.querySelector(':scope > .row .label') ?? li).textContent.trim()]))
    })()`))
    const kinds = inside.map(([kind]) => kind)
    assert.equal(kinds[0], 'workspace', `the nested workspace comes first\nsaw: ${JSON.stringify(inside)}`)
    assert.equal(inside[0][1], appLabel)
    const sessionLabels = inside.filter(([kind]) => kind === 'session').map(([, label]) => label)
    assert.deepEqual(sessionLabels, ['repo session 7', 'repo session 6', 'repo session 5', 'repo session 4', 'repo session 3'], 'five sessions, newest first')
    assert.ok(kinds.indexOf('more') > kinds.lastIndexOf('session'), 'then the overflow row')
    assert.equal(inside[kinds.indexOf('more')][1], 'Show more')

    /** Show more reveals the rest, and folds back with Show less. */
    await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > ul > li[data-kind="more"] > .row').click()`)
    const afterMore = JSON.parse(await browser.evaluate(`JSON.stringify({
      sessions: document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"]').length,
      control: document.querySelector('#tree > li[data-kind="workspace"] > ul > li[data-kind="more"] .label')?.textContent ?? null,
    })`))
    assert.deepEqual(afterMore, { sessions: 7, control: 'Show less' }, 'all seven, and the control folds them back')

    /** Opening a session selects its row, shows it, and tints the folder of the workspace that holds it. */
    await browser.evaluate(`[...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.textContent.includes('repo session 3')).querySelector(':scope > .row').click()`)
    await browser.waitFor(`document.getElementById('session-title').textContent.includes('repo session 3')`, 10_000)
    const selected = JSON.parse(await browser.evaluate(`JSON.stringify({
      selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.textContent.trim()),
      tinted: document.querySelector('#tree > li[data-kind="workspace"]').dataset.containsCurrent ?? null,
    })`))
    assert.equal(selected.selected.length, 1, `exactly one row is selected\nsaw: ${JSON.stringify(selected)}`)
    assert.match(selected.selected[0], /repo session 3/)
    assert.equal(selected.tinted, 'true', 'and its workspace says it holds the open session')

    /** The nested workspace opens to its own session; its + starts another one there, selected. */
    await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > ul > li[data-kind="workspace"] > .row').click()`)
    await browser.waitFor(`[...document.querySelectorAll('#tree li[data-kind="workspace"] li[data-kind="workspace"] li[data-kind="session"]')].some((li) => li.textContent.includes('app session'))`, 10_000)
    const before = await browser.evaluate(`document.querySelectorAll('#tree li[data-kind="workspace"] li[data-kind="workspace"] li[data-kind="session"]').length`)
    await browser.evaluate(`document.querySelector('#tree li[data-kind="workspace"] li[data-kind="workspace"] > .row button[aria-label="New session in ${appLabel}"]').click()`)
    assert.ok(
      await browser.waitFor(`document.querySelectorAll('#tree li[data-kind="workspace"] li[data-kind="workspace"] li[data-kind="session"]').length > ${before}`, 15_000),
      'the + starts a session in that workspace, drawn under it',
    )
    assert.ok(
      await browser.waitFor(`document.querySelector('#tree li[data-kind="workspace"] li[data-kind="workspace"] li[data-kind="session"][aria-selected="true"]') !== null`, 10_000),
      'and the new session is the selected row',
    )

    /** Ungrouped holds the session that ran where no workspace was registered. */
    await browser.evaluate(`(() => { const row = document.querySelector('#tree > li[data-kind="ungrouped"] > .row'); if (row.closest('li').dataset.open !== 'true') row.click() })()`)
    assert.ok(
      await browser.waitFor(`document.querySelectorAll('#tree > li[data-kind="ungrouped"] li[data-kind="session"]').length === 1`, 10_000),
      'the unregistered folder\'s session is Ungrouped',
    )

    /** The Workspace grouping: every workspace a sibling section, the nested one beside its parent. */
    await browser.evaluate(`localStorage.setItem('heddle.tree.grouping.v1', 'workspace')`)
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`document.querySelectorAll('#tree > li[data-kind="workspace"]').length === 2`, 15_000)
    const siblings = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree > li[data-kind="workspace"] > .row .label')].map((label) => label.textContent).sort())`))
    assert.deepEqual(siblings, [appLabel, repoLabel].sort(), 'both workspaces are top-level sections')
  } finally {
    browser.close()
    fixture.close()
  }
})

/**
 * A session in a nested registered workspace is named after **that** workspace (#57), wherever a session is named with
 * its workspace: a search hit, and a row of the one-column list (`In one list`).
 *
 * DSH's search result names the workspace whose `sessionIds` holds the session, by its title (`deriveSearchResults`,
 * dsh-client-ui-workspace `lib/client.js:1182-1183`), the group the tree files it under — so `app session` reads `app`,
 * not the root above it. The search hit has done that since it matched workspace names; the one-column row named the
 * longest top-level root that held the folder, so it read the outer workspace. DSH's flat rows carry no workspace
 * (`sessionNode`, `lib/client.js:1059-1073`); heddle's row does, and it must name the same workspace the tree does.
 */
test('a session in a nested registered workspace is named after that workspace: in a search hit and in the one-column list', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const fixture = await seeded('nested-name')
  const browser = await openBrowser({ width: 1280, height: 720 })
  try {
    const repoLabel = fixture.repo.title
    const appLabel = fixture.inner.title
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor('document.querySelectorAll(\'#tree li[data-kind="session"]\').length > 0', 15_000)

    /** The search: the hit line reads `<workspace> · <age>`. */
    await browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = 'session'; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await browser.waitFor(`[...document.querySelectorAll('#search-results .hit .hit-title')].some((title) => title.textContent === 'app session')`, 10_000)
    const hits = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#search-results .hit')].map((hit) => [hit.querySelector('.hit-title').textContent, hit.querySelector('.hit-workspace').textContent.split(' · ')[0]]))`))
    assert.deepEqual(
      hits.filter(([title]) => title === 'app session' || title === 'repo session 7'),
      [['app session', appLabel], ['repo session 7', repoLabel]],
      `the nested workspace's session names the nested workspace, the outer one's names the outer one\nsaw: ${JSON.stringify(hits)}`,
    )

    /** The one-column list: each row's `.age` reads `<workspace> · <age>` too. */
    await browser.evaluate(`localStorage.setItem('heddle.tree.grouping.v1', 'list')`)
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`[...document.querySelectorAll('#tree li[data-kind="session"] > .row > .label')].some((label) => label.textContent === 'app session')`, 15_000)
    const rows = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree li[data-kind="session"] > .row')].map((row) => [row.querySelector('.label').textContent, row.querySelector('.age').textContent.split(' · ')[0]]))`))
    assert.ok(rows.length >= 9, `the list draws every session as a row\nsaw: ${JSON.stringify(rows)}`)
    assert.deepEqual(
      rows.filter(([title]) => title === 'app session' || title === 'repo session 7'),
      [['app session', appLabel], ['repo session 7', repoLabel]],
      `a row names the nearest registered workspace that holds its session, not the top-level root\nsaw: ${JSON.stringify(rows)}`,
    )
  } finally {
    browser.close()
    fixture.close()
  }
})

test('a session dragged above another switches the order to Manual, and the order is kept across a reload', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH parity C17 (R-developer-eight-20), dsh-client-ui-workspace's *Reordering and view options*: Last updated sorts by
   * the latest prompt; dragging a row edits the saved sequence and selects Manual (client.js:2987-2999 sessionDragOrder,
   * 1297-1302 setSessionOrder); the order and the mode are browser-local and survive a reload (the persisted view store,
   * client.js:1265-1315); choosing Last updated discards the layout. Three of the outer workspace's sessions get a turn,
   * so they lead by prompt time and are draggable (a session with no turn is DSH's blank row, which is not).
   */
  const fixture = await seeded('order')
  const browser = await openBrowser()
  try {
    for (const id of fixture.created.slice(0, 3)) {
      const turn = await api(fixture.url, fixture.cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ session: id, prompt: 'a prompt that dates this row' }) })
      assert.equal(turn.status, 200, `the turn ran (${JSON.stringify(turn.body).slice(0, 300)})`)
      await new Promise((done) => setTimeout(done, 20))
    }
    const labels = `JSON.stringify([...document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"] > .row .label')].map((label) => label.textContent))`
    const ready = async () => {
      await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
      await browser.waitFor(`document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"]').length >= 3`, 15_000)
    }
    /** The View options item marked current in the ordering pair. */
    const checkedOrder = `(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      document.querySelector('#view-options button').click()
      await wait(250)
      const items = [...document.querySelectorAll('#view-options .menu:not([hidden]) button')]
      const checked = items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent.trim()).filter((label) => label === 'Manual' || label === 'Last updated')
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return JSON.stringify(checked)
    })()`
    await browser.goto(fixture.url)
    await ready()
    const before = JSON.parse(await browser.evaluate(labels))
    assert.deepEqual(before.slice(0, 3), ['repo session 3', 'repo session 2', 'repo session 1'], `Last updated: the latest prompt first\nsaw: ${JSON.stringify(before)}`)
    assert.deepEqual(JSON.parse(await browser.evaluate(checkedOrder)), ['Last updated'], 'Last updated is the default order')

    /** Drag repo session 1 onto the top half of repo session 3, with the events a pointer drag dispatches. */
    const dragged = JSON.parse(await browser.evaluate(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const rowOf = (text) => [...document.querySelectorAll('#tree > li[data-kind="workspace"] > ul > li[data-kind="session"] > .row')].find((row) => row.querySelector('.label').textContent === text)
      const source = rowOf('repo session 1')
      const target = rowOf('repo session 3')
      if (source === undefined || target === undefined) return JSON.stringify({ error: 'rows not found' })
      const box = target.getBoundingClientRect()
      const at = { clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + 3) }
      const dataTransfer = new DataTransfer()
      const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...at }))
      const draggable = source.draggable
      fire(source, 'dragstart')
      fire(target, 'dragenter')
      const accepted = !fire(target, 'dragover')
      const marker = target.closest('li').dataset.drop ?? null
      fire(target, 'drop')
      fire(source, 'dragend')
      await wait(1500)
      return JSON.stringify({ draggable, accepted, marker, stored: localStorage.getItem('heddle.tree.order.v1') })
    })()`))
    assert.equal(dragged.error, undefined, `the rows were found\nsaw: ${JSON.stringify(dragged)}`)
    assert.equal(dragged.draggable, true, 'a session row with a turn is draggable')
    assert.equal(dragged.accepted, true, 'a row of the same list accepts the drag')
    assert.equal(dragged.marker, 'before', 'and marks the half it would land on')
    const afterDrag = JSON.parse(await browser.evaluate(labels))
    assert.deepEqual(afterDrag.slice(0, 3), ['repo session 1', 'repo session 3', 'repo session 2'], `the dragged row is above its target\nsaw: ${JSON.stringify(afterDrag)}`)
    assert.equal(JSON.parse(String(dragged.stored)).orderBy, 'manual', `the order is stored in the browser as Manual\nsaw: ${dragged.stored}`)
    assert.deepEqual(JSON.parse(await browser.evaluate(checkedOrder)), ['Manual'], 'View options now marks Manual')

    /** A reload keeps both the mode and the order. */
    await browser.goto(fixture.url)
    await ready()
    const reloaded = JSON.parse(await browser.evaluate(labels))
    assert.deepEqual(reloaded.slice(0, 3), ['repo session 1', 'repo session 3', 'repo session 2'], `the order survives a reload\nsaw: ${JSON.stringify(reloaded)}`)
    assert.deepEqual(JSON.parse(await browser.evaluate(checkedOrder)), ['Manual'], 'and so does the mode')

    /** Choosing Last updated discards the manual layout. */
    await browser.evaluate(`(async () => {
      document.querySelector('#view-options button').click()
      await new Promise((done) => setTimeout(done, 250))
      ;[...document.querySelectorAll('#view-options .menu:not([hidden]) button')].find((item) => item.textContent.trim() === 'Last updated').click()
      await new Promise((done) => setTimeout(done, 1500))
    })()`)
    const restored = JSON.parse(await browser.evaluate(labels))
    assert.deepEqual(restored.slice(0, 3), ['repo session 3', 'repo session 2', 'repo session 1'], `Last updated is back to prompt time\nsaw: ${JSON.stringify(restored)}`)
    assert.equal(JSON.parse(await browser.evaluate(`localStorage.getItem('heddle.tree.order.v1')`) ?? 'null')?.orderBy, 'updated', 'and the browser stores the choice')
  } finally {
    browser.close()
    fixture.close()
  }
})

/**
 * The sidebar search is DSH's local session search (C14). Read from DSH's own source: `deriveSearchResults`
 * (dsh-client-ui-workspace `lib/client.js:1169`) matches the query, trimmed and lower-cased, as a substring of the session's
 * **title or its workspace's name** — never its id — and lists the hits newest first, at most `searchResultLimit` = 20
 * (dsh-api-session-controller `lib/client.js:357`, `:3797`), with `Showing the first 20 results. Narrow your search.` under
 * them when more matched and `No matching sessions` when none did (`lib/client.js:4909-4910`). Choosing a hit
 * (`openSearchResult`, `:3664`) clears the query, opens the session, and reveals its row in the tree: its workspace
 * expanded, the watermark raised to reach it, scrolled into view (`:2269`, `:3081`, `:2830`).
 */
test('the sidebar search finds a title or a workspace name, lists twenty at most, and a chosen hit is opened and revealed', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('tree-search')
  const root = fixtureDir('tree-search-repo')
  const other = fixtureDir('tree-search-other')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const register = async (path) => {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      return added.body.record
    }
    const repo = await register(root)
    const elsewhere = await register(other)
    /** Twenty-two names sharing one word — two more than DSH lists — written oldest first so newest-first has one answer. */
    for (let index = 1; index <= 22; index += 1) {
      const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title: `Capword item ${index}` }) })
      assert.equal(made.status, 200, `created session ${index} (${JSON.stringify(made.body)})`)
      await new Promise((done) => setTimeout(done, 15))
    }
    const weekly = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: other, title: 'weekly sync' }) })
    assert.equal(weekly.status, 200)
    const weeklyId = weekly.body.session

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor('document.querySelectorAll(\'#tree li[data-kind="session"]\').length > 0', 15_000)

    /** Type a query the way a person does, and read what the list shows once it has answered. */
    const searchFor = async (query) => {
      await browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await new Promise((done) => setTimeout(done, 600))
      return JSON.parse(await browser.evaluate(`JSON.stringify({
        treeHidden: document.getElementById('tree').hidden,
        hits: [...document.querySelectorAll('#search-results .hit')].map((hit) => ({ title: hit.querySelector('.hit-title').textContent, where: hit.querySelector('.hit-workspace').textContent })),
        note: document.getElementById('search-note').hidden ? null : document.getElementById('search-note').textContent,
        more: document.getElementById('search-more') === null || document.getElementById('search-more').hidden ? null : document.getElementById('search-more').textContent,
      })`))
    }

    const capped = await searchFor('CAPWORD')
    assert.equal(capped.treeHidden, true, 'a query replaces the tree')
    assert.equal(capped.hits.length, 20, `twenty of the twenty-two matches are listed\nsaw: ${capped.hits.length}`)
    assert.deepEqual(capped.hits.slice(0, 2).map((hit) => hit.title), ['Capword item 22', 'Capword item 21'], 'newest first, whatever the case of the query')
    assert.ok(capped.hits.every((hit) => hit.where.startsWith(repo.title)), `each hit names its workspace\nsaw: ${JSON.stringify(capped.hits[0])}`)
    assert.equal(capped.more, 'Showing the first 20 results. Narrow your search.', 'and the list says it stopped at twenty')

    const byWorkspace = await searchFor(elsewhere.title.toUpperCase())
    assert.deepEqual(byWorkspace.hits.map((hit) => hit.title), ['weekly sync'], `a workspace name finds the session in it\nsaw: ${JSON.stringify(byWorkspace)}`)
    assert.equal(byWorkspace.more, null, 'with no overflow line under one hit')

    const byId = await searchFor(String(weeklyId).slice(0, 20))
    assert.deepEqual(byId.hits, [], `an id is not a name\nsaw: ${JSON.stringify(byId)}`)
    assert.equal(byId.note, 'No matching sessions', 'and an empty answer says so in DSH\'s words')

    /** A hit in the folded workspace: choosing it clears the search, opens the session, and draws its row selected. */
    await searchFor(elsewhere.title)
    await browser.evaluate(`[...document.querySelectorAll('#search-results .hit')].find((hit) => hit.querySelector('.hit-title').textContent === 'weekly sync').click()`)
    await browser.waitFor(`document.getElementById('session-title').textContent.includes('weekly sync')`, 10_000)
    await browser.waitFor(`document.querySelector('#tree li[data-kind="session"][aria-selected="true"]') !== null`, 10_000).catch(() => false)

    /** A row that is shown is selected, inside the scrolling list's box, and the search is gone. */
    const revealed = (title) => browser.evaluate(`JSON.stringify((() => {
      const field = document.getElementById('session-search')
      const li = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((item) => item.querySelector(':scope > .row .label')?.textContent === ${JSON.stringify(title)})
      const scroller = document.getElementById('workspace-scroll').getBoundingClientRect()
      const box = li?.querySelector(':scope > .row').getBoundingClientRect()
      return {
        query: field.value,
        resultsHidden: document.getElementById('search-results').hidden,
        treeHidden: document.getElementById('tree').hidden,
        rowDrawn: li !== undefined,
        selected: li?.getAttribute('aria-selected') ?? null,
        inView: box === undefined ? null : box.top >= scroller.top - 1 && box.bottom <= scroller.bottom + 1,
      }
    })())`).then((text) => JSON.parse(text))
    const weeklyRow = await revealed('weekly sync')
    assert.deepEqual(weeklyRow, { query: '', resultsHidden: true, treeHidden: false, rowDrawn: true, selected: 'true', inView: true }, `the folded workspace opened to the chosen row\nsaw: ${JSON.stringify(weeklyRow)}`)

    /** The oldest of twenty-two sits past the five-row watermark: the reveal raises it so the row is drawn, and scrolls to it. */
    await searchFor('capword item 1')
    await browser.evaluate(`[...document.querySelectorAll('#search-results .hit')].find((hit) => hit.querySelector('.hit-title').textContent === 'Capword item 1').click()`)
    await browser.waitFor(`document.getElementById('session-title').textContent.includes('Capword item 1')`, 10_000)
    await browser.waitFor(`[...document.querySelectorAll('#tree li[data-kind="session"][aria-selected="true"]')].some((li) => li.textContent.includes('Capword item 1'))`, 10_000).catch(() => false)
    const deepRow = await revealed('Capword item 1')
    assert.deepEqual(deepRow, { query: '', resultsHidden: true, treeHidden: false, rowDrawn: true, selected: 'true', inView: true }, `the row past the watermark is drawn and scrolled to\nsaw: ${JSON.stringify(deepRow)}`)
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root, other]) removeDir(dir)
  }
})

/**
 * A failed read is not an empty store (#58). DSH's title and workspace matches are computed over the session list the
 * client already holds (`deriveSearchResults`, dsh-client-ui-workspace `lib/client.js:1169-1187`), so a network failure
 * cannot make them say nothing matched; only the content request can fail (its README, Search). The page used to keep a
 * failed `/api/sessions` read as an empty index: `No matching sessions` beside a tree listing the sessions, and again
 * after the network was back, until something re-read the session list.
 *
 * The browser's own `fetch` is switched to fail `/api/sessions` the way a lost network does, for one search, then back.
 */
test('a search while /api/sessions fails lists the rows the tree holds, and the same search afterwards reads the sessions again', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('tree-search-offline')
  const root = fixtureDir('tree-search-offline-repo')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    for (const title of ['Kestrel plan', 'Kestrel notes', 'weekly sync']) {
      const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: root, title }) })
      assert.equal(made.status, 200, `created ${title} (${JSON.stringify(made.body)})`)
      await new Promise((done) => setTimeout(done, 15))
    }

    browser = await openBrowser({ width: 1280, height: 720 })
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor('document.querySelectorAll(\'#tree li[data-kind="session"]\').length >= 3', 15_000)

    /** While `__sessionsDown` is set, the page's `/api/sessions` requests fail as a request with no network does. */
    await browser.evaluate(`(() => {
      const real = window.fetch.bind(window)
      window.__sessionsDown = true
      window.__sessionReads = 0
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href)
        if (url.pathname === '/api/sessions' && (init?.method ?? 'GET') === 'GET') {
          window.__sessionReads += 1
          if (window.__sessionsDown) return Promise.reject(new TypeError('Failed to fetch'))
        }
        return real(input, init)
      }
      return true
    })()`)

    const searchFor = async (query) => {
      await browser.evaluate(`(() => { const field = document.getElementById('session-search'); field.value = ${JSON.stringify(query)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await new Promise((done) => setTimeout(done, 800))
      return JSON.parse(await browser.evaluate(`JSON.stringify({
        treeHidden: document.getElementById('tree').hidden,
        hits: [...document.querySelectorAll('#search-results .hit')].map((hit) => hit.querySelector('.hit-title').textContent),
        note: document.getElementById('search-note').hidden ? null : document.getElementById('search-note').textContent,
      })`))
    }

    const offline = await searchFor('kestrel')
    await browser.evaluate('(() => { window.__sessionsDown = false; return true })()')
    const online = await searchFor('kestrel')
    const reads = await browser.evaluate('window.__sessionReads')
    assert.deepEqual(
      { offline, online },
      {
        offline: { treeHidden: true, hits: ['Kestrel notes', 'Kestrel plan'], note: null },
        online: { treeHidden: true, hits: ['Kestrel notes', 'Kestrel plan'], note: null },
      },
      `during the failure the search lists the tree's matching rows with no "No matching sessions", and the same search after it finds them from a fresh read (page reads of /api/sessions: ${reads})`,
    )
    assert.ok(reads >= 2, `the failed read was not kept: the search after it asked again (page reads of /api/sessions: ${reads})`)
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})
