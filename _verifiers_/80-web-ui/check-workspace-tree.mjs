import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, listFiles, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The left column is a **workspace tree** after DSH's workspace browser (owner goal G2, 2026-10-28).
 *
 * The claim, in DSH's terms: workspaces are groups, each with its sessions nested under it; a workspace registered
 * inside another nests under it (`Workspace Tree`) with its row **before** the parent's own sessions; a session no
 * registered workspace owns trails under **Ungrouped**; an open workspace shows five sessions and a `Show {n} more
 * sessions` control (the open New session on top of the five, not in one of their places); the
 * selected session's workspace tints its folder; a workspace's `+` starts a session there; New session starts in the
 * open session's workspace even when that session is archived and its row is not drawn (#119); the `Workspace` grouping
 * draws every workspace as a sibling section; a reload reopens the session that was open, never a hidden subagent
 * child; a first visit opens a fresh New session, never the newest session someone else is in, on a blank row that
 * offers no actions; and a session row whose session can no longer be read opens to DSH's "Failed to load history" line
 * with the composer disabled, not to a blank page that takes a message (#56); first use's Default workspace stays the
 * new conversation's place across a reload, named so by the hero and the note, and a message with no workspace to go
 * to is refused rather than run in the server's start folder (#134); Archived only with nothing archived says DSH's
 * "No archived sessions yet" with a View other sessions action, not that no workspace is registered (#107); and a
 * folder the server may not read, or a workspace whose folder it may not read, draws DSH's one failure line
 * ("Read failed: …"), never "nothing inside" (#106).
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
    /**
     * Judged by a row that was not drawn before, not by a count: the first visit started its fresh New session in this
     * workspace, the most recently active one (#17), and that blank stops being a row once another session is open
     * (DSH's sessionVisible), which the page's next redraw may do while the + is being pressed.
     */
    const nestedRows = `[...document.querySelectorAll('#tree li[data-kind="workspace"] li[data-kind="workspace"] li[data-kind="session"]')]`
    const before = JSON.parse(await browser.evaluate(`JSON.stringify(${nestedRows}.map((li) => li.dataset.sessionId))`))
    await browser.evaluate(`document.querySelector('#tree li[data-kind="workspace"] li[data-kind="workspace"] > .row button[aria-label="New session in ${appLabel}"]').click()`)
    assert.ok(
      await browser.waitFor(`${nestedRows}.some((li) => !${JSON.stringify(before)}.includes(li.dataset.sessionId))`, 15_000),
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

test('New session starts where the open session lives when that session is archived and its row is not drawn, not in the last remembered folder (#119)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's New session starts in the open session's workspace, found in its whole workspace list by the account that names
   * the session (dsh-client-ui-workspace lib/client.js:1503-1508), and archiving keeps that account (dsh-workspace
   * lib/index.js:232-233; README "Archive filtering alone changes neither saved positions nor account membership"). #119:
   * the page looked the open session up among the drawn groups only, so with an archived session open under Hide archived
   * it missed and the session started in the last remembered folder — on the shared server another person's project.
   *
   * The newer session in A is opened first (by its saved selection, then its row, which aims the prompt box at A), then
   * the archived session in B by id. A page holds an archived session open once a person archives the session they have
   * open (heddle keeps it on screen, where DSH's `clearArchivedCurrent` empties the view); an archived row does not open
   * (`guardedOpen`), and a load does not reopen an archived saved session (restoreChoice, after DSH's restoreSelection).
   * So B, archived first, is opened through the page's verifier seam `showSession(id)`, the call a search hit makes,
   * which leaves the prompt box aimed at A as a session opened from search and then archived does. A is registered last,
   * so it is drawn first, and both fallbacks the bug used — the remembered folder and the first drawn workspace — point
   * at A.
   */
  const home = isolatedHome('tree-archived-target')
  const first = fixtureDir('tree-archived-target-a')
  const second = fixtureDir('tree-archived-target-b')
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
    const b = await register(second)
    const a = await register(first)
    const putAway = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: b.path, title: 'put away in b' }) })
    assert.equal(putAway.status, 200, `a session in B (${JSON.stringify(putAway.body)})`)
    const inB = putAway.body.session
    const archived = await api(server.url, cookie, `/api/sessions/${inB}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
    assert.equal(archived.status, 200, `the session in B is archived (${JSON.stringify(archived.body)})`)
    await new Promise((done) => setTimeout(done, 20))
    const newer = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: a.path, title: 'newer work in a' }) })
    assert.equal(newer.status, 200, `a newer session in A (${JSON.stringify(newer.body)})`)
    const inA = newer.body.session
    const listed = (await api(server.url, cookie, '/api/workspaces')).body.workspaces
    assert.deepEqual(listed.filter((entry) => entry.origin === 'added').map((entry) => entry.path), [a.path, b.path], 'A is first in the registry, so the tree draws it first')
    assert.deepEqual(listed.find((entry) => entry.id === b.id)?.sessionIds, [inB], 'and B still accounts for its archived session')

    const workspaceRow = (record) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const openId = `document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    const cwdOf = async (id) => {
      const sessions = (await api(server.url, cookie, '/api/sessions')).body
      return (Array.isArray(sessions) ? sessions : []).find((meta) => meta.id === id)?.cwd ?? null
    }
    const state = () =>
      browser.evaluate(`JSON.stringify({
        open: ${openId},
        title: document.getElementById('session-title')?.textContent ?? null,
        note: document.getElementById('tree-note')?.textContent ?? null,
        archived: localStorage.getItem('heddle.tree.archived.v1'),
        rows: [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => [li.dataset.sessionId, li.getAttribute('aria-selected')]),
      })`)
    const until = async (expression, what, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }

    /** A first: its saved selection opens it, and a click on its row aims the prompt box at A, as a person's would. */
    await browser.gotoSession(server.url, inA)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await until(`${workspaceRow(a)} !== undefined && ${workspaceRow(b)} !== undefined`, 'both workspaces are drawn', 15_000)
    await until(`document.getElementById('session-title').textContent.includes('newer work in a')`, 'the saved session in A is open')
    await browser.evaluate(`(() => { const row = ${workspaceRow(a)}; if (row.closest('li').dataset.open !== 'true') row.click() })()`)
    await until(`document.querySelector('#tree li[data-session-id="${inA}"] > .row') !== null`, 'the session in A is drawn')
    await browser.evaluate(`document.querySelector('#tree li[data-session-id="${inA}"] > .row').click()`)
    await until(`${openId} === ${JSON.stringify(inA)}`, 'the session in A is the selected row')
    await new Promise((done) => setTimeout(done, 1_000))

    /** Then the archived session in B, by id; under Hide archived its row is not drawn. */
    await browser.evaluate(`showSession(${JSON.stringify(inB)}).then(() => true)`)
    await until(`document.getElementById('session-title').textContent.includes('put away in b')`, 'the archived session in B is open')
    await new Promise((done) => setTimeout(done, 1_000))
    const before = JSON.parse(await state())
    assert.equal(before.archived ?? 'hide', 'hide', `the tree hides archived sessions\nsaw: ${JSON.stringify(before)}`)
    assert.equal(before.rows.some(([id]) => id === inB), false, `so the open archived session has no row\nsaw: ${JSON.stringify(before)}`)

    await browser.evaluate(`document.getElementById('new-session').click()`)
    await until(
      `(() => { const id = ${openId}; return id !== null && id !== ${JSON.stringify(inA)} && id !== ${JSON.stringify(inB)} })()`,
      'New session opens a new session',
      15_000,
    )
    const made = await browser.evaluate(openId)
    const cwd = await cwdOf(made)
    assert.equal(
      cwd,
      b.path,
      `New session starts in B, where the open archived session lives, not in A (the remembered folder and the first drawn workspace)\nA: ${a.path}\nsaw: ${await state()}`,
    )
    await until(`${workspaceRow(b)}.closest('li').querySelector('li[data-session-id="${made}"]') !== null`, 'and the new session is drawn under B')
  } finally {
    await browser.close()
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
    /** The page opens no session on its own (#17), so the blank it is about is named. */
    await browser.gotoSession(server.url, alphaBlank)
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

test('a new session reads New Session in the tree, shows no id in the header, and both follow its title once it has one (#24)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH: the open blank row reads `New Session` and a row without a stored title `Untitled`, "rather than a directory name"
   * (dsh-client-ui-workspace lib/client.js:1801-1804, :4876-4877, README.md:32); the conversation header shows no title
   * while the session is blank and then the session's title, read from the live list (dsh-client-ui-conversation
   * lib/client.js:17897-17908, :17990-17994); the window title is `<title> — <product>`, else the product
   * (dsh-client-ui-layout lib/client.js:57-68). Before the fix a New session row read its definition folder's
   * `session-<yyyymmdd>-<hhmm>`, the header the raw `session-<uuid>`, and the header kept the id after the first prompt
   * had titled the session, until a reload (#24).
   */
  const home = isolatedHome('tree-label')
  const folder = fixtureDir('tree-label-work')
  mkdirSync(folder, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ purpose: 'session-title', text: 'Why Rivers Meander' }, { text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const workspace = added.body.record
    const openId = `document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    const reading = `JSON.stringify({
      id: ${openId},
      row: document.querySelector('#tree li[data-kind="session"][aria-selected="true"] > .row > .label')?.textContent ?? null,
      header: document.getElementById('session-title').textContent,
      headerShown: !document.getElementById('session-title').hidden,
      window: document.title,
    })`

    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.waitFor(`document.querySelector('#tree > li[data-kind="workspace"] > .row button[aria-label="New session in ${workspace.title}"]') !== null`, 15_000)
    await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > .row button[aria-label="New session in ${workspace.title}"]').click()`)
    assert.ok(await browser.waitFor(`${openId} !== null`, 15_000), 'the workspace\'s + opens a New session, selected')
    /** The header is painted once the session's own answer is back; give it that moment before reading. */
    await new Promise((done) => setTimeout(done, 1_000))
    const blank = JSON.parse(await browser.evaluate(reading))
    assert.equal(blank.row, 'New Session', `the blank row reads New Session, not its folder's name\nsaw: ${JSON.stringify(blank)}`)
    assert.ok(!blank.header.includes(blank.id) && !/session-/.test(blank.header), `the header shows no session id\nsaw: ${JSON.stringify(blank)}`)
    assert.equal(blank.headerShown, false, `and, as DSH's, no title at all while the session is blank\nsaw: ${JSON.stringify(blank)}`)
    assert.equal(blank.window, 'Heddle', 'the window title is the product while the session has no title')

    /**
     * The first prompt, sent as another client would send it: the page hears of it only through its event stream and its
     * own refresh, which is the path the header has to follow (the issue's header stayed on the id for 24 s and more).
     */
    await browser.evaluate(`(() => { window.__turn = fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'why do rivers meander?', session: ${JSON.stringify(blank.id)} }) }); return true })()`)
    const titled = `(() => { const r = JSON.parse(${reading}); return r.row !== null && r.row !== 'New Session' && r.headerShown && r.header === r.row })()`
    const followed = await browser.waitFor(titled, 20_000).catch(() => false)
    const after = JSON.parse(await browser.evaluate(reading))
    assert.ok(followed, `once titled, the header shows the title the row shows\nsaw: ${JSON.stringify(after)}`)
    assert.equal(after.id, blank.id, 'in the same session')
    assert.ok(!after.header.includes(after.id), 'and never the id')
    assert.equal(after.window, `${after.row} — Heddle`, 'and the window title is the title, then the product')

    /** A title written later — here by the row's own Rename — is followed too, without a reload. */
    const renamedTo = 'Rivers, renamed'
    const opened = await browser.evaluate(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const row = document.querySelector('#tree li[data-kind="session"][aria-selected="true"] > .row')
      const menu = row === null ? undefined : [...row.querySelectorAll('button')].find((button) => button.textContent === '…')
      if (menu === undefined) return 'the open row carries no menu'
      menu.click(); await wait(250)
      const item = [...document.querySelectorAll('#tree .menu:not([hidden]) button')].find((button) => button.textContent === 'Rename')
      if (item === undefined) return 'the menu carries no Rename'
      item.click(); await wait(250)
      const input = document.getElementById('session-rename-input')
      input.value = ${JSON.stringify(renamedTo)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('session-rename-confirm').click()
      return 'renamed'
    })()`)
    assert.equal(opened, 'renamed', 'the open row is renamed from its menu')
    const follows = `(() => { const r = JSON.parse(${reading}); return r.row === ${JSON.stringify(renamedTo)} && r.header === ${JSON.stringify(renamedTo)} && r.window === ${JSON.stringify(`${renamedTo} — Heddle`)} })()`
    assert.ok(
      await browser.waitFor(follows, 10_000).catch(() => false),
      `the row, the header and the window title all follow the new title\nsaw: ${await browser.evaluate(reading)}`,
    )
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(folder)
  }
})

test('a reload reopens the session that was open, never a hidden subagent child, and a saved one that is gone starts fresh (C28, C33)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH keeps the open session in localStorage (`dsh.sessions.current`, dsh-client-ui-workspace lib/client.js:1369,
   * :1662-1665) and its restoreSelection reopens it on load (:1605-1616); a saved blank is reopened by its own id
   * (:1451-1458, :1619); a saved session that is gone starts a fresh one in the most recently active workspace (:1620,
   * :1626, :1694-1710). Phase A (C28, C33) measured both builds opening `/api/sessions`[0] on every load, there a
   * subagent's child the tree hides: the session a person had open was gone after a reload, and a folded workspace no
   * longer tinted its folder.
   *
   * The store is written before the server starts, by the TypeScript store (the log format's implementation, as the
   * team-view check does), so the child is the newest session in both builds.
   */
  const home = isolatedHome('tree-restore')
  const work = fixtureDir('tree-restore-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const { SessionStore } = await import('../../src/session/store.ts')
  const store = new SessionStore(root)
  const pause = () => new Promise((done) => setTimeout(done, 40))
  const alpha = store.create({ cwd: work, title: 'alpha notes' })
  await pause()
  store.create({ cwd: work, title: 'beta notes' })
  await pause()
  const child = store.create({ cwd: work, title: 'child task', parentSession: alpha.id, origin: 'subagent', delegationDepth: 1 })
  store.message(child, { role: 'user', content: [{ type: 'text', text: 'the delegated task' }] })
  store.append(child, { type: 'assistant/completed', text: 'child done' })

  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', root], { HEDDLE_HOME: home, HEDDLE_CONFIG: config })
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const record = added.body.record
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }
    const first = await listed()
    assert.equal(first[0]?.id, child.id, `the newest session is the subagent's child, the one a load used to open\nsaw: ${JSON.stringify(first.map((meta) => [meta.title, meta.origin ?? null]))}`)

    const title = `(document.getElementById('session-title')?.textContent ?? null)`
    /**
     * A New session shows no title in the header, as DSH's does while a session is blank (#24, page-polish): that, with
     * the saved id, is how a load is seen to have opened the fresh session rather than nothing ("No session").
     */
    const blankOpen = `(document.getElementById('session-title')?.hidden === true)`
    const workspaceRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        title: ${title},
        titleHidden: document.getElementById('session-title')?.hidden ?? null,
        saved: localStorage.getItem('heddle.sessions.current'),
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.dataset.sessionId ?? li.textContent.trim()),
        workspace: (() => { const li = ${workspaceRow}?.closest('li'); return li === undefined || li === null ? null : { open: li.dataset.open ?? null, tinted: li.dataset.containsCurrent ?? null } })(),
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    const load = async () => {
      await browser.goto(server.url)
      await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    }

    /**
     * A first visit has nothing saved: a fresh New session opens, as DSH's does (#17), never the newest conversation nor the
     * hidden child that is newer still.
     */
    const seeded = JSON.stringify(first.map((meta) => meta.id))
    await load()
    await until(
      `(() => { const id = ${saved}; return typeof id === 'string' && !${seeded}.includes(id) && ${blankOpen} })()`,
      'a first visit opens a fresh New session, not the newest conversation and not the hidden subagent child',
    )

    /** Open alpha from its row, reload: alpha is open again and its row is the selected one. */
    await until(`document.querySelector('#tree li[data-session-id="${alpha.id}"] > .row') !== null`, 'alpha\'s row is drawn')
    await browser.evaluate(`document.querySelector('#tree li[data-session-id="${alpha.id}"] > .row').click()`)
    await until(`${title} === 'alpha notes'`, 'alpha opens from its row')
    await load()
    await until(`${title} === 'alpha notes'`, 'a reload reopens the session that was open, not the newest one')
    await until(`document.querySelector('#tree li[data-session-id="${alpha.id}"][aria-selected="true"]') !== null`, 'and its row is the selected one')

    /** C33: fold the workspace and reload: alpha is still open, the fold is remembered, and the folder is tinted. */
    await browser.evaluate(`(() => { const row = ${workspaceRow}; if (row.closest('li').dataset.open === 'true') row.click() })()`)
    await until(`${workspaceRow}.closest('li').dataset.open !== 'true'`, 'the workspace folds')
    await load()
    await until(`${title} === 'alpha notes'`, 'with its workspace folded, a reload still reopens the session that was open')
    await until(
      `(() => { const li = ${workspaceRow}?.closest('li'); return li !== undefined && li !== null && li.dataset.open !== 'true' && li.dataset.containsCurrent === 'true' })()`,
      'the folded workspace stays folded and tints its folder as the one holding the open session',
    )

    /** A saved session that is gone: a fresh session starts in the most recently active workspace, and the fold stays. */
    await browser.evaluate(`localStorage.setItem('heddle.sessions.current', JSON.stringify({ sessionId: 'session-00000000-0000-4000-8000-000000000000' }))`)
    const before = (await listed()).map((meta) => meta.id)
    await load()
    await until(
      `(() => { const id = ${saved}; return typeof id === 'string' && !${JSON.stringify(before)}.includes(id) && ${blankOpen} })()`,
      'a saved session that is gone starts a fresh one, which is open and kept',
    )
    const fresh = await browser.evaluate(saved)
    const after = await listed()
    assert.equal(after.length, before.length + 1, 'exactly one session started')
    const owner = ((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []).find((entry) => entry.id === record.id)
    assert.ok(owner?.sessionIds?.includes(fresh), `in the most recently active workspace\nsaw: ${JSON.stringify(owner)}`)
    assert.notEqual(await browser.evaluate(`${workspaceRow}.closest('li').dataset.open ?? null`), 'true', 'and the workspace the person folded stays folded')

    /** That New session is saved like any other: the next reload reopens it rather than starting another. */
    await load()
    await until(`${saved} === ${JSON.stringify(fresh)} && ${blankOpen}`, 'a reload reopens the saved New session')
    assert.equal((await listed()).length, after.length, 'and starts no other session')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, work]) removeDir(dir)
  }
})

