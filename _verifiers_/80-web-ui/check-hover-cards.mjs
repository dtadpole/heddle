import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The sidebar's row **hover cards**, DSH's (rows C22 and C41 of the parity table).
 *
 * The claim, in DSH's terms (`dsh-client-ui-workspace` `SessionNodeItem` and `ProjectRowItem`, both `HoverCard` with
 * `openDelayMs: 800` inside one `HoverCardGroup`): resting the pointer on a session row opens, after the dwell and not
 * before, a card 8px to the right of the row with the session's full title, its relative time, its own scheduled task
 * (title, frequency, next run) and its status; moving to a workspace row in the same list opens that row's card at once,
 * with the workspace's title, its folder (home abbreviated) and `Created y-m-d hh:mm`; a click on a card copies the title
 * or the full path; the Ungrouped bucket has no card; leaving the list closes the card. The status lines are DSH's
 * whole set (C22): a question or a plan review awaiting the person, the running subagents, an unread completion.
 *
 * And no row names an internal path (#109). DSH's rows carry no `title` (`SessionNodeItem`, lib/client.js:2273-2280;
 * `ProjectRowItem`, :1965-1971). A row here is focusable, so its `title` is read aloud as well as shown: the session row's
 * was its definition folder (`…/_sessions_/session-…`), else its working folder, with the home directory in it. Now it is
 * the session's display title, and no row's title or description carries `_sessions_` or the home directory.
 *
 * The pointer is real (`Input.dispatchMouseEvent`), because a card wired to the wrong event is the failure this exists for.
 * The scheduled task is the model's own, made by a scripted `schedule_create` call, as reminders are made in DSH.
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

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** DSH's `abbreviateHomePath`, for the folder the workspace card should show. */
function abbreviated(path, home) {
  const root = String(home ?? '').replace(/\/+$/, '')
  if (root === '' || root === '/') return path
  if (path === root) return '~'
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

test("a session row and a workspace row open DSH's hover card after the dwell: title, time, scheduled task, status; folder and creation", async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('hover')
  const work = fixtureDir('hover-work')
  const loose = fixtureDir('hover-loose')
  mkdirSync(work, { recursive: true })
  mkdirSync(loose, { recursive: true })
  /** A daily reminder six hours from now, so it is neither due nor delivered while the check runs. */
  const hour = String((new Date().getUTCHours() + 6) % 24).padStart(2, '0')
  const { config, script } = scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'review the week', title: 'Weekly review', daily: { time: `${hour}:00:00`, time_zone: 'UTC' } } } },
      { text: 'reminder set' },
    ],
  })
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'plan the week', folder: work }) })
    assert.equal(turn.status, 200, `a turn ran in the workspace (${turn.status})`)
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'done' }] }))
    const looseTurn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'loose work', folder: loose }) })
    assert.equal(looseTurn.status, 200, `a turn ran where no workspace is registered (${looseTurn.status})`)

    const workspaces = await api(server.url, cookie, '/api/workspaces')
    const workspace = workspaces.body.workspaces.find((entry) => entry.id === added.body.record.id)
    assert.equal(workspace.sessionIds.length, 1, `the workspace owns the turn's session\nsaw: ${JSON.stringify(workspace)}`)
    const sessionId = workspace.sessionIds[0]
    const sessions = await api(server.url, cookie, '/api/sessions')
    const meta = sessions.body.find((entry) => entry.id === sessionId)
    assert.ok(typeof meta?.title === 'string' && meta.title.length > 0, `the session has a title\nsaw: ${JSON.stringify(meta)}`)
    const catalog = await api(server.url, cookie, '/api/schedule/catalog')
    assert.equal(catalog.status, 200, `the reminder catalog answers (${JSON.stringify(catalog.body)})`)
    assert.deepEqual(
      catalog.body.tasks.filter((task) => task.sessionId === sessionId && task.status === 'active').map((task) => task.title),
      ['Weekly review'],
      'the model made one active reminder in that session',
    )

    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const sessionRow = `#tree li[data-kind="session"][data-session-id="${sessionId}"] > .row`
    const workspaceRow = '#tree > li[data-kind="workspace"] > .row'
    const ungroupedRow = '#tree > li[data-kind="ungrouped"] > .row'
    await browser.waitFor(`document.querySelector(${JSON.stringify(sessionRow)}) !== null && document.querySelector(${JSON.stringify(ungroupedRow)}) !== null`, 15_000)

    /**
     * #109, read before the pointer arrives (the card takes the tooltip from a row it covers): what each tree item and row
     * says beyond its text — `title`, `aria-label`, `aria-description`, and the text `aria-describedby` points at.
     */
    const userHome = String(process.env.HOME ?? '').replace(/\/+$/, '')
    const spoken = JSON.parse(
      await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree li, #tree li > .row')].map((node) => ({
        kind: node.closest('li').dataset.kind,
        title: node.getAttribute('title'),
        label: node.getAttribute('aria-label'),
        description: node.getAttribute('aria-description'),
        described: (node.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? ''),
      })))`),
    )
    const leaks = spoken.filter((entry) =>
      [entry.title, entry.label, entry.description, ...entry.described].some((text) => typeof text === 'string' && (text.includes('_sessions_') || (userHome.length > 1 && text.includes(userHome)))),
    )
    assert.ok(spoken.some((entry) => entry.kind === 'session') && spoken.some((entry) => entry.kind === 'workspace'), `the tree drew a session row and a workspace row\nsaw: ${JSON.stringify(spoken)}`)
    assert.deepEqual(leaks, [], `no row's title or description names a definition folder or the home directory (#109)\nsaw: ${JSON.stringify(spoken)}`)
    const tip = JSON.parse(
      await browser.evaluate(`(() => { const row = document.querySelector(${JSON.stringify(sessionRow)}); return JSON.stringify({ title: row.getAttribute('title'), label: row.querySelector(':scope > .label').textContent }) })()`),
    )
    assert.deepEqual(tip, { title: meta.title, label: meta.title }, `the session row's tooltip is its display title, the label it may clip (#109)\nsaw: ${JSON.stringify(tip)}`)
    const box = async (selector) =>
      JSON.parse(await browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2), top: r.top, right: r.right }) })()`))
    const move = (x, y) => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    const visibleCard = `(() => { const card = document.querySelector('.hover-card'); return card !== null && !card.hidden ? (card.dataset.hoverCard ?? 'card') : null })()`
    const read = async (rowSelector) =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const card = document.querySelector('.hover-card')
          const box = card.getBoundingClientRect()
          const texts = (selector) => [...card.querySelectorAll(selector)].map((node) => node.textContent)
          return JSON.stringify({
            title: texts('.hover-title'), path: texts('.hover-path'), time: texts('.hover-time'),
            tasks: texts('.hover-task-name'), timing: texts('.hover-task-timing'), statuses: texts('.hover-status'),
            left: box.left, top: box.top, width: box.width, role: card.getAttribute('role'), label: card.getAttribute('aria-label'),
            rowTitle: document.querySelector(${JSON.stringify(rowSelector)}).getAttribute('title'),
          })
        })()`),
      )

    /** The dwell: nothing at 400 ms, the session's card by DSH's 800 ms. */
    await move(1100, 700)
    const row = await box(sessionRow)
    const started = Date.now()
    await move(row.x, row.y)
    await sleep(400)
    assert.equal(await browser.evaluate(visibleCard), null, 'no card before the dwell')
    await browser.waitFor(`${visibleCard} === 'session'`, 5_000)
    assert.ok(Date.now() - started >= 750, `the card waited for the dwell (${Date.now() - started} ms)`)
    const session = await read(sessionRow)
    assert.deepEqual(session.title, [meta.title], `the card carries the full title\nsaw: ${JSON.stringify(session)}`)
    assert.equal(session.time.length, 1)
    assert.match(session.time[0], /^(now|\d+min ago)$/, 'and how long ago it was written')
    assert.deepEqual(session.tasks, ['Weekly review'], 'and its own scheduled task')
    assert.match(session.timing[0], new RegExp(`^Daily at ${hour}:00 \\(UTC\\+00:00\\) · [A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{2}:\\d{2} \\(in \\d+ (hours?|minutes?)\\)$`), 'with its frequency and next run')
    assert.deepEqual(session.statuses, ['Idle'], 'and its status')
    assert.equal(Math.round(session.left), Math.round(row.right + 8), 'placed 8px right of the row')
    assert.equal(Math.round(session.top), Math.round(row.top), 'level with its top')
    assert.equal(Math.round(session.width), 244, "at DSH's width")
    assert.equal(session.role, 'button')
    assert.equal(session.label, `Copy: ${meta.title}`, 'a click copies the title')
    assert.equal(session.rowTitle, null, 'and the row no longer stacks a native tooltip under it')

    /** The same list is warm: the workspace row's card opens on arrival, with its folder and creation time. */
    const wsRow = await box(workspaceRow)
    await move(wsRow.x, wsRow.y)
    assert.equal(await browser.evaluate(visibleCard), 'workspace', "the next row's card opens without a second dwell")
    const ws = await read(workspaceRow)
    const created = new Date(workspace.createdAt)
    const pad = (value) => String(value).padStart(2, '0')
    assert.deepEqual(
      { title: ws.title, path: ws.path, time: ws.time, label: ws.label },
      {
        title: [workspace.title],
        path: [abbreviated(workspace.path, process.env.HOME)],
        time: [`Created ${created.getFullYear()}-${created.getMonth() + 1}-${created.getDate()} ${pad(created.getHours())}:${pad(created.getMinutes())}`],
        label: `Copy: ${workspace.path}`,
      },
      'the workspace card: title, home-abbreviated folder, creation time, and the full path to copy',
    )
    assert.equal(Math.round(ws.left), Math.round(wsRow.right + 8))

    /** Leaving the list closes the card; the Ungrouped bucket has none. */
    await move(1100, 700)
    await browser.waitFor(`${visibleCard} === null`, 3_000)
    const bucket = await box(ungroupedRow)
    await move(bucket.x, bucket.y)
    await sleep(1_200)
    assert.equal(await browser.evaluate(visibleCard), null, 'Ungrouped has no card')
  } finally {
    browser?.close()
    server.kill()
    for (const dir of [home, work, loose]) removeDir(dir)
  }
})

