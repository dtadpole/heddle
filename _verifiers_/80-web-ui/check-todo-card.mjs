import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The `todo_write` call in the transcript, judged where a person reads it: DSH's checklist card, not its JSON.
 *
 * DSH gives this one tool its own toolview (dsh-client-ui-tool's `todo-row.js`, `todoToolview`, slot key
 * `todo_write`): the row is titled **Update to-do list**, its closed line reads `{done}/{total} completed · <first
 * in-progress item>` with the change summary after it (`3 added` for a first list), and opened it is the
 * `ToolDetails` card — the caption `Initial list`, one list item per to-do whose mark is an image labelled by its
 * change or status (`role="img"`, `aria-label`), the item's text, and its status in words. The raw call stays
 * reachable behind DSH's **Inspect**, and is not what the row shows.
 *
 * The claim is judged twice on the same session — **live**, as the call streams into an open page, and again after
 * a **reload**, when the row is drawn from the log — and the two readings must be the same card. The gate is the Web
 * command and a browser, never the card itself, so this check fails on a page that still draws the generic row.
 */

const CAPABILITY = 'web'

function cookieFor(handshake) {
  return (handshake.headers.get('set-cookie') ?? '').split(';')[0]
}

async function startServer(steps) {
  const home = isolatedHome('todo-card-check')
  const work = fixtureDir('todo-card-check-work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps })
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        resolve(match[1])
      }
    }, 50)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error('server did not start\n' + out))
    }, 15_000)
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = cookieFor(handshake)
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  const setScript = (steps) => writeFileSync(script, JSON.stringify({ steps }))
  return { url, work, api, script, setScript, close: () => child.kill() }
}

/** The `todo_write` row of the transcript; it exists on every page, the generic one included. */
const ROW = `document.querySelector('#log details.turn.tool[data-tool-name="todo_write"]')`

/**
 * Open the row the way a person does — a click on its line — and read what it shows.
 *
 * Visibility is the browser's own (`checkVisibility()` and a laid-out box), so a raw call kept inside a closed
 * disclosure counts as out of sight and one drawn in the open row counts as seen.
 */
const READ_CARD = `(() => {
  const row = ${ROW}
  if (row === null) return JSON.stringify({ row: false })
  const line = row.querySelector(':scope > summary')
  if (!row.open) line.click()
  const visible = (element) => element !== null && (typeof element.checkVisibility !== 'function' || element.checkVisibility()) && element.getClientRects().length > 0
  const rawShown = () => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.data.includes('{"todos"') && visible(node.parentElement)) return true
    }
    return false
  }
  const items = Array.from(row.querySelectorAll(':scope > [data-body] li')).filter(visible).map((item) => ({
    text: (item.querySelector('.todo-call-text') ?? item).textContent.trim(),
    status: item.dataset.status ?? null,
    mark: item.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null,
    statusText: item.querySelector('.todo-call-status')?.textContent.trim() ?? null,
  }))
  const caption = row.querySelector('.todo-call-caption')
  const inspect = Array.from(row.querySelectorAll(':scope > [data-body] summary')).find((node) => node.textContent.trim() === 'Inspect') ?? null
  return JSON.stringify({
    row: true,
    rows: document.querySelectorAll('#log details.turn.tool[data-tool-name="todo_write"]').length,
    open: row.open,
    title: line.querySelector('.title')?.textContent ?? null,
    hint: line.querySelector('.hint')?.textContent ?? null,
    suffix: line.querySelector('.todo-call-suffix')?.textContent ?? null,
    caption: visible(caption) ? caption.textContent : null,
    items,
    rawShown: rawShown(),
    innerTextHasJson: row.innerText.includes('{"todos"'),
    inspect: visible(inspect),
  })
})()`

/** Open DSH's Inspect and report whether the raw call is now in sight; closes it again afterwards. */
const INSPECT_RAW = `(() => {
  const row = ${ROW}
  const inspect = Array.from(row.querySelectorAll(':scope > [data-body] summary')).find((node) => node.textContent.trim() === 'Inspect') ?? null
  if (inspect === null) return JSON.stringify({ inspect: false })
  inspect.click()
  const visible = (element) => element !== null && (typeof element.checkVisibility !== 'function' || element.checkVisibility()) && element.getClientRects().length > 0
  const args = row.querySelector('[data-args]')
  const result = row.querySelector('[data-result]')
  const shown = { inspect: true, args: visible(args) && args.textContent.includes('{"todos"'), result: visible(result) ? result.textContent : null }
  inspect.click()
  return JSON.stringify(shown)
})()`