test('a first visit opens a fresh New session, never the newest session someone else is in, and the blank row offers no actions (#17, #79)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's restoreSelection with nothing saved starts a fresh Session in the most recently active workspace
   * (dsh-client-ui-workspace lib/client.js:1611-1613, :1620, :1626 -> connectBlank :1406, recentWorkspace :1694-1710); it
   * never opens an existing session on its own. #17: on a shared server this page opened the newest session in the store,
   * another person's, showed their transcript, and a message typed without looking went into their conversation. A fresh
   * browser profile is that first visit: nothing is saved. The open blank's row draws no row actions (SessionNodeItem,
   * `!row.blank &&`, :2317-2323) and no double-click rename (:2311), and its fork chord is blocked with
   * `shortcut.noCompletedTurn` (:161-164, :4881). #79: the row offered the full menu and the hover buttons, and Fork came
   * back as the server's refusal with the raw session id in it.
   */
  const home = isolatedHome('tree-first-visit')
  const mine = fixtureDir('tree-first-visit-mine')
  const theirs = fixtureDir('tree-first-visit-theirs')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const records = []
    for (const path of [mine, theirs]) {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
      records.push(added.body.record)
    }
    const theirsRecord = records[1]
    const mineMade = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: mine, title: 'my notes' }) })
    assert.equal(mineMade.status, 200, `my own session (${JSON.stringify(mineMade.body)})`)
    /** Another person's session, in their workspace, with a finished turn: the newest session on the server. */
    const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'their own work', folder: theirs, new: true }) })
    assert.equal(turn.status, 200, `their turn ran (${turn.status})`)
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }
    const before = await listed()
    const other = before[0]
    assert.ok(
      other !== undefined && other.id !== mineMade.body.session && (other.turns ?? 0) > 0,
      `the newest session is the other person's, with a turn\nsaw: ${JSON.stringify(before.map((meta) => [meta.id, meta.title ?? null, meta.turns ?? 0]))}`,
    )

    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        saved: ${saved},
        titleHidden: document.getElementById('session-title')?.hidden ?? null,
        title: document.getElementById('session-title')?.textContent ?? null,
        turns: document.querySelectorAll('#log .turn').length,
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.dataset.sessionId ?? li.textContent.trim()),
      })`)
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const known = JSON.stringify(before.map((meta) => meta.id))
    const opened = await browser
      .waitFor(`(() => { const id = ${saved}; return typeof id === 'string' && !${known}.includes(id) && document.getElementById('session-title')?.hidden === true })()`, 15_000)
      .catch(() => false)
    const first = JSON.parse(await state())
    assert.ok(opened, `a first visit opens a fresh New session, not the newest session on the server\nsaw: ${JSON.stringify(first)}\nnewest: ${other.id}`)
    assert.notEqual(first.saved, other.id, "never the other person's session")
    assert.equal(first.turns, 0, 'and none of their conversation is on screen')
    const after = await listed()
    assert.equal(after.length, before.length + 1, 'exactly one session started')
    assert.equal(after.find((meta) => meta.id === first.saved)?.turns ?? 0, 0, 'and it is blank')
    const owner = ((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []).find((entry) => entry.id === theirsRecord.id)
    assert.ok(owner?.sessionIds?.includes(first.saved), `in the most recently active workspace, DSH's recentWorkspace\nsaw: ${JSON.stringify(owner)}`)

    /** The blank's row, beside the other session's, in the workspace that holds both (opened only if it is folded). */
    const rowOf = (id) => `document.querySelector('#tree li[data-kind="session"][data-session-id="${id}"]')`
    await browser.evaluate(
      `(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        for (let attempt = 0; attempt < 40 && (${rowOf(first.saved)} === null || ${rowOf(other.id)} === null); attempt += 1) {
          const row = [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((entry) => entry.dataset.path === ${JSON.stringify(theirsRecord.path)})
          if (row !== undefined && row.closest('li').dataset.open !== 'true') row.click()
          await wait(250)
        }
        return true
      })()`,
      15_000,
    )
    assert.ok(await browser.waitFor(`${rowOf(first.saved)} !== null && ${rowOf(other.id)} !== null`, 10_000).catch(() => false), `both rows are drawn\nsaw: ${await state()}`)
    const actions = (id) => `(() => {
      const li = ${rowOf(id)}
      li.querySelector(':scope > .row').focus()
      const read = JSON.stringify({
        label: li.querySelector(':scope > .row > .label')?.textContent ?? null,
        selected: li.getAttribute('aria-selected'),
        menu: li.querySelector(':scope > .row .menu-wrap') !== null,
        quick: [...li.querySelectorAll(':scope > .row .session-actions button')].map((button) => button.getAttribute('aria-label')),
        buttons: [...li.querySelectorAll(':scope > .row button')].map((button) => button.getAttribute('aria-label') ?? button.textContent),
      })
      li.querySelector(':scope > .row').blur()
      return read
    })()`
    const blank = JSON.parse(await browser.evaluate(actions(first.saved)))
    assert.deepEqual(
      blank,
      { label: 'New Session', selected: 'true', menu: false, quick: [], buttons: [] },
      `the open blank's row offers no menu, no Archive and no Pin, as DSH's blank row (#79)\nsaw: ${JSON.stringify(blank)}`,
    )
    const theirsRow = JSON.parse(await browser.evaluate(actions(other.id)))
    assert.equal(theirsRow.selected, 'false', `the other person's row is not the open one\nsaw: ${JSON.stringify(theirsRow)}`)
    assert.equal(theirsRow.menu, true, 'while a session that ran a turn keeps its menu')
    assert.deepEqual(theirsRow.quick, ['Archive session', 'Pin session'], 'and its Archive and Pin')

    /** No rename by double-click on the blank's title. */
    await browser.evaluate(`${rowOf(first.saved)}.querySelector(':scope > .row > .label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`)
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(await browser.evaluate(`document.getElementById('session-rename')?.open === true`), false, 'a double-click on its title opens no Rename')

    /** The fork chord on the open blank is refused in DSH's words, with no session id, and forks nothing. */
    await browser.evaluate(`(() => { const note = document.getElementById('tree-note'); note.textContent = ''; note.hidden = true; return true })()`)
    await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, metaKey: true, bubbles: true, cancelable: true }))`)
    const said = await browser.waitFor(`document.getElementById('tree-note').textContent === 'This session has no completed turn'`, 5_000).catch(() => false)
    const note = await browser.evaluate(`document.getElementById('tree-note').textContent`)
    assert.ok(said, `the fork chord on a blank says DSH's shortcut.noCompletedTurn\nsaw: ${JSON.stringify(note)}`)
    assert.doesNotMatch(String(note), /session-/, 'and never shows a session id')
    await new Promise((done) => setTimeout(done, 500))
    assert.equal((await listed()).length, after.length, 'and nothing was forked')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, mine, theirs]) removeDir(dir)
  }
})

