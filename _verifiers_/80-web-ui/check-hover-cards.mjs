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
 * or the full path; the Ungrouped bucket has no card; leaving the list closes the card.
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
