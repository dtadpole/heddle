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
 * child, and opens its workspace and every ancestor unless a person folded one (C33); a first visit opens no session and creates none, never the newest session someone else is in, and with two
 * workspaces and nothing remembered aims the composer nowhere ("Choose a workspace to start"), while after a person
 * worked in A it is aimed at A (#142); a New session pressed at once opens a blank row, selected, that offers no
 * actions; and a session row whose session can no longer be read opens to DSH's "Failed to load history" line
 * with the composer disabled, not to a blank page that takes a message (#56); first use's Default workspace stays the
 * new conversation's place across a reload, named so by the hero and the note, and a message with no workspace to go
 * to is refused rather than run in the server's start folder (#134); Archived only with nothing archived says DSH's
 * "No archived sessions yet" with a View other sessions action, not that no workspace is registered (#107); and a
 * folder the server may not read, or a workspace whose folder it may not read, draws DSH's one failure line
 * ("Read failed: …"), never "nothing inside" (#106); and a tree refresh never takes the open workspace's session rows or
 * the selected row off the page, so a click on a row during one lands on that row (#143).
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
    /** `status` is DSH's Workspace.status(), 'ok' or 'missing-dir' (#141; dsh-workspace lib/index.js:154-160). */
    assert.deepEqual(Object.keys(repo), ['id', 'path', 'title', 'origin', 'parent', 'createdAt', 'updatedAt', 'sessionIds', 'status'], 'in the one shape both servers write')
    assert.equal(repo.status, 'ok', 'and a folder that is there is ok')
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
     * Judged by a row that was not drawn before, not by a count: a blank stops being a row once another session is open
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

test('an open session another client archives is let go, as DSH\'s clearArchivedCurrent lets it go, and New session then starts where it lived, not in the last remembered folder (#119, B1)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH never keeps an archived session open: `clearArchivedCurrent` (dsh-client-ui-workspace lib/client.js:1638-1643),
   * run on every change of its workspace or session list (:1576-1578), clears the main view when the open session is
   * archived, whoever archived it (`clearMain`, :1644-1650). #139's B1 (developer-ten, f0442783): heddle kept it open and
   * writable, and a message sent into it was blocked by the server's gate and lost. Here another client archives the open
   * session in B, and the page lets it go at its next read of the session list, which a rename pushed by the server
   * prompts ('sessions', both builds).
   *
   * #119: New session used to start in the last remembered folder, on a shared server another person's project, when the
   * open session was archived. That session is no longer open, and the page keeps the prompt box aimed at the folder it
   * lived in, so New session starts in B. A is registered last, so it is drawn first, and the prompt box is aimed at A by
   * a click on A's session before B is opened through the page's verifier seam `showSession(id)` (the call a search hit
   * makes, which aims nothing): both fallbacks the bug used, the remembered folder and the first drawn workspace, are A.
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
    const inBMade = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: b.path, title: 'work in b' }) })
    assert.equal(inBMade.status, 200, `a session in B (${JSON.stringify(inBMade.body)})`)
    const inB = inBMade.body.session
    await new Promise((done) => setTimeout(done, 20))
    const newer = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: a.path, title: 'newer work in a' }) })
    assert.equal(newer.status, 200, `a newer session in A (${JSON.stringify(newer.body)})`)
    const inA = newer.body.session
    const listed = (await api(server.url, cookie, '/api/workspaces')).body.workspaces
    assert.deepEqual(listed.filter((entry) => entry.origin === 'added').map((entry) => entry.path), [a.path, b.path], 'A is first in the registry, so the tree draws it first')

    const workspaceRow = (record) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const openId = `document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const cwdOf = async (id) => {
      const sessions = (await api(server.url, cookie, '/api/sessions')).body
      return (Array.isArray(sessions) ? sessions : []).find((meta) => meta.id === id)?.cwd ?? null
    }
    const state = () =>
      browser.evaluate(`JSON.stringify({
        open: ${openId},
        saved: ${saved},
        title: document.getElementById('session-title')?.textContent ?? null,
        note: document.getElementById('tree-note')?.textContent ?? null,
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

    /** Then the session in B, by id, through the seam that aims nothing. */
    await browser.evaluate(`showSession(${JSON.stringify(inB)}).then(() => true)`)
    await until(`document.getElementById('session-title').textContent.includes('work in b') && ${saved} === ${JSON.stringify(inB)}`, 'the session in B is open')
    await new Promise((done) => setTimeout(done, 1_000))

    /** Another client archives it, then renames another session, and the server's push makes the page read the list. */
    const archived = await api(server.url, cookie, `/api/sessions/${inB}/flags`, { method: 'POST', body: JSON.stringify({ archived: true }) })
    assert.equal(archived.status, 200, `another client archives the session in B (${JSON.stringify(archived.body)})`)
    const renamed = await api(server.url, cookie, `/api/sessions/${inA}/title`, { method: 'POST', body: JSON.stringify({ title: 'newer work in a, renamed' }) })
    assert.equal(renamed.status, 200, `and renames the session in A (${JSON.stringify(renamed.body)})`)
    await until(
      `document.getElementById('session-title').textContent === 'No session' && ${saved} === null`,
      'the page lets the archived session go: nothing is open, and nothing is kept to reopen (DSH clearArchivedCurrent)',
      15_000,
    )

    await browser.evaluate(`document.getElementById('new-session').click()`)
    await until(
      `(() => { const id = ${openId}; return id !== null && id !== ${JSON.stringify(inA)} && id !== ${JSON.stringify(inB)} })()`,
      'New session opens a new session',
      15_000,
    )
    const made = await browser.evaluate(openId)
    const cwd = await cwdOf(made)
    assert.equal(cwd, b.path, `New session starts in B, where the archived session lived, not in A (the remembered folder and the first drawn workspace)\nA: ${a.path}\nsaw: ${await state()}`)
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

test('a reload reopens the session that was open, never a hidden subagent child, and a saved one that is gone is forgotten with nothing created (C28, C33, #142)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH keeps the open session in localStorage (`dsh.sessions.current`, dsh-client-ui-workspace lib/client.js:1369,
   * :1662-1665) and its restoreSelection reopens it on load (:1605-1616); a saved blank is reopened by its own id
   * (:1451-1458, :1619); a saved session that is gone leaves DSH creating a fresh one in its recentWorkspace (:1620,
   * :1626, :1694-1710). heddle creates nothing on such a load (#142): DSH is single-user, and on heddle's shared server
   * that start went to whichever workspace was active last. With this fixture's one workspace the composer is aimed at
   * it, and the first message would start the session there. Phase A (C28, C33) measured both builds opening
   * `/api/sessions`[0] on every load, there a subagent's child the tree hides: the session a person had open was gone
   * after a reload, and a folded workspace no longer tinted its folder.
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
    /** Nothing open: the header says so, and the hero chip names where the first message would start one (#134, #142). */
    const nothingOpen = `(document.getElementById('session-title')?.hidden === false && document.getElementById('session-title').textContent === 'No session')`
    const chip = `(document.querySelector('#hero-workspace-chip .label')?.textContent ?? null)`
    const workspaceRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        title: ${title},
        titleHidden: document.getElementById('session-title')?.hidden ?? null,
        chip: ${chip},
        saved: localStorage.getItem('heddle.sessions.current'),
        last: localStorage.getItem('heddle.workspace.last'),
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
     * A first visit has nothing saved: nothing opens, never the newest conversation nor the hidden child that is newer still
     * (#17), and nothing is created (#142). With exactly one workspace, the composer is aimed at it: the hero chip names it.
     */
    await load()
    await new Promise((done) => setTimeout(done, 1_000))
    assert.deepEqual((await listed()).map((meta) => meta.id), first.map((meta) => meta.id), `a first visit creates no session\nsaw: ${await state()}`)
    await until(`${saved} === null && ${nothingOpen}`, 'and opens none: not the newest conversation and not the hidden subagent child')
    await until(`${chip} === ${JSON.stringify(record.title)}`, 'with one workspace, the new conversation is aimed at it (#142)')

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

    /**
     * A saved session that is gone: the entry is forgotten and nothing is created (#142); the composer is aimed at the
     * workspace this browser last worked in, where alpha was opened, and the fold stays.
     */
    assert.equal(JSON.parse((await browser.evaluate(`localStorage.getItem('heddle.workspace.last')`)) ?? '{}').path, record.path, 'opening alpha kept its workspace as this browser\'s last (#142)')
    await browser.evaluate(`localStorage.setItem('heddle.sessions.current', JSON.stringify({ sessionId: 'session-00000000-0000-4000-8000-000000000000' }))`)
    const before = (await listed()).map((meta) => meta.id)
    await load()
    await until(`${saved} === null && ${nothingOpen}`, 'a saved session that is gone is forgotten, and nothing opens')
    await new Promise((done) => setTimeout(done, 1_000))
    assert.deepEqual((await listed()).map((meta) => meta.id), before, `and nothing is created in its place\nsaw: ${await state()}`)
    await until(`${chip} === ${JSON.stringify(record.title)}`, 'the new conversation is aimed at the workspace')
    assert.notEqual(await browser.evaluate(`${workspaceRow}.closest('li').dataset.open ?? null`), 'true', 'and the workspace the person folded stays folded')

    /** The next reload is the same: still nothing saved, still nothing created. */
    await load()
    await until(`${saved} === null && ${nothingOpen}`, 'a second reload opens nothing either')
    await new Promise((done) => setTimeout(done, 1_000))
    assert.deepEqual((await listed()).map((meta) => meta.id), before, 'and creates nothing')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, work]) removeDir(dir)
  }
})