test('after first use, a reload still aims the new conversation at Default workspace: the hero and the note name it, and the first message runs there and is in the tree (#134)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH: an empty install opens on its Default workspace with the composer aimed at it (`workspaces.initializeDefault`,
   * dsh-client-ui-workspace README.md:80, lib/client.js:1620-1627), and the Session Intent hero's chip names the workspace
   * the new session uses, by its display title (dsh-client-ui-conversation lib/client.js:17783-17784; the first-use title
   * reads Default workspace in "the hero picker menu", dsh-client-ui-workspace README.md:82). #134 (developer-six, main
   * 7bc2a4ab, both builds): after first use, a reload before the first message left the note empty and the chip reading
   * "Choose workspace", and the message went out with no folder, so the server ran it in its own start folder — outside
   * every workspace, missing from the tree, the header still "No session". The note also said "default-workspace" where
   * the tree said "Default workspace" (P3).
   *
   * An empty home, a fresh browser profile: first load, then a reload before anything is sent, then one message.
   */
  const home = isolatedHome('tree-default-reload')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const chip = `(document.querySelector('#hero-workspace-chip .label')?.textContent ?? null)`
    const note = `(document.getElementById('tree-note')?.hidden === false ? document.getElementById('tree-note').textContent : '')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        chip: ${chip},
        heroShown: document.getElementById('hero-workspace')?.hidden === false,
        note: ${note},
        header: document.getElementById('session-title')?.hidden === false ? document.getElementById('session-title').textContent : null,
        placeholder: document.querySelector('#prompt textarea')?.placeholder ?? null,
        workspaces: [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].map((row) => [row.dataset.path, row.querySelector('.label')?.textContent ?? null]),
        sessions: [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.dataset.sessionId),
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    const load = async () => {
      await browser.goto(server.url)
      await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    }
    const named = `${chip} === 'Default workspace' && ${note} === 'a new conversation in Default workspace'`

    /** First load: first use registers <home>/default-workspace and aims the new conversation at it. */
    await load()
    let record = null
    for (let attempt = 0; attempt < 60 && record === null; attempt += 1) {
      record = ((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? [])[0] ?? null
      if (record === null) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(record !== null, 'first use registered a workspace')
    assert.equal(record.path, realpathSync(join(home, 'default-workspace')), 'the Default workspace, <home>/default-workspace')
    await until(named, 'on the first load the hero chip and the note name Default workspace, as the tree does')

    /** A reload before anything was sent: the page still knows where the new conversation goes. */
    await load()
    await until(
      `${chip} === 'Default workspace'`,
      'after a reload the hero chip still names Default workspace (it read "Choose workspace", #134)',
    )
    await until(`${note} === 'a new conversation in Default workspace'`, 'and so does the note (it was empty, #134)')

    /** One message, sent the way a person sends it. */
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'where does this run'; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await until(`document.getElementById('send').disabled === false`, 'Send is offered for the draft')
    await browser.evaluate(`document.getElementById('send').click()`)
    let ran = null
    for (let attempt = 0; attempt < 60 && ran === null; attempt += 1) {
      const listed = await api(server.url, cookie, '/api/sessions')
      ran = (Array.isArray(listed.body) ? listed.body : []).find((meta) => (meta.turns ?? 0) > 0) ?? null
      if (ran === null) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(ran !== null, `the message ran\nsaw: ${await state()}`)
    assert.equal(ran.cwd, record.path, `in <home>/default-workspace, not in the server's start folder (${repoRoot})`)
    const ranTurns = ((await api(server.url, cookie, '/api/sessions')).body ?? []).filter((meta) => (meta.turns ?? 0) > 0)
    assert.equal(ranTurns.length, 1, 'one conversation ran')
    const owner = ((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []).find((entry) => entry.id === record.id)
    assert.ok(owner?.sessionIds?.includes(ran.id), `the session is the Default workspace's\nsaw: ${JSON.stringify(owner)}`)

    /** In the tree, under Default workspace (opened if it was folded), and the header names it. */
    const rowOf = `document.querySelector('#tree li[data-kind="session"][data-session-id="${ran.id}"]')`
    await browser.evaluate(
      `(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        for (let attempt = 0; attempt < 40 && ${rowOf} === null; attempt += 1) {
          const row = [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((entry) => entry.dataset.path === ${JSON.stringify(record.path)})
          if (row !== undefined && row.closest('li').dataset.open !== 'true') row.click()
          await wait(250)
        }
        return true
      })()`,
      15_000,
    )
    await until(
      `(() => {
        const li = ${rowOf}
        const group = li?.parentElement?.closest('li[data-kind="workspace"]')?.querySelector(':scope > .row')
        return group !== null && group !== undefined && group.dataset.path === ${JSON.stringify(record.path)} && group.querySelector('.label')?.textContent === 'Default workspace'
      })()`,
      'the conversation has a row under Default workspace in the tree (it had none, #134)',
    )
    await until(
      `document.getElementById('session-title')?.hidden === false && document.getElementById('session-title').textContent.trim() !== '' && document.getElementById('session-title').textContent !== 'No session'`,
      'and the header names the conversation, not "No session"',
    )
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})