test('a todo_write call is drawn as DSH\'s checklist card, live and again after a reload', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const plan = [
    { content: 'research the reference', status: 'completed' },
    { content: 'write the service', status: 'in_progress' },
    { content: 'build the panel', status: 'pending' },
  ]
  const server = await startServer([
    { toolCall: { name: 'todo_write', arguments: { todos: plan } } },
    { text: 'plan written' },
  ])
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    assert.ok(typeof session === 'string' && session.length > 0, `a session exists (${JSON.stringify(opened.body).slice(0, 200)})`)

    const showSession = async () => {
      await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
      await browser.evaluate(`Promise.resolve(globalThis.showSession(${JSON.stringify(session)})).then(() => true)`, 20_000)
    }
    const settled = `(() => { const row = ${ROW}; return row !== null && row.querySelector('[data-result]') !== null && row.dataset.state === 'ok' })()`

    await browser.goto(server.url)
    await showSession()
    /** A mark on the document: if it is still there after the turn, the row was drawn live rather than by a reload. */
    await browser.evaluate('(() => { window.__todoCardLive = true; return true })()')

    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: cookieFor(await fetch(server.url, { redirect: 'manual' })), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan the work', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    // 1. live: the row the stream drew, with its result landed in it.
    await browser.waitFor(settled, 20_000)
    await browser.waitFor('Array.from(document.querySelectorAll("#log .turn.assistant")).some((node) => node.textContent.includes("plan written"))', 20_000)
    assert.equal(await browser.evaluate('window.__todoCardLive === true'), true, 'the row was drawn live, without a reload')
    const live = JSON.parse(await browser.evaluate(READ_CARD))
    const expectCard = (card, when) => {
      assert.ok(card.row, `${when}: the todo_write row exists`)
      assert.equal(card.rows, 1, `${when}: the call and its result are one row`)
      assert.equal(card.open, true, `${when}: a click on the row's line opens it`)
      assert.equal(card.title, 'Update to-do list', `${when}: the row carries DSH's title (todo.rowTitle), not the tool's name\nDIAG ${JSON.stringify(card)}`)
      assert.equal(card.hint, '1/3 completed · write the service', `${when}: the closed line is DSH's "{done}/{total} completed · <active item>"`)
      assert.equal(card.suffix, '3 added', `${when}: the change summary follows it, as DSH's summarySuffix does for a first list`)
      assert.equal(card.caption, 'Initial list', `${when}: the card's caption is DSH's for a first list`)
      assert.deepEqual(
        card.items.map((item) => item.text),
        plan.map((item) => item.content),
        `${when}: every to-do is a visible list item, in the model's order\nDIAG ${JSON.stringify(card.items)}`,
      )
      assert.deepEqual(card.items.map((item) => item.status), ['completed', 'in_progress', 'pending'], `${when}: each item states its own status`)
      assert.deepEqual(card.items.map((item) => item.statusText), ['Completed', 'In progress', 'Pending'], `${when}: and says it in DSH's words`)
      assert.equal(new Set(card.items.map((item) => item.statusText)).size, 3, `${when}: the three statuses read differently`)
      assert.deepEqual(card.items.map((item) => item.mark), ['Added', 'Added', 'Added'], `${when}: each mark is an image labelled by its change, as DSH labels a first list's items`)
      assert.equal(card.rawShown, false, `${when}: no raw {"todos" JSON is in sight in the open row`)
      assert.equal(card.innerTextHasJson, false, `${when}: nor in the row's rendered text`)
      assert.equal(card.inspect, true, `${when}: DSH's Inspect is offered on the open card`)
    }
    expectCard(live, 'live')
    const liveRaw = JSON.parse(await browser.evaluate(INSPECT_RAW))
    assert.equal(liveRaw.inspect, true, 'live: Inspect exists')
    assert.equal(liveRaw.args, true, 'live: Inspect shows the raw call')
    assert.match(String(liveRaw.result), /^Updated todo list: 1 pending, 1 in progress, 1 completed\./, 'live: and the tool\'s answer')

    // 2. reload: the same row, drawn from the log, is the same card.
    await browser.goto(server.url)
    await showSession()
    await browser.waitFor(settled, 20_000)
    assert.notEqual(await browser.evaluate('window.__todoCardLive === true'), true, 'the page really reloaded')
    const reloaded = JSON.parse(await browser.evaluate(READ_CARD))
    expectCard(reloaded, 'reload')
    assert.deepEqual(reloaded, live, 'a reload draws the card the live stream drew')
    const reloadedRaw = JSON.parse(await browser.evaluate(INSPECT_RAW))
    assert.deepEqual(reloadedRaw, liveRaw, 'and Inspect reaches the same raw call')
  } finally {
    await browser.close()
    await server.close()
  }
})
