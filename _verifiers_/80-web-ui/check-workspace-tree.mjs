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
 * registered workspace owns trails under **Ungrouped**; an open workspace shows five sessions and a `Show {n} more
 * sessions` control (the open New session on top of the five, not in one of their places); the
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
    /** DSH's `sessions.expand`, with the hidden count (dsh-client-ui-workspace lib/client.js:3325, :4897). */
    assert.equal(inside[kinds.indexOf('more')][1], 'Show 2 more sessions')

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

test('Show more counts conversations: the open New session sits on top of five, and the control says how many it hides (#54)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH shows every blank row plus the first five non-blank ones, and its control reads `Show {n} more sessions` with
   * the hidden count (`watermarkRows` and the overflow button, dsh-client-ui-workspace lib/client.js:2807-2819,
   * :3309-3325, :4897). Before the fix the open New session took one of the five places, so the workspace showed four
   * conversations, and the control said only `Show more` (#54).
   */
  const fixture = await seeded('blank')
  const browser = await openBrowser()
  const group = `document.querySelector('#tree > li[data-kind="workspace"] > ul[role="group"]')`
  const rows = `JSON.stringify({
    ids: [...${group}.querySelectorAll(':scope > li[data-kind="session"]')].map((li) => li.dataset.sessionId),
    labels: [...${group}.querySelectorAll(':scope > li[data-kind="session"] > .row .label')].map((label) => label.textContent),
    control: ${group}.querySelector(':scope > li[data-kind="more"] .label')?.textContent ?? null,
  })`
  try {
    await browser.goto(fixture.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`${group} !== null && ${group}.querySelectorAll(':scope > li[data-kind="session"]').length > 0`, 15_000)
    await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > .row button[aria-label="New session in ${fixture.repo.title}"]').click()`)
    const blank = `${group}.querySelector(':scope > li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    assert.ok(
      await browser.waitFor(`(() => { const id = ${blank}; return id !== null && !${JSON.stringify(fixture.created)}.includes(id) })()`, 15_000),
      'the workspace\'s + opens a New session in it',
    )
    const id = await browser.evaluate(blank)
    const sessions = ['repo session 7', 'repo session 6', 'repo session 5', 'repo session 4', 'repo session 3']
    const collapsed = JSON.parse(await browser.evaluate(rows))
    assert.equal(collapsed.ids[0], id, `the open New session leads\nsaw: ${JSON.stringify(collapsed)}`)
    assert.deepEqual(collapsed.labels.slice(1), sessions, `and the five newest conversations follow it: it took none of their places\nsaw: ${JSON.stringify(collapsed)}`)
    assert.equal(collapsed.control, 'Show 2 more sessions', 'the control names the two it hides, in DSH\'s words')

    await browser.evaluate(`${group}.querySelector(':scope > li[data-kind="more"] > .row').click()`)
    const expanded = JSON.parse(await browser.evaluate(rows))
    assert.equal(expanded.ids.length, 8, `a click shows the rest: the New session and all seven\nsaw: ${JSON.stringify(expanded)}`)
    assert.equal(expanded.control, 'Show less')
    await browser.evaluate(`${group}.querySelector(':scope > li[data-kind="more"] > .row').click()`)
    assert.deepEqual(JSON.parse(await browser.evaluate(rows)), collapsed, 'and Show less goes back to the five and the New session')
  } finally {
    browser.close()
    fixture.close()
  }
})

test('New session starts in the workspace row the person opened, not in the open session\'s (#25)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH starts a session where the person acted: a workspace row's `+` names its workspace, and a named workspace wins
   * over the open session's (dsh-client-ui-workspace lib/client.js:3233-3236, :1508). The Session Intent hero picker
   * (C36) changes a blank session's target; for the panel's button and chord, opening workspace B's row after a session
   * in A is that act, and New session and its chord start in B. With no workspace row opened since the session was
   * chosen, the open session's workspace is the target, as DSH's is. Before the fix both presses started in A (#25).
   */
  const home = isolatedHome('tree-target')
  const first = fixtureDir('tree-target-a')
  const second = fixtureDir('tree-target-b')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const register = async (path) => {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      return added.body.record
    }
    const a = await register(first)
    const b = await register(second)
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: a.path, title: 'work in a' }) })
    assert.equal(made.status, 200, `a session in A (${JSON.stringify(made.body)})`)
    const inA = made.body.session

    const workspaceRow = (record) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const openId = `document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    const cwdOf = async (id) => {
      const listed = (await api(server.url, cookie, '/api/sessions')).body
      return (Array.isArray(listed) ? listed : []).find((meta) => meta.id === id)?.cwd ?? null
    }
    /** What the page shows, for a failure message: the open row, the header, the note, and every session row. */
    const state = () =>
      browser.evaluate(`JSON.stringify({
        open: ${openId},
        title: document.getElementById('session-title')?.textContent ?? null,
        note: document.getElementById('tree-note')?.textContent ?? null,
        rows: [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => [li.dataset.sessionId, li.getAttribute('aria-selected')]),
      })`)
    /** Wait for a condition, and say what the page showed when it did not come. */
    const until = async (expression, what, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    /** Open the session in A from its row, as a person does, and let the click's handler finish loading it. */
    const openA = async () => {
      await browser.evaluate(`(() => { const row = ${workspaceRow(a)}; if (row.closest('li').dataset.open !== 'true') row.click() })()`)
      await until(`document.querySelector('#tree li[data-session-id="${inA}"] > .row') !== null`, 'the session in A is drawn')
      await browser.evaluate(`document.querySelector('#tree li[data-session-id="${inA}"] > .row').click()`)
      await until(`${openId} === ${JSON.stringify(inA)}`, 'the session in A is the open one')
      await new Promise((done) => setTimeout(done, 1_000))
    }
    /** Click a workspace row so that it opens (folding it first when it is already open). */
    const openWorkspace = async (record) => {
      await browser.evaluate(`(() => { const row = ${workspaceRow(record)}; if (row.closest('li').dataset.open === 'true') row.click() })()`)
      await browser.evaluate(`${workspaceRow(record)}.click()`)
      await until(`${workspaceRow(record)}.closest('li').dataset.open === 'true'`, 'the workspace row opens')
    }
    /** Press New session, by the panel's button or by DSH's chord, and answer with the session it opened. */
    const press = async (how) => {
      const before = await browser.evaluate(openId)
      if (how === 'button') await browser.evaluate(`document.getElementById('new-session').click()`)
      else await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, metaKey: true, bubbles: true }))`)
      await until(`(() => { const id = ${openId}; return id !== null && id !== ${JSON.stringify(before)} })()`, `the ${how} opens a new session`, 15_000)
      return browser.evaluate(openId)
    }

    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`${workspaceRow(a)} !== undefined && ${workspaceRow(b)} !== undefined`, 15_000)

    await openA()
    await openWorkspace(b)
    const byButton = await press('button')
    assert.equal(await cwdOf(byButton), b.path, 'after opening B\'s row, the button starts the session in B, not in the open session\'s A')
    await until(`${workspaceRow(b)}.closest('li').querySelector('li[data-session-id="${byButton}"]') !== null`, 'and it is drawn under B')

    await openA()
    await openWorkspace(b)
    const byChord = await press('chord')
    assert.equal(await cwdOf(byChord), b.path, 'and so does the chord')

    await openA()
    const plain = await press('button')
    assert.equal(await cwdOf(plain), a.path, 'with no workspace row opened since the session was opened, New session starts in the open session\'s workspace')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, first, second]) removeDir(dir)
  }
})

/** One key the way a keyboard sends it — the protocol's key events, as check-model-switcher.mjs's `press` does. */
async function press(browser, key) {
  const keys = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  }
  const description = keys[key]
  const common = { key, code: description.code, windowsVirtualKeyCode: description.keyCode, nativeVirtualKeyCode: description.keyCode }
  await browser.send('Input.dispatchKeyEvent', {
    type: description.text === undefined ? 'rawKeyDown' : 'keyDown',
    ...common,
    ...(description.text === undefined ? {} : { text: description.text, unmodifiedText: description.text }),
  })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

/**
 * C36, DSH's Session Intent hero picker (`dsh-client-ui-conversation` `WorkspaceChip` and `selectWorkspace`,
 * `dsh-client-ui-workspace` `WorkspacePickFlow`): over a blank session the hero row carries a chip named `Choose
 * workspace` showing the session's workspace; its menu lists every workspace with that one checked and `Add workspace…`
 * last; the keys move, wrap and Escape back to the chip; a pick moves the new session — draft included — to the other
 * workspace, and the first prompt runs there while the session left behind stays empty.
 */
test('the Session Intent hero picks the workspace for a blank session, by keyboard, and the first prompt runs there', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('tree-hero')
  const alphaDir = fixtureDir('tree-hero-alpha')
  const betaDir = fixtureDir('tree-hero-beta')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  try {
    const cookie = await cookieFor(server.url)
    const register = async (path) => {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      return added.body.record
    }
    /**
     * Both stores list a newly added workspace first, as DSH does (TS src/workspace/service.ts:208, Rust heddle-workspace
     * service.rs:232, DSH dsh-workspace lib/index.js:687), and the menu keeps that record order. Beta is registered
     * first so that alpha, the blank session's workspace, is the top item.
     */
    const beta = await register(betaDir)
    const alpha = await register(alphaDir)
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: alpha.path }) })
    assert.equal(made.status, 200, `a blank session in the first workspace (${JSON.stringify(made.body)})`)
    const alphaBlank = made.body.session

    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`document.getElementById('session-branch').textContent === ${JSON.stringify(alpha.path)}`, 15_000)
    const appeared = await browser.waitFor(`document.getElementById('hero-workspace')?.hidden === false`, 10_000).catch(() => false)
    assert.ok(appeared, 'with a blank session open the hero row shows a workspace chip above the composer')
    const chip = JSON.parse(
      await browser.evaluate(`(() => {
        const chip = document.getElementById('hero-workspace-chip')
        return JSON.stringify({ name: chip.getAttribute('aria-label'), popup: chip.getAttribute('aria-haspopup'), expanded: chip.getAttribute('aria-expanded'), label: chip.querySelector('.label').textContent })
      })()`),
    )
    assert.deepEqual(chip, { name: 'Choose workspace', popup: 'menu', expanded: 'false', label: alpha.title }, 'DSH\'s chip, naming the session\'s workspace')

    /** Opened from the keyboard: the workspaces in order, the current one checked, Add workspace… last. */
    const focusedLabel = `document.activeElement?.querySelector?.('.label')?.textContent ?? document.activeElement?.id ?? null`
    await browser.evaluate(`document.getElementById('hero-workspace-chip').focus()`)
    await press(browser, 'Enter')
    await browser.waitFor(`document.querySelectorAll('#hero-workspace-menu [role="menuitemradio"]').length === 2`, 10_000)
    const menu = JSON.parse(
      await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#hero-workspace-menu button')].map((item) => [item.getAttribute('role'), item.querySelector('.label').textContent, item.getAttribute('aria-checked')]))`),
    )
    assert.deepEqual(
      menu,
      [
        ['menuitemradio', alpha.title, 'true'],
        ['menuitemradio', beta.title, 'false'],
        ['menuitem', 'Add workspace…', null],
      ],
      'every workspace, the current one checked, then Add workspace…',
    )
    await press(browser, 'ArrowDown')
    assert.equal(await browser.evaluate(focusedLabel), alpha.title, 'ArrowDown from the chip lands on the first item')
    await press(browser, 'ArrowDown')
    assert.equal(await browser.evaluate(focusedLabel), beta.title)
    await press(browser, 'ArrowDown')
    await press(browser, 'ArrowDown')
    assert.equal(await browser.evaluate(focusedLabel), alpha.title, 'the arrows wrap')
    await press(browser, 'ArrowUp')
    assert.equal(await browser.evaluate(focusedLabel), 'Add workspace…')
    await press(browser, 'Escape')
    const closed = JSON.parse(
      await browser.evaluate(`JSON.stringify({ hidden: document.getElementById('hero-workspace-menu').hidden, focus: document.activeElement?.id ?? null, expanded: document.getElementById('hero-workspace-chip').getAttribute('aria-expanded') })`),
    )
    assert.deepEqual(closed, { hidden: true, focus: 'hero-workspace-chip', expanded: 'false' }, 'Escape closes the menu and returns to the chip')

    /** A draft typed first, then the other workspace picked with Enter. */
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'where does this run'; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await browser.evaluate(`document.getElementById('hero-workspace-chip').focus()`)
    await press(browser, 'Enter')
    await browser.waitFor(`document.querySelectorAll('#hero-workspace-menu [role="menuitemradio"]').length === 2`, 10_000)
    await press(browser, 'ArrowDown')
    await press(browser, 'ArrowDown')
    await press(browser, 'Enter')
    await browser.waitFor(`document.getElementById('session-branch').textContent === ${JSON.stringify(beta.path)}`, 15_000)
    assert.ok(
      await browser
        .waitFor(`document.getElementById('hero-workspace').hidden === false && document.querySelector('#hero-workspace-chip .label')?.textContent === ${JSON.stringify(beta.title)}`, 10_000)
        .catch(() => false),
      'the new session is open in the picked workspace, still blank, and the chip names it',
    )
    assert.equal(await browser.evaluate(`document.querySelector('#prompt textarea').value`), 'where does this run', 'the draft went with it')

    /** The first prompt runs in the picked workspace; the session left behind stays empty. */
    await browser.evaluate(`document.getElementById('send').click()`)
    let ran = null
    for (let attempt = 0; attempt < 60 && ran === null; attempt += 1) {
      const listed = await api(server.url, cookie, '/api/sessions')
      ran = (Array.isArray(listed.body) ? listed.body : []).find((meta) => (meta.turns ?? 0) > 0) ?? null
      if (ran === null) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(ran !== null, 'the prompt ran')
    assert.equal(ran.cwd, beta.path, 'in the picked workspace')
    assert.notEqual(ran.id, alphaBlank, 'not in the blank session it started from')
    const left = (await api(server.url, cookie, '/api/sessions')).body.find((meta) => meta.id === alphaBlank)
    assert.equal(left?.turns ?? 0, 0, 'which stays empty')
    assert.ok(await browser.waitFor(`document.getElementById('hero-workspace').hidden === true`, 10_000).catch(() => false), 'and the hero row goes once the prompt is drawn')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, alphaDir, betaDir]) removeDir(dir)
  }
})