test('a reload into a nested workspace opens its way to the open session, and a fold the person made stays folded (C33)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's tree keeps one record per group, `groupExpansion[key]` true, false or absent (dsh-client-ui-workspace
   * lib/client.js:1284-1285). With no record, a workspace another one nests in is open (`:3061-3063`; its README: "Ancestors
   * start expanded unless a saved collapsed state exists"), and the current session's group is opened and saved open
   * (`:3037-3046`), so a reload draws the open session's row however deep it is. A saved fold wins over both ("A saved
   * collapse also hides the current Session; ancestor folder icons stay highlighted"). Before (R-developer-eight-2), a
   * load with any saved expansion opened only what was saved, so a session in a nested workspace reopened with its row
   * folded away under two closed folders.
   */
  const fixture = await seeded('ancestors')
  const browser = await openBrowser()
  try {
    const appPath = fixture.inner.path
    const repoPath = fixture.repo.path
    const groupLi = (path) => `([...document.querySelectorAll('#tree li[data-kind="workspace"]')].find((li) => li.querySelector(':scope > .row')?.dataset.path === ${JSON.stringify(path)}) ?? null)`
    const sessionLi = `document.querySelector('#tree li[data-session-id="${fixture.appSession}"]')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        title: document.getElementById('session-title')?.textContent ?? null,
        repo: (() => { const li = ${groupLi(repoPath)}; return li === null ? null : { open: li.dataset.open ?? null, tinted: li.dataset.containsCurrent ?? null } })(),
        app: (() => { const li = ${groupLi(appPath)}; return li === null ? null : { open: li.dataset.open ?? null, tinted: li.dataset.containsCurrent ?? null } })(),
        row: (() => { const li = ${sessionLi}; return li === null ? null : { selected: li.getAttribute('aria-selected') } })(),
        expanded: localStorage.getItem('heddle.tree.expanded.v1'),
        collapsed: localStorage.getItem('heddle.tree.collapsed.v1'),
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }
    const load = async () => {
      await browser.goto(fixture.url)
      await until('document.body.dataset.ready === "true"', 'the page finishes loading')
      await until(`document.getElementById('session-title')?.textContent === 'app session'`, 'the load reopens the saved session in the nested workspace')
    }

    /** A browser that has saved an expansion (none open) and has the nested workspace's session open: the reload. */
    await browser.goto(fixture.url)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await browser.evaluate(`(() => {
      localStorage.setItem('heddle.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: fixture.appSession }))})
      localStorage.setItem('heddle.tree.expanded.v1', '[]')
      localStorage.removeItem('heddle.tree.collapsed.v1')
      return true
    })()`)
    await load()
    await until(
      `${groupLi(repoPath)}?.dataset.open === 'true' && ${groupLi(appPath)}?.dataset.open === 'true' && ${sessionLi}?.getAttribute('aria-selected') === 'true'`,
      'the open session\'s workspace and its ancestor open, and its row is drawn selected',
    )
    const saved = JSON.parse(await browser.evaluate(`localStorage.getItem('heddle.tree.expanded.v1')`))
    assert.deepEqual([saved.includes(appPath), saved.includes(repoPath)], [true, false], `the session's workspace is saved open, as DSH saves it; the ancestor is open by default, not saved\nsaw: ${await state()}`)

    /** The person folds the ancestor: the fold is saved, and a reload keeps it, hiding the open session behind a tinted folder. */
    await browser.evaluate(`${groupLi(repoPath)}.querySelector(':scope > .row').click()`)
    await until(`${groupLi(repoPath)}.dataset.open !== 'true'`, 'the ancestor folds')
    await load()
    await new Promise((done) => setTimeout(done, 1_000))
    await until(
      `(() => { const repo = ${groupLi(repoPath)}; return repo !== null && repo.dataset.open !== 'true' && repo.dataset.containsCurrent === 'true' && ${sessionLi} === null })()`,
      'the folded ancestor stays folded across the reload, tinted, and the open session\'s row stays hidden',
    )

    /** Unfolding it shows the nested workspace as it was left: saved open, so open, with the session's row in it. */
    await browser.evaluate(`${groupLi(repoPath)}.querySelector(':scope > .row').click()`)
    await until(`${groupLi(appPath)}?.dataset.open === 'true' && ${sessionLi} !== null`, 'unfolding the ancestor opens the nested workspace saved open, and draws the session')

    /** The person folds the session's own workspace: that fold wins over the open session's default on the next reload. */
    await browser.evaluate(`${groupLi(appPath)}.querySelector(':scope > .row').click()`)
    await until(`${groupLi(appPath)}.dataset.open !== 'true'`, 'the nested workspace folds')
    await load()
    await new Promise((done) => setTimeout(done, 1_000))
    await until(
      `(() => { const app = ${groupLi(appPath)}; return ${groupLi(repoPath)}?.dataset.open === 'true' && app !== null && app.dataset.open !== 'true' && app.dataset.containsCurrent === 'true' && ${sessionLi} === null })()`,
      'the ancestor is open, and the folded workspace stays folded and tinted with the open session hidden in it',
    )
  } finally {
    browser.close()
    fixture.close()
  }
})

test('a first visit creates no session and aims at no one else\'s workspace: with two workspaces and another client\'s recent activity it says Choose a workspace to start, and New session pressed at once selects its blank, which offers no actions (#142, #17, #79)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's restoreSelection with nothing saved creates a Session in its recentWorkspace, the workspace whose sessions were
   * written last (dsh-client-ui-workspace lib/client.js:1611-1613, :1620, :1626 -> connectBlank :1403-1406,
   * recentWorkspace :1694-1710). DSH is single-user, so that is the person's own workspace. #142 (developer-ten, both
   * builds at 6a22ab76): heddle's port of it, on a shared server, left a blank session in whichever workspace was active
   * last, another person's, on every load, and aimed the composer at their folder; and a New session pressed within about
   * 1.5 s of load left no row selected, because the boot's own start chose its blank after the press. Now a first visit
   * creates nothing, and with two workspaces and nothing this browser remembers, the composer is DSH's inert one: "Choose
   * a workspace to start" (placeholder.workspace, dsh-client-ui-conversation lib/client.js:16409, inert at :17819), Send
   * disabled, the hero chip the call to action. #17: it never opens the newest session either. A fresh browser profile is
   * that first visit; a reload with nothing saved is one again.
   *
   * The blank a person then starts draws no row actions (SessionNodeItem, `!row.blank &&`, :2317-2323) and no
   * double-click rename (:2311), and its fork chord is blocked with `shortcut.noCompletedTurn` (:161-164, :4881). #79:
   * the row offered the full menu and the hover buttons, and Fork came back as the server's refusal with the raw id.
   */
  const home = isolatedHome('tree-first-visit')
  const mine = fixtureDir('tree-first-visit-mine')
  const theirs = fixtureDir('tree-first-visit-theirs')
  const { config } = scriptedConfig({ home, steps: Array.from({ length: 4 }, () => ({ text: 'an answer' })) })
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
    const [mineRecord, theirsRecord] = records
    const mineMade = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: mine, title: 'my notes' }) })
    assert.equal(mineMade.status, 200, `my own session (${JSON.stringify(mineMade.body)})`)
    await new Promise((done) => setTimeout(done, 20))
    /** Another client's session, in their workspace, with a finished turn: the newest activity on the server. */
    const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'their own work', folder: theirs, new: true }) })
    assert.equal(turn.status, 200, `their turn ran (${turn.status})`)
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }
    const before = await listed()
    const other = before[0]
    assert.ok(
      other !== undefined && other.id !== mineMade.body.session && (other.turns ?? 0) > 0 && other.cwd === theirsRecord.path,
      `the newest session is the other client's, in their workspace, with a turn\nsaw: ${JSON.stringify(before.map((meta) => [meta.id, meta.title ?? null, meta.turns ?? 0, meta.cwd]))}`,
    )
    const ids = (list) => list.map((meta) => meta.id).sort()

    const field = `document.querySelector('#prompt textarea')`
    const saved = `(() => { try { return JSON.parse(localStorage.getItem('heddle.sessions.current') ?? '{}').sessionId ?? null } catch { return null } })()`
    const openId = `document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        saved: ${saved},
        title: document.getElementById('session-title')?.hidden === false ? document.getElementById('session-title').textContent : null,
        chip: document.querySelector('#hero-workspace-chip .label')?.textContent ?? null,
        note: document.getElementById('tree-note')?.hidden === false ? document.getElementById('tree-note').textContent : '',
        placeholder: ${field}?.placeholder ?? null,
        send: document.getElementById('send')?.disabled ?? null,
        turns: document.querySelectorAll('#log .turn').length,
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"]')].map((li) => li.dataset.sessionId ?? li.textContent.trim()),
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }

    /** The first visit: nothing is created on load, counted by the server's own list. */
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await new Promise((done) => setTimeout(done, 1_500))
    const afterLoad = await listed()
    assert.deepEqual(
      ids(afterLoad),
      ids(before),
      `a first visit creates no session, in the other client's workspace or anywhere (#142)\nnew: ${JSON.stringify(afterLoad.filter((meta) => !before.some((known) => known.id === meta.id)).map((meta) => [meta.id, meta.cwd]))}\nsaw: ${await state()}`,
    )
    const first = JSON.parse(await state())
    assert.equal(first.saved, null, `nothing is open or kept (#17)\nsaw: ${JSON.stringify(first)}`)
    assert.equal(first.title, 'No session', 'the header says nothing is open, never their conversation')
    assert.equal(first.turns, 0, 'and none of their conversation is on screen')
    await until(`${field}.placeholder === 'Choose a workspace to start'`, 'with two workspaces and nothing remembered, the composer says DSH\'s placeholder.workspace (#142)')
    assert.equal(await browser.evaluate(`document.querySelector('#hero-workspace-chip .label')?.textContent`), 'Choose workspace', 'the hero chip is the call to action, not the other client\'s workspace')
    assert.doesNotMatch((await browser.evaluate(`document.getElementById('tree-note')?.textContent ?? ''`)) ?? '', /a new conversation in/, 'and the note names no place for it')
    await browser.evaluate(`(() => { const box = ${field}; box.value = 'where does this run'; box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    assert.equal(await browser.evaluate(`document.getElementById('send').disabled`), true, `Send is disabled with a draft\nsaw: ${await state()}`)
    await browser.evaluate(`(() => { const box = ${field}; box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

    /**
     * A reload, still with nothing saved, and New session in my workspace pressed the moment its row is drawn: the press
     * the issue made within 1.5 s of load. Its blank opens, and its row is the selected one, and stays so.
     */
    const mineRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(mineRecord.path)})`
    const plus = `(${mineRow}?.querySelector('button[aria-label="New session in ${mineRecord.title}"]') ?? null)`
    await browser.goto(server.url)
    const loaded = Date.now()
    await until(`${plus} !== null`, 'my workspace\'s New session is drawn')
    await browser.evaluate(`${plus}.click()`)
    const pressedAfter = Date.now() - loaded
    context.diagnostic(`New session in ${mineRecord.title} pressed ${pressedAfter} ms after the reload's document loaded`)
    await until(
      `(() => { const id = ${openId}; return id !== null && !${JSON.stringify(ids(before))}.includes(id) })()`,
      `New session pressed ${pressedAfter} ms after load opens its blank as the selected row (#142's side effect)`,
    )
    const blankId = await browser.evaluate(openId)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await new Promise((done) => setTimeout(done, 1_500))
    const settled = JSON.parse(await state())
    assert.deepEqual(settled.selected, [blankId], `and once the load has settled it is still the one selected row\nsaw: ${JSON.stringify(settled)}`)
    assert.equal(settled.saved, blankId, 'and the open, kept session')
    const afterPress = await listed()
    assert.deepEqual(ids(afterPress), ids([...before, { id: blankId }]), 'exactly one session was created, by the press')
    assert.equal(afterPress.find((meta) => meta.id === blankId)?.cwd, mineRecord.path, 'in my workspace')
    assert.equal(afterPress.find((meta) => meta.id === blankId)?.turns ?? 0, 0, 'and it is blank')

    /** The blank's row, and the other client's row in their workspace (opened only if it is folded). */
    const rowOf = (id) => `document.querySelector('#tree li[data-kind="session"][data-session-id="${id}"]')`
    await browser.evaluate(
      `(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        for (let attempt = 0; attempt < 40 && (${rowOf(blankId)} === null || ${rowOf(other.id)} === null); attempt += 1) {
          const row = [...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((entry) => entry.dataset.path === ${JSON.stringify(theirsRecord.path)})
          if (row !== undefined && row.closest('li').dataset.open !== 'true') row.click()
          await wait(250)
        }
        return true
      })()`,
      15_000,
    )
    assert.ok(await browser.waitFor(`${rowOf(blankId)} !== null && ${rowOf(other.id)} !== null`, 10_000).catch(() => false), `both rows are drawn\nsaw: ${await state()}`)
    const actions = (id) => `(() => {
      const li = ${rowOf(id)}
      /** The tree item is the row's one Tab stop (#92, F4); its focus draws the row's controls. */
      li.focus()
      const read = JSON.stringify({
        label: li.querySelector(':scope > .row > .label')?.textContent ?? null,
        selected: li.getAttribute('aria-selected'),
        menu: li.querySelector(':scope > .row .menu-wrap') !== null,
        quick: [...li.querySelectorAll(':scope > .row .session-actions button')].map((button) => button.getAttribute('aria-label')),
        buttons: [...li.querySelectorAll(':scope > .row button')].map((button) => button.getAttribute('aria-label') ?? button.textContent),
      })
      li.blur()
      return read
    })()`
    const blank = JSON.parse(await browser.evaluate(actions(blankId)))
    assert.deepEqual(
      blank,
      { label: 'New Session', selected: 'true', menu: false, quick: [], buttons: [] },
      `the open blank's row offers no menu, no Archive and no Pin, as DSH's blank row (#79)\nsaw: ${JSON.stringify(blank)}`,
    )
    const theirsRow = JSON.parse(await browser.evaluate(actions(other.id)))
    assert.equal(theirsRow.selected, 'false', `the other client's row is not the open one\nsaw: ${JSON.stringify(theirsRow)}`)
    assert.equal(theirsRow.menu, true, 'while a session that ran a turn keeps its menu')
    assert.deepEqual(theirsRow.quick, ['Archive session', 'Pin session'], 'and its Archive and Pin')

    /** No rename by double-click on the blank's title. */
    await browser.evaluate(`${rowOf(blankId)}.querySelector(':scope > .row > .label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`)
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
    assert.equal((await listed()).length, afterPress.length, 'and nothing was forked')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, mine, theirs]) removeDir(dir)
  }
})