test('with no workspace to start in, the composer says Choose a workspace to start and a message is refused, never run in the server\'s start folder (#134)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's composer is inert with no Session and no workspace for one (`inert = sessionId === undefined || hero && chipTitle
   * === undefined`, dsh-client-ui-conversation lib/client.js:17819): Send disabled, the placeholder "Choose a workspace to
   * start" (placeholder.workspace, :16409), and Enter opens the workspace picker (onRequestWorkspace, :18941-18947); its
   * notice for a draft with no workspace is "Choose a workspace first." (draft.workspaceRequired, dsh-client-ui-workspace
   * lib/client.js:4873, :1509-1515). #134: a message with nowhere named went out with no folder and ran in the server's
   * start folder. The Default workspace is made and deleted first, so first use never gives it back (DSH's rule, 70's
   * first-use check) and the page has no workspace at all. `HOME` is the fixture's own, because the picker opens there.
   */
  const home = isolatedHome('tree-no-workspace')
  const account = fixtureDir('tree-no-workspace-account')
  mkdirSync(account, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config, HOME: account },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const made = await api(server.url, cookie, '/api/workspaces/default', { method: 'POST' })
    assert.equal(made.status, 200, `first use made the Default workspace (${JSON.stringify(made.body)})`)
    const deleted = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(made.body.workspace.id)}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200, 'and it was deleted')
    assert.deepEqual((await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? [], [], 'no workspace is left')

    const field = `document.querySelector('#prompt textarea')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        placeholder: ${field}?.placeholder ?? null,
        send: document.getElementById('send')?.disabled ?? null,
        chip: document.querySelector('#hero-workspace-chip .label')?.textContent ?? null,
        note: document.getElementById('tree-note')?.textContent ?? null,
        draft: ${field}?.value ?? null,
        picker: document.getElementById('workspace-picker')?.open ?? null,
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`${field}.placeholder === 'Choose a workspace to start'`, "the composer says DSH's placeholder.workspace")
    assert.equal(await browser.evaluate(`document.querySelector('#hero-workspace-chip .label')?.textContent`), 'Choose workspace', 'the hero chip is the call to action')

    await browser.evaluate(`(() => { const box = ${field}; box.value = 'where does this run'; box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    assert.equal(await browser.evaluate(`document.getElementById('send').disabled`), true, `Send stays disabled with a draft\nsaw: ${await state()}`)
    await browser.evaluate(`${field}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
    await until(`document.getElementById('tree-note').textContent === 'Choose a workspace first.'`, "Enter is refused in DSH's words")
    await until(`document.getElementById('workspace-picker')?.open === true`, 'and opens the way to a workspace: with none to list, Add workspace')
    assert.equal(await browser.evaluate(`${field}.value`), 'where does this run', 'the draft stays in the composer')
    await new Promise((done) => setTimeout(done, 1_000))
    assert.deepEqual((await api(server.url, cookie, '/api/sessions')).body, [], `nothing ran, in the server's start folder (${repoRoot}) or anywhere\nsaw: ${await state()}`)
    await browser.evaluate(`document.getElementById('workspace-picker').close()`)
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(account)
  }
})

test('a session row whose session can no longer be read opens to DSH\'s failure line, the composer disabled, and nothing is sent (#56)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's Chat shows "Failed to load history: {message} ({code})" for a session it cannot open (dsh-client-ui-chat
   * lib/client.js:2893-2898, :5991), and its composer is disabled and reads "Session unavailable" (dsh-client-ui-conversation
   * lib/client.js:18819-18824, :18948, :18972, :16406). #56: both builds opened such a row to "No session" and an empty
   * conversation with the composer enabled, and a message sent from there was answered 500. Ported from developer-six's
   * 4cd4cafb (R-developer-six-4).
   *
   * The page opens the kept session by name (gotoSession), so no first-visit blank is involved. The doomed session's log
   * and metadata are then moved out of this server's store behind its back while the page still draws its row, and the row
   * is opened. A reload afterwards is a boot restore, not an open: the saved selection was emptied, so a fresh New session
   * starts (#17), and no failure line is shown.
   */
  const home = isolatedHome('tree-unavailable')
  const work = fixtureDir('tree-unavailable-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', root], { HEDDLE_HOME: home, HEDDLE_CONFIG: config })
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const made = async (title) => {
      const answer = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: work, title }) })
      assert.equal(answer.status, 200, `created ${title} (${JSON.stringify(answer.body)})`)
      await new Promise((done) => setTimeout(done, 15))
      return answer.body.session
    }
    const kept = await made('kept notes')
    const doomed = await made('doomed notes')
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }

    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const rowOf = (id) => `document.querySelector('#tree li[data-kind="session"][data-session-id="${id}"]')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        title: document.getElementById('session-title')?.textContent ?? null,
        titleHidden: document.getElementById('session-title')?.hidden ?? null,
        lines: [...document.querySelectorAll('#log > *')].map((node) => node.textContent),
        emptyState: (() => { const empty = document.getElementById('empty-state'); return empty !== null && !empty.hidden })(),
        placeholder: document.querySelector('#prompt textarea')?.placeholder ?? null,
        disabled: document.querySelector('#prompt textarea')?.disabled ?? null,
        send: document.getElementById('send')?.disabled ?? null,
        doomedRow: ${rowOf(doomed)} !== null,
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.dataset.sessionId ?? li.textContent.trim()),
        saved: ${saved},
        writes: window.__writes ?? null,
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }

    await browser.gotoSession(server.url, kept)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`document.getElementById('session-title')?.textContent === 'kept notes'`, 'the page opens the kept session it was given by name')
    await browser.evaluate(
      `(async () => {
        for (let attempt = 0; attempt < 40 && ${rowOf(doomed)} === null; attempt += 1) {
          const row = [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((entry) => entry.dataset.path === ${JSON.stringify(added.body.record.path)})
          if (row !== undefined && row.closest('li').dataset.open !== 'true') row.click()
          await new Promise((done) => setTimeout(done, 250))
        }
        return true
      })()`,
      15_000,
    )
    await until(`${rowOf(doomed)} !== null`, 'the doomed session\'s row is drawn')

    /** The session leaves this server's store behind its back: its log and its metadata are moved away. */
    const files = listFiles(root).filter((file) => basename(file).startsWith(doomed))
    assert.ok(files.some((file) => file.endsWith(`${doomed}.json`)), `the store holds the doomed session's metadata\nsaw: ${JSON.stringify(files)}`)
    const gone = join(home, 'gone')
    mkdirSync(gone, { recursive: true })
    for (const file of files) renameSync(join(root, file), join(gone, basename(file)))
    assert.equal((await api(server.url, cookie, `/api/sessions/${doomed}`)).status, 404, 'the server can no longer read it')
    const before = (await listed()).map((meta) => meta.id)

    /** Every write the page makes from here on is recorded, so a send that slipped through is seen. */
    await browser.evaluate(`(() => {
      window.__writes = []
      const original = window.fetch
      window.fetch = (input, init) => {
        const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (method !== 'GET') window.__writes.push(method + ' ' + String(input instanceof Request ? input.url : input))
        return original(input, init)
      }
      return true
    })()`)
    await browser.evaluate(`${rowOf(doomed)}.querySelector(':scope > .row').click()`)
    const failed = await browser.waitFor(`document.getElementById('log').textContent.includes('Failed to load history')`, 15_000).catch(() => false)
    /** The tree is read again after the line is written; give that redraw its moment before the page is read. */
    if (failed) await browser.waitFor(`${rowOf(doomed)} === null`, 5_000).catch(() => false)
    await new Promise((done) => setTimeout(done, 300))
    const seen = JSON.parse(await state())
    assert.ok(failed, `opening the row says the history could not be loaded, as DSH's Chat does\nsaw: ${JSON.stringify(seen)}`)
    assert.deepEqual(seen.lines, [`Failed to load history: no session ${doomed} (404)`], `one line, with the server's reason and the status\nsaw: ${JSON.stringify(seen)}`)
    assert.equal(seen.emptyState, false, 'the failure line wins over the blank start page')
    assert.equal(seen.title, 'Session unavailable', `the header does not say "No session"\nsaw: ${JSON.stringify(seen)}`)
    assert.equal(seen.placeholder, 'Session unavailable', `the composer reads DSH's placeholder.unavailable\nsaw: ${JSON.stringify(seen)}`)
    assert.equal(seen.disabled, true, 'and its editor is disabled')
    assert.equal(seen.send, true, 'and Send is disabled')
    assert.equal(seen.doomedRow, false, `the tree is read again and the row that has no session goes\nsaw: ${JSON.stringify(seen)}`)
    assert.deepEqual(seen.selected.filter((id) => id === doomed), [], 'and is not left selected')
    assert.equal(seen.saved, null, 'nor kept as the session a reload reopens')

    /** A send from there is impossible: a typed draft, Enter, a form submit and a click on Send reach no route. */
    await browser.evaluate(`(() => {
      const form = document.getElementById('prompt')
      const field = form.querySelector('textarea')
      field.value = 'a message into a session that is gone'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      form.requestSubmit()
      document.getElementById('send').click()
      return true
    })()`)
    await new Promise((done) => setTimeout(done, 1500))
    const tried = JSON.parse(await state())
    assert.deepEqual(tried.writes, [], `nothing was sent\nsaw: ${JSON.stringify(tried)}`)
    assert.equal(tried.send, true, 'Send stays disabled with a draft in the field')
    assert.deepEqual(tried.lines, seen.lines, 'and the conversation still shows only the failure line')
    assert.deepEqual((await listed()).map((meta) => meta.id), before, 'and no session was started or written')

    /** A reload is a boot restore, not an open: nothing is saved, so a fresh New session starts and nothing says it failed. */
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page reloads')
    await until(
      `(() => { const id = ${saved}; return typeof id === 'string' && !${JSON.stringify([...before, doomed])}.includes(id) && document.getElementById('session-title')?.hidden === true })()`,
      'a reload starts a fresh New session, as a first visit does',
    )
    const fresh = JSON.parse(await state())
    assert.equal(fresh.lines.some((line) => line.includes('Failed to load history')), false, `no failure line on the fresh session\nsaw: ${JSON.stringify(fresh)}`)
    assert.equal(fresh.disabled, false, 'its composer takes a message')
    assert.notEqual(fresh.placeholder, 'Session unavailable')
    assert.equal(fresh.doomedRow, false, 'and the gone session is not drawn')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, work]) removeDir(dir)
  }
})

