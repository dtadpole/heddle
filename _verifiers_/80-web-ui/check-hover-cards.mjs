import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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

/** The prompts that tell the double which session's turn is asking (each session's history carries only its own). */
const HOLD = 'C22-HOLD-THIS-TURN-OPEN'
const ASK = 'C22-ASK-A-QUESTION'
const PLAN = 'C22-PRESENT-A-PLAN'

/**
 * A Chat Completions double for the status card check. A request whose history carries `HOLD` is never answered — its
 * stream stays open with a comment every 2 s — so that turn runs until the double closes; `ASK` and `PLAN` answer the
 * turn's first round with an `ask_user_question` and an `exit_plan_mode` call, whose waits never end (the question
 * service's default legacy mode, and the plan review's `timeout: -1`); anything else is a plain answer.
 */
async function statusDouble() {
  const held = new Set()
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const history = JSON.stringify(body.messages ?? [])
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (history.includes(HOLD)) {
        const beat = setInterval(() => response.write(': still working\n\n'), 2_000)
        const entry = { response, beat }
        held.add(entry)
        response.write(': still working\n\n')
        response.on('close', () => {
          clearInterval(beat)
          held.delete(entry)
        })
        return
      }
      const answered = (body.messages ?? []).some((message) => message?.role === 'tool')
      const call =
        answered ? null
        : history.includes(ASK) ? { name: 'ask_user_question', arguments: { questions: [{ id: 'color', header: 'Pick', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }] } }
        : history.includes(PLAN) ? { name: 'exit_plan_mode', arguments: { plan: '# Ship it\n\n1. Build\n2. Release' } }
        : null
      const frames =
        call === null
          ? [{ choices: [{ index: 0, delta: { content: history.includes('Create a concise title') ? 'A title' : 'done' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
          : [
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_c22_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      for (const { beat } of held) clearInterval(beat)
      server.close()
      server.closeAllConnections()
    },
  }
}

test("a session card says every status DSH's does: Waiting for answer, Plan awaiting review, the running subagents, Completed (C22)", async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's session card lists the session's statuses (`SessionHoverContent` over `sessionStatuses`, dsh-client-ui-workspace
   * lib/client.js:2141-2165, :2068-2117): its pending interaction of any kind — `Waiting for approval`, `Plan awaiting
   * review`, `Waiting for answer` — or `Running`, then `{n} subagent(s) running` (`runningChildCount`, :1056-1058), else an
   * unread `Completed` (:1068), else `Idle`. Before (R-developer-eight-25), heddle's card read only an approval and a
   * running turn, so these four sessions read `Running`, `Running`, `Idle` and `Idle`.
   *
   * The sessions are written before the server starts, by the TypeScript store (the log format's implementation, as the
   * team-view and workspace-tree checks do): a lead and its teammate child (`origin: 'subagent'`, `teamId`), and three
   * conversations. Then, through the server and a model double, each gets its state for real: the child's turn is held
   * at its model request, so it runs; one conversation's turn asks the person a question (`ask_user_question`, as
   * check-questions does) and waits; another, in plan mode, presents a plan (`exit_plan_mode`, as check-plan-mode does)
   * and waits on its review; the last one's turn ends while the page has no session open, so its completion is unread.
   * Each state is read back through the API, with a bounded wait, before any card is.
   */
  const home = isolatedHome('hover-statuses')
  const work = fixtureDir('hover-statuses-work')
  mkdirSync(work, { recursive: true })
  const root = join(home, 'sessions')
  const provider = await statusDouble()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const { SessionStore } = await import('../../src/session/store.ts')
  const store = new SessionStore(root)
  const pause = () => new Promise((done) => setTimeout(done, 30))
  const conversation = (title) => {
    const handle = store.create({ cwd: work, title })
    store.message(handle, { role: 'user', content: [{ type: 'text', text: `about ${title}` }] })
    store.append(handle, { type: 'assistant/completed', text: 'noted' })
    return handle
  }
  const parent = conversation('lead with a helper')
  await pause()
  const child = store.create({ cwd: work, title: 'the helper', parentSession: parent.id, origin: 'subagent', delegationDepth: 1, teamId: parent.id })
  await pause()
  const questioned = conversation('asks a question')
  await pause()
  const reviewed = conversation('plan under review')
  await pause()
  const finishing = conversation('finishes unseen')
  for (const handle of [parent, child, questioned, reviewed, finishing]) store.release(handle)

  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    /** A turn posted and left running: its answer is the stream, which ends when the turn does or the server stops. */
    const start = (handle, prompt) => {
      void fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, folder: work, session: handle.id }),
      })
        .then((response) => response.text())
        .catch(() => {})
    }
    const listed = async () => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return Array.isArray(answer) ? answer : []
    }
    const runs = async (handle) => (await listed()).some((meta) => meta.id === handle.id && meta.running === true)
    const waitsOn = async (handle, id) =>
      ((await api(server.url, cookie, `/api/questions?session=${encodeURIComponent(handle.id)}`)).body?.requests ?? []).some((request) => request.state === 'waiting' && request.questions?.[0]?.id === id)
    /** Poll a condition through the API for at most `ms`; fail with what the server said when it never holds. */
    const settle = async (probe, what, ms = 15_000) => {
      const end = Date.now() + ms
      while (!(await probe())) {
        if (Date.now() > end) {
          const sessions = (await listed()).map((meta) => [meta.title, meta.running === true])
          assert.fail(`${what}\nsessions (title, running): ${JSON.stringify(sessions)}`)
        }
        await sleep(150)
      }
    }

    start(child, `${HOLD}: help the lead`)
    await settle(() => runs(child), "the teammate child's turn runs, held at its model request")
    const planned = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(reviewed.id)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/plan' }) })
    assert.equal(planned.status, 200, `/plan puts the session in plan mode (${JSON.stringify(planned.body)})`)
    start(questioned, `${ASK}: pick a colour`)
    await settle(() => waitsOn(questioned, 'color'), 'the question waits for the person')
    start(reviewed, `${PLAN}: plan the release`)
    await settle(() => waitsOn(reviewed, 'plan-review'), 'the plan waits on its review')

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
    /** Each state still holds when its card is read: said by the server just before. */
    await move(1100, 700)
    await settle(() => waitsOn(questioned, 'color'), 'the question still waits')
    await cardOf(questioned, [['warning', 'Waiting for answer']], 'a session whose question waits says Waiting for answer')
    await settle(() => waitsOn(reviewed, 'plan-review'), 'the plan review still waits')
    await cardOf(reviewed, [['warning', 'Plan awaiting review']], 'a session whose plan is under review says Plan awaiting review')
    await settle(() => runs(child), 'the teammate child still runs')
    await cardOf(parent, [['ongoing', '1 subagent running']], 'a session whose subagent runs says how many')
    await cardOf(finishing, [['done', 'Completed']], 'a session whose turn ended unseen says Completed')
  } finally {
    browser?.close()
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