test('after a person opens a session in A, a reload with the saved entry cleared aims at A though B was active last, creates nothing, and the first message runs in A as a new conversation (#142)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The memory a first visit is aimed by: the workspace this browser last worked in, kept beside the open session's entry
   * (`heddle.workspace.last`) whenever a session is opened or started in a workspace. DSH needs none: it is single-user,
   * and its recentWorkspace (dsh-client-ui-workspace lib/client.js:1694-1710) is the person's own. On heddle's shared
   * server the most recent activity is another client's, here a turn in B newer than anything in A (#142). With the
   * saved session cleared, the reload creates nothing, the hero chip and the note name A, and the first message starts a
   * new session in A (`new: true`, #134), never in B and never in the session already in A.
   */
  const home = isolatedHome('tree-last-workspace')
  const first = fixtureDir('tree-last-workspace-a')
  const second = fixtureDir('tree-last-workspace-b')
  const { config } = scriptedConfig({ home, steps: Array.from({ length: 4 }, () => ({ text: 'an answer' })) })
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
    const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: a.path, title: 'notes in a' }) })
    assert.equal(made.status, 200, `a session in A (${JSON.stringify(made.body)})`)
    const inA = made.body.session
    await new Promise((done) => setTimeout(done, 20))
    const theirs = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'their own work', folder: b.path, new: true }) })
    assert.equal(theirs.status, 200, `another client's turn ran in B (${theirs.status})`)
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }
    assert.equal((await listed())[0]?.cwd, b.path, 'the newest activity on the server is in B')

    const workspaceRow = (record) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(record.path)})`
    const chip = `(document.querySelector('#hero-workspace-chip .label')?.textContent ?? null)`
    const note = `(document.getElementById('tree-note')?.hidden === false ? document.getElementById('tree-note').textContent : '')`
    const state = () =>
      browser.evaluate(`JSON.stringify({
        title: document.getElementById('session-title')?.textContent ?? null,
        chip: ${chip},
        note: ${note},
        placeholder: document.querySelector('#prompt textarea')?.placeholder ?? null,
        saved: localStorage.getItem('heddle.sessions.current'),
        last: localStorage.getItem('heddle.workspace.last'),
      })`)
    const until = async (expression, what, timeoutMs = 15_000) => {
      try {
        await browser.waitFor(expression, timeoutMs)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nsaw: ${await state()}`)
      }
    }

    /** A first visit, then the person opens the session in A from its row. */
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page finishes loading')
    await until(`${workspaceRow(a)} !== undefined && ${workspaceRow(b)} !== undefined`, 'both workspaces are drawn')
    await browser.evaluate(`(() => { const row = ${workspaceRow(a)}; if (row.closest('li').dataset.open !== 'true') row.click() })()`)
    await until(`document.querySelector('#tree li[data-session-id="${inA}"] > .row') !== null`, 'the session in A is drawn')
    await browser.evaluate(`document.querySelector('#tree li[data-session-id="${inA}"] > .row').click()`)
    await until(`document.getElementById('session-title').textContent === 'notes in a'`, 'the session in A opens')
    await until(
      `(() => { try { return JSON.parse(localStorage.getItem('heddle.workspace.last') ?? '{}').path === ${JSON.stringify(a.path)} } catch { return false } })()`,
      'opening it keeps A as the workspace this browser last worked in',
    )

    /** The saved session is cleared, and the page reloads. */
    await browser.evaluate(`localStorage.removeItem('heddle.sessions.current')`)
    const before = (await listed()).map((meta) => meta.id).sort()
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page reloads')
    await new Promise((done) => setTimeout(done, 1_500))
    assert.deepEqual((await listed()).map((meta) => meta.id).sort(), before, `the reload creates no session\nsaw: ${await state()}`)
    await until(`document.getElementById('session-title').textContent === 'No session'`, 'and opens none')
    await until(`${chip} === ${JSON.stringify(a.title)}`, 'the hero chip names A, the workspace this browser last worked in, not B where the server was active last')
    await until(`${note} === ${JSON.stringify(`a new conversation in ${a.title}`)}`, 'and so does the note')
    assert.notEqual(await browser.evaluate(`document.querySelector('#prompt textarea').placeholder`), 'Choose a workspace to start', 'the composer is aimed, not inert')

    /** The first message, sent the way a person sends it, starts a new session in A. */
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'where does this run'; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await until(`document.getElementById('send').disabled === false`, 'Send is offered for the draft')
    await browser.evaluate(`document.getElementById('send').click()`)
    let ran = null
    for (let attempt = 0; attempt < 60 && ran === null; attempt += 1) {
      ran = (await listed()).find((meta) => !before.includes(meta.id) && (meta.turns ?? 0) > 0) ?? null
      if (ran === null) await new Promise((done) => setTimeout(done, 250))
    }
    assert.ok(ran !== null, `the message ran in a new session\nsaw: ${await state()}`)
    assert.equal(ran.cwd, a.path, `in A, not in B (${b.path})`)
    const after = await listed()
    assert.equal(after.find((meta) => meta.id === inA)?.turns ?? 0, 0, 'not in the session already in A, which stays as it was')
    assert.equal(after.length, before.length + 1, 'and one session was created, by the message')
  } finally {
    browser.close()
    server.kill()
    for (const dir of [home, first, second]) removeDir(dir)
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
   * The page opens the kept session by name (gotoSession). The doomed session's log and metadata are then moved out of
   * this server's store behind its back while the page still draws its row, and the row is opened. A reload afterwards is
   * a boot restore, not an open: the saved selection was emptied, so nothing opens and nothing is created (#17, #142), no
   * failure line is shown, and the composer, aimed at the one workspace, takes a message.
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

    /**
     * A reload is a boot restore, not an open: nothing is saved, so nothing opens, nothing is created (#142), and nothing
     * says it failed.
     */
    await browser.goto(server.url)
    await until('document.body.dataset.ready === "true"', 'the page reloads')
    await until(`${saved} === null && document.getElementById('session-title')?.textContent === 'No session'`, 'a reload opens nothing, as a first visit does')
    await new Promise((done) => setTimeout(done, 1_000))
    assert.deepEqual((await listed()).map((meta) => meta.id), before, `and creates nothing (#142)\nsaw: ${await state()}`)
    const fresh = JSON.parse(await state())
    assert.equal(fresh.lines.some((line) => line.includes('Failed to load history')), false, `no failure line\nsaw: ${JSON.stringify(fresh)}`)
    assert.equal(fresh.disabled, false, 'the composer takes a message')
    assert.notEqual(fresh.placeholder, 'Session unavailable')
    assert.notEqual(fresh.placeholder, 'Choose a workspace to start', 'aimed at the one workspace')
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
     * Opened on one of the sessions by name, so a session is open as a person's would be (a plain first visit opens none
     * and creates none, #17, #142). Opening writes nothing.
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

test('a tree refresh never takes the open workspace\'s session rows or the selected row off the page, and a click on a row during one lands on that row (#143)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * Every refresh (a message, an answer or a turn end anywhere on the server, a workspace or a rename pushed by another
   * client) redrew the tree with every group folded, then reopened each remembered group one after another, a
   * `GET /api/tree` apiece, and marked the selection last. So for a round trip or more, several times a turn, the open
   * workspaces' session rows and the selected row were gone and the rows below moved up: developer-six measured a click
   * aimed at a session row 0.5-1.3 s after another client's push landing on another row in 4 of 7 tries on each build.
   * DSH's tree is a keyed React list (dsh-client-ui-workspace lib/client.js:3307, :3328) whose expansion is state
   * (:1284-1286, derived at :3061-3068), so a refresh updates rows in place and `aria-selected` (:2257, :2278) stays on the
   * open session.
   *
   * Here the open session lives in a workspace nested in another, so the page reads the outer workspace's folder before it
   * reaches the inner one, and the page's `/api/tree` answers are held back (as check-content-search holds back its search
   * for #151) so each refresh's reads stay out long enough to see. Refreshes come from another client renaming a session in
   * the outer workspace. A MutationObserver and a 25 ms poll record every moment the inner workspace's rows or the selected
   * row are missing; then a real press and release go to a row's centre while a refresh's reads are out.
   */
  const home = isolatedHome('tree-steady')
  const root = fixtureDir('tree-steady-repo')
  const inner = join(root, 'packages', 'inner')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(root, 'README.md'), 'the outer workspace\n')
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser
  try {
    const cookie = await cookieFor(server.url)
    for (const path of [root, inner]) {
      const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path }) })
      assert.equal(added.status, 200, `registered ${path} (${JSON.stringify(added.body)})`)
    }
    const make = async (branch, title) => {
      const made = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch, title }) })
      assert.equal(made.status, 200, `created ${title} (${JSON.stringify(made.body)})`)
      await new Promise((done) => setTimeout(done, 15))
      return made.body.session
    }
    const other = await make(root, 'steady other')
    const one = await make(inner, 'steady one')
    const open = await make(inner, 'steady open')
    const target = await make(inner, 'steady target')
    const four = await make(inner, 'steady four')
    const innerIds = [one, open, target, four]

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.gotoSession(server.url, open)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const allDrawn = `(() => { const tree = document.getElementById('tree'); return ${JSON.stringify(innerIds)}.every((id) => tree.querySelector('li[data-kind="session"][data-session-id="' + id + '"]') !== null) && tree.querySelector('li[aria-selected="true"]')?.dataset.sessionId === ${JSON.stringify(open)} })()`
    assert.ok(await browser.waitFor(allDrawn, 15_000), 'the inner workspace\'s sessions are drawn, with the open one selected')
    await new Promise((done) => setTimeout(done, 1_000))

    /**
     * The recorder, and the page's `/api/tree` answers held back `__treeDelay` ms. `draws` counts the tree's list reads
     * (`/api/workspaces`, one per redraw), `inFlight` the folder reads out now; each gap is a moment the inner workspace's
     * rows or the selected row were missing, with what was missing and what was selected.
     */
    await browser.evaluate(`(() => {
      const ids = ${JSON.stringify(innerIds)}
      const open = ${JSON.stringify(open)}
      const real = window.fetch.bind(window)
      const state = { samples: 0, gaps: [], draws: 0, inFlight: 0, maxInFlight: 0, events: [], expect: [open] }
      window.__steady = state
      window.__treeDelay = 700
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href)
        if (url.pathname === '/api/workspaces' && (init?.method ?? 'GET') === 'GET') state.draws += 1
        if (url.pathname !== '/api/tree') return real(input, init)
        state.inFlight += 1
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        return new Promise((done) => setTimeout(done, window.__treeDelay)).then(() => real(input, init)).finally(() => { state.inFlight -= 1 })
      }
      const tree = document.getElementById('tree')
      const check = (why) => {
        state.samples += 1
        const missing = ids.filter((id) => tree.querySelector('li[data-kind="session"][data-session-id="' + id + '"]') === null)
        const selected = [...tree.querySelectorAll('li[aria-selected="true"]')].map((li) => li.dataset.sessionId ?? li.dataset.rowKey)
        if (missing.length > 0 || selected.length !== 1 || !state.expect.includes(selected[0])) {
          if (state.gaps.length < 40) state.gaps.push({ at: Math.round(performance.now()), why, missing, selected, inFlight: state.inFlight })
        }
      }
      new MutationObserver(() => check('mutation')).observe(tree, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'data-open'] })
      state.timer = setInterval(() => check('poll'), 25)
      const describe = (node) => { const li = node instanceof Element ? node.closest('li') : null; return li === null ? (node instanceof Element ? node.tagName.toLowerCase() : String(node)) : (li.dataset.sessionId ?? li.dataset.rowKey ?? li.className) }
      for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, (event) => state.events.push({ type, on: describe(event.target) }), true)
      return true
    })()`)
    const record = async () => browser.evaluate('JSON.stringify({ ...window.__steady, timer: undefined })')
    const rename = async (title) => {
      const renamed = await api(server.url, cookie, `/api/sessions/${other}/title`, { method: 'POST', body: JSON.stringify({ title }) })
      assert.equal(renamed.status, 200, `another client renamed the outer workspace's session (${JSON.stringify(renamed.body)})`)
    }
    const settled = async (draws, what) => {
      try {
        await browser.waitFor(`window.__steady.draws >= ${draws} && window.__steady.inFlight === 0`, 15_000)
      } catch (error) {
        assert.fail(`${what}\n${error instanceof Error ? error.message : String(error)}\nrecord: ${await record()}`)
      }
      await new Promise((done) => setTimeout(done, 300))
    }

    /** Three refreshes pushed by another client's renames, each with its folder reads held back. */
    for (let round = 1; round <= 3; round += 1) {
      const before = await browser.evaluate('window.__steady.draws')
      await rename(`steady other ${round}`)
      await settled(before + 1, `the rename pushed a redraw that read its folders (round ${round})`)
    }
    const seen = JSON.parse(await record())
    assert.ok(seen.draws >= 3, `three redraws ran (${seen.draws})`)
    assert.ok(seen.samples > 50, `and the recorder sampled the tree throughout (${seen.samples} samples)`)
    assert.deepEqual(seen.gaps, [], `while each redraw's folder reads were out, the inner workspace's rows and the selected row never left the page\nrecord: ${JSON.stringify(seen)}`)
    assert.equal(seen.maxInFlight >= 2, true, `the open workspaces' folders were read at once, not one after another (at most ${seen.maxInFlight} at a time)`)

    /**
     * A person clicks a row while a refresh's reads are out: a real press and release at the target row's centre, sent
     * once the redraw is reading its folders (held back 1.5 s, so the press lands inside the window).
     */
    const centre = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => { const row = document.querySelector('#tree li[data-session-id="${target}"] > .row'); if (row === null) return null; row.scrollIntoView({ block: 'nearest' }); const box = row.getBoundingClientRect(); return { x: Math.round(box.left + Math.min(box.width / 2, 80)), y: Math.round(box.top + box.height / 2) } })())`),
    )
    assert.ok(centre !== null, 'the target row is drawn')
    await browser.evaluate('(() => { window.__treeDelay = 1500; window.__steady.events = []; window.__steady.gaps = []; return true })()')
    const before = await browser.evaluate('window.__steady.draws')
    await rename('steady other clicked')
    try {
      await browser.waitFor(`window.__steady.draws > ${before} && window.__steady.inFlight > 0`, 10_000)
    } catch (error) {
      assert.fail(`the rename pushed a redraw that is reading its folders\n${error instanceof Error ? error.message : String(error)}\nrecord: ${await record()}`)
    }
    const under = await browser.evaluate(`(() => { const node = document.elementFromPoint(${centre.x}, ${centre.y}); const li = node?.closest('li'); return li?.dataset.sessionId ?? li?.dataset.rowKey ?? (node === null ? 'nothing' : node.tagName) })()`)
    /** From the press on, either the open session or the one clicked is the selected row, and always exactly one. */
    await browser.evaluate(`(() => { window.__steady.expect = ${JSON.stringify([open, target])}; return true })()`)
    const pointer = (type) =>
      browser.send('Input.dispatchMouseEvent', {
        type,
        x: centre.x,
        y: centre.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
      })
    await pointer('mouseMoved')
    await pointer('mousePressed')
    await pointer('mouseReleased')
    const inWindow = await browser.evaluate('window.__steady.inFlight > 0')
    try {
      await browser.waitFor(
        `document.getElementById('session-title')?.textContent === 'steady target' && document.querySelector('#tree li[aria-selected="true"]')?.dataset.sessionId === ${JSON.stringify(target)}`,
        10_000,
      )
    } catch (error) {
      assert.fail(
        `the click during the refresh lands on the row aimed at, and opens its session (under the pointer at the press: ${under}; the redraw still reading at the release: ${inWindow})\n${error instanceof Error ? error.message : String(error)}\nrecord: ${await record()}\ntitle: ${await browser.evaluate(`JSON.stringify(document.getElementById('session-title')?.textContent ?? null)`)}`,
      )
    }
    assert.equal(under, target, `the target row was under the pointer while the redraw read its folders\nrecord: ${await record()}`)
    await settled(before + 1, 'the redraw after the click lands')
    const after = JSON.parse(await record())
    assert.deepEqual(after.gaps, [], `through the click and the redraw around it, the inner workspace's rows stayed and exactly one row was selected\nrecord: ${JSON.stringify(after)}`)
    assert.deepEqual(
      after.events.map((event) => `${event.type}:${event.on}`),
      [`mousedown:${target}`, `mouseup:${target}`, `click:${target}`],
      `the press, the release and the click all landed on the target row\nrecord: ${JSON.stringify(after)}`,
    )
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, root]) removeDir(dir)
  }
})