test('Archived only with nothing archived says "No archived sessions yet", and View other sessions goes back to Hide archived (#107)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's empty list (EmptySessions, dsh-client-ui-workspace lib/client.js:3005-3021, drawn at :3344 for the tree and :3384
   * for the flat list): under Archived only it names its own emptiness, "No archived sessions yet", and adds a "View other
   * sessions" text action (words at :4900-4901) that sets the filter back to its default (leaveArchivedOnly, :3539-3541);
   * README.md:58 says the same. #107: with a workspace registered and nothing archived, the tree said "no workspace root yet
   * — register one with the + above" and the flat list "no sessions to list", with no way back but View options.
   */
  const home = isolatedHome('tree-archived-empty')
  const work = fixtureDir('tree-archived-empty-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: work, title: 'plain notes' }) })
    assert.equal(made.status, 200, `created a session (${JSON.stringify(made.body)})`)
    const session = made.body.session

    const sessionRow = `document.querySelector('#tree li[data-kind="session"][data-session-id="${session}"]')`
    const workspaceRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(added.body.record.path)})`
    const action = `[...document.querySelectorAll('#tree button')].find((button) => button.textContent.trim() === 'View other sessions')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        tree: document.getElementById('tree').textContent.trim(),
        note: document.getElementById('tree-note').hidden ? '' : document.getElementById('tree-note').textContent,
        action: ${action} !== undefined,
        workspaceRow: ${workspaceRow} !== undefined,
        sessionRow: ${sessionRow} !== null,
        filter: localStorage.getItem('heddle.tree.archived.v1'),
      })`)
    const chooseView = async (label) => {
      await browser.evaluate(`document.querySelector('#view-options button').click()`)
      await browser.waitFor(`[...document.querySelectorAll('#view-options [role^=menuitem]')].some((entry) => entry.textContent.trim() === ${JSON.stringify(label)})`, 5_000)
      await browser.evaluate(`[...document.querySelectorAll('#view-options [role^=menuitem]')].find((entry) => entry.textContent.trim() === ${JSON.stringify(label)}).click()`)
    }
    const until = async (expression, what, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    const archivedEmpty = async (where) => {
      const said = await browser.waitFor(`document.getElementById('tree').textContent.includes('No archived sessions yet')`, 10_000).catch(() => false)
      const seen = JSON.parse(await state())
      assert.ok(said, `${where}: Archived only with nothing archived says DSH's "No archived sessions yet"\nsaw: ${JSON.stringify(seen)}`)
      assert.equal(seen.tree, 'No archived sessions yetView other sessions', `${where}: the list holds the placeholder and its action, and no row\nsaw: ${JSON.stringify(seen)}`)
      assert.equal(seen.action, true, `${where}: with DSH's View other sessions action`)
      assert.doesNotMatch(seen.note, /no workspace root yet|no sessions to list/, `${where}: not a note that sends the person to register a folder they registered`)
      assert.equal(seen.filter, 'only')
    }

    /** The page opens the session by name, so no first-visit blank is drawn beside it. */
    await browser.gotoSession(server.url, session)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`document.getElementById('session-title')?.textContent === 'plain notes'`, 'the page opens the session it was given by name')
    await until(`${sessionRow} !== null`, 'the session\'s row is drawn under its workspace')

    /** Workspace Tree + Archived only: the placeholder, and its action goes back to Hide archived with the rows. */
    await chooseView('Archived only')
    await archivedEmpty('Workspace Tree')
    await browser.evaluate(`${action}.click()`)
    await until(`${workspaceRow} !== undefined && ${sessionRow} !== null`, 'View other sessions draws the workspace and its session again')
    const back = JSON.parse(await state())
    assert.equal(back.filter, 'hide', `the filter is Hide archived again, and kept\nsaw: ${JSON.stringify(back)}`)
    assert.equal(back.action, false, 'and the placeholder is gone')
    assert.doesNotMatch(back.tree, /No archived sessions yet/)

    /** In one list + Archived only: the same placeholder and the same way back. */
    await chooseView('In one list')
    await until(`${sessionRow} !== null`, 'the flat list draws the session')
    await chooseView('Archived only')
    await archivedEmpty('In one list')
    await browser.evaluate(`${action}.click()`)
    await until(`${sessionRow} !== null`, 'View other sessions draws the session in the flat list again')
    assert.equal(JSON.parse(await state()).filter, 'hide', 'with Hide archived kept')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, work]) removeDir(dir)
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
    /**
     * Opened on one of the sessions by name: a plain first visit starts a fresh New session (#17) in the workspace these
     * rows are in, and the open blank leads its group, ahead of the rows this check orders. Opening writes nothing.
     */
    await browser.gotoSession(fixture.url, fixture.created[0])
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