test("a session card says every status DSH's does: Waiting for answer, Plan awaiting review, the running subagents, Completed (C22)", async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's session card lists the session's statuses (`SessionHoverContent` over `sessionStatuses`, dsh-client-ui-workspace
   * lib/client.js:2141-2165, :2068-2117): its pending interaction of any kind — `Waiting for approval`, `Plan awaiting
   * review`, `Waiting for answer` — or `Running`, then `{n} subagent(s) running` (`runningChildCount`, :1056-1058), else an
   * unread `Completed` (:1068), else `Idle`. Before (R-developer-eight-25), heddle's card read only an approval and a
   * running turn, so each of these four sessions read `Idle`.
   *
   * The store is written before the server starts, by the TypeScript store (the log format's implementation, as the
   * team-view and workspace-tree checks do): a question and a plan review asked by turns that no longer run (`continued`,
   * still answerable, so still awaited), and a teammate child whose turn is then left waiting on its own question, so it
   * runs. The fourth session's turn ends while the page has no session open, so its completion is unread.
   */
  const home = isolatedHome('hover-statuses')
  const work = fixtureDir('hover-statuses-work')
  mkdirSync(work, { recursive: true })
  const root = join(home, 'sessions')
  const { config, script } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'ask_user_question', arguments: { questions: [{ id: 'go', question: 'Carry on?', options: [{ label: 'Yes' }, { label: 'No' }] }] } } }],
  })
  const { SessionStore } = await import('../../src/session/store.ts')
  const { randomUUID } = await import('node:crypto')
  const store = new SessionStore(root)
  const pause = () => new Promise((done) => setTimeout(done, 30))
  const conversation = (title) => {
    const handle = store.create({ cwd: work, title })
    store.message(handle, { role: 'user', content: [{ type: 'text', text: `about ${title}` }] })
    store.append(handle, { type: 'assistant/completed', text: 'noted' })
    return handle
  }
  const asked = (handle, questions) => store.append(handle, { type: 'question/asked', requestId: `question-${randomUUID()}`, questions, timed: false, askedAt: new Date().toISOString(), deadline: null })
  const parent = conversation('lead with a helper')
  await pause()
  const child = store.create({ cwd: work, title: 'the helper', parentSession: parent.id, origin: 'subagent', delegationDepth: 1, teamId: parent.id })
  await pause()
  const questioned = conversation('asks a question')
  asked(questioned, [{ id: 'color', header: 'Pick', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }])
  await pause()
  const reviewed = conversation('plan under review')
  asked(reviewed, [
    {
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?\n\n# Ship it',
      options: [
        { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
        { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
      ],
    },
  ])
  await pause()
  const finishing = conversation('finishes unseen')
  for (const handle of [parent, child, questioned, reviewed, finishing]) store.release(handle)

  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  let waiting = null
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    for (const [handle, kind] of [[questioned, 'color'], [reviewed, 'plan-review']]) {
      const open = await api(server.url, cookie, `/api/questions?session=${encodeURIComponent(handle.id)}`)
      assert.deepEqual((open.body.requests ?? []).map((request) => request.questions?.[0]?.id), [kind], `the server lists the ${kind} request as open\nsaw: ${JSON.stringify(open)}`)
    }

    /** The teammate's turn asks its own question and waits on it: the child runs until the server stops. */
    waiting = fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'help the lead', folder: work, session: child.id }),
    }).then((response) => response.text()).catch(() => {})
    const runs = async () => ((await api(server.url, cookie, '/api/sessions')).body ?? []).some((meta) => meta.id === child.id && meta.running === true)
    let running = false
    for (let tries = 0; tries < 100 && !running; tries += 1) {
      running = await runs()
      if (!running) await sleep(150)
    }
    assert.equal(running, true, "the teammate's turn runs, waiting on its question")
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'done' }] }))

    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const sessionRow = (id) => `#tree li[data-kind="session"][data-session-id="${id}"] > .row`
    const drawn = [parent, questioned, reviewed, finishing].map((handle) => `document.querySelector(${JSON.stringify(sessionRow(handle.id))}) !== null`).join(' && ')
    await browser.waitFor(drawn, 15_000)

    /** The fourth session's turn runs and ends with no session open on the page: its completion is unread, a done dot. */
    const turn = await api(server.url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'one more thing', folder: work, session: finishing.id }) })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await browser.waitFor(`document.querySelector(${JSON.stringify(`${sessionRow(finishing.id)} > .status-dot[data-state="done"]`)}) !== null`, 15_000)

    const move = (x, y) => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    const box = async (selector) =>
      JSON.parse(await browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) }) })()`))
    const statuses = `(() => { const card = document.querySelector('.hover-card'); return card === null || card.hidden || card.dataset.hoverKey !== KEY ? null : JSON.stringify([...card.querySelectorAll('.hover-status')].map((line) => [line.querySelector('.hover-dot')?.dataset.state ?? null, line.textContent])) })()`
    const cardOf = async (handle, expected, what) => {
      const at = await box(sessionRow(handle.id))
      await move(at.x, at.y)
      const probe = statuses.replace('KEY', JSON.stringify(`session:${handle.id}`))
      try {
        await browser.waitFor(`${probe} === ${JSON.stringify(JSON.stringify(expected))}`, 5_000)
      } catch {
        assert.fail(`${what}\nsaw: ${await browser.evaluate(probe)}`)
      }
    }
    await move(1100, 700)
    await cardOf(questioned, [['warning', 'Waiting for answer']], 'a session whose question waits says Waiting for answer')
    await cardOf(reviewed, [['warning', 'Plan awaiting review']], 'a session whose plan is under review says Plan awaiting review')
    await cardOf(parent, [['ongoing', '1 subagent running']], 'a session whose subagent runs says how many')
    await cardOf(finishing, [['done', 'Completed']], 'a session whose turn ended unseen says Completed')
  } finally {
    browser?.close()
    server.kill()
    void waiting
    removeDir(home)
    removeDir(work)
  }
})