test('a folder the server may not read draws DSH\'s failure line, not "nothing inside", and so does a workspace whose folder it may not read (#106)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /** `chmod 000` does not stop the superuser, so the claim cannot be judged as root. */
  if (!skipUnless(context, typeof process.getuid !== 'function' || process.getuid() !== 0, 'a user that file modes apply to')) return
  /**
   * DSH's file tree tells an empty level from a failed one (dsh-client-ui-sidebar-files lib/client.js:564-581): a failed
   * level is one line, by code, and a code its tree does not name says "Read failed: {message}" with the transport's own
   * message (:483-489, words at :773). The tree route answers a folder the server may not read with
   * `400 workspace-file/unreadable` and a sentence (#106); before, it answered `200` with no children and the page said
   * "nothing inside", which was false — the folder holds a file. A workspace whose own folder cannot be read kept its
   * sessions and silently lost its Files heading; it keeps the heading now, over the same kind of line. The modes are
   * restored in `finally`, before the fixture is removed.
   */
  const home = isolatedHome('tree-unreadable')
  const work = fixtureDir('tree-unreadable-work')
  const locked = join(work, 'locked')
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'held.txt'), 'a file the server cannot list\n')
  mkdirSync(join(work, 'open'), { recursive: true })
  writeFileSync(join(work, 'open', 'kept.txt'), 'readable\n')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const title = added.body.record.title
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: work, title: 'plain notes' }) })
    assert.equal(made.status, 200, `created a session (${JSON.stringify(made.body)})`)
    const session = made.body.session
    chmodSync(locked, 0o000)

    const folderRow = (label) => `[...document.querySelectorAll('#tree li[data-kind="folder"] > .row')].find((row) => row.querySelector('.label')?.textContent === ${JSON.stringify(label)})`
    const level = (label) =>
      browser.evaluate(`JSON.stringify((() => {
        const row = ${folderRow(label)}
        if (row === undefined) return { missing: true }
        const li = row.closest('li')
        const group = li.querySelector(':scope > ul[role=group]')
        return {
          open: li.dataset.open,
          lines: group === null ? [] : [...group.querySelectorAll(':scope > .empty')].map((line) => ({ text: line.textContent, row: line.dataset.filesRow ?? null, code: line.dataset.filesCode ?? null })),
          rows: group === null ? 0 : group.querySelectorAll(':scope > li').length,
        }
      })())`)
    const workspaceGroup = () =>
      browser.evaluate(`JSON.stringify((() => {
        const row = [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((entry) => entry.dataset.path === ${JSON.stringify(added.body.record.path)})
        if (row === undefined) return { missing: true }
        const group = row.closest('li').querySelector(':scope > ul[role=group]')
        if (group === null) return { open: false }
        return {
          open: true,
          headings: [...group.querySelectorAll(':scope > .tree-heading')].map((heading) => heading.textContent),
          lines: [...group.querySelectorAll(':scope > .empty')].map((line) => ({ text: line.textContent, row: line.dataset.filesRow ?? null, code: line.dataset.filesCode ?? null })),
          session: group.querySelector('li[data-kind="session"][data-session-id="${session}"]') !== null,
        }
      })())`)
    const until = async (expression, what, seen, timeoutMs = 10_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await seen()}`)
      }
    }

    /** The page opens the session by name; its workspace group is open, with the folder's files under Files. */
    await browser.gotoSession(server.url, session)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading', workspaceGroup)
    await until(`${folderRow('locked')} !== undefined && ${folderRow('open')} !== undefined`, 'the workspace lists both folders under Files', workspaceGroup)

    /** A readable folder still opens to its file. */
    await browser.evaluate(`${folderRow('open')}.click()`)
    await until(`${folderRow('open')}.closest('li').querySelector('ul[role=group] li[data-kind="file"]') !== null`, 'the readable folder lists its file', () => level('open'))

    /** The unreadable one opens to DSH's failure line and nothing else. */
    await browser.evaluate(`${folderRow('locked')}.click()`)
    await until(`${folderRow('locked')}.closest('li').querySelector('ul[role=group] > .empty') !== null`, 'the unreadable folder draws a line under it', () => level('locked'))
    const opened = JSON.parse(await level('locked'))
    assert.equal(opened.open, 'true', `the folder is open\nsaw: ${JSON.stringify(opened)}`)
    assert.deepEqual(
      opened.lines,
      [{ text: 'Read failed: cannot list "locked": permission denied', row: 'failed', code: 'workspace-file/unreadable' }],
      `one failure line in DSH's words, with its code, not "nothing inside"\nsaw: ${JSON.stringify(opened)}`,
    )
    assert.equal(opened.rows, 0, 'and no rows')

    /** The workspace's own folder made unreadable: its session stays, and its Files heading holds the line. */
    chmodSync(work, 0o000)
    await browser.gotoSession(server.url, session)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading again', workspaceGroup)
    await until(
      `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].some((row) => row.dataset.path === ${JSON.stringify(added.body.record.path)} && row.closest('li').querySelector(':scope > ul[role=group] > .empty') !== null)`,
      'the workspace group draws a line where its files were',
      workspaceGroup,
    )
    const group = JSON.parse(await workspaceGroup())
    assert.equal(group.session, true, `the workspace still shows its session\nsaw: ${JSON.stringify(group)}`)
    assert.deepEqual(group.headings, ['Files'], 'it keeps its Files heading')
    assert.deepEqual(
      group.lines,
      [{ text: `Read failed: cannot list "${title}": permission denied`, row: 'failed', code: 'workspace-file/unreadable' }],
      `over one failure line naming the workspace, not "nothing inside"\nsaw: ${JSON.stringify(group)}`,
    )
  } finally {
    browser.close()
    server.kill()
    for (const dir of [work, locked]) {
      try {
        chmodSync(dir, 0o755)
      } catch {
        // already gone, or never made
      }
    }
    for (const dir of [home, work]) removeDir(dir)
  }
})
