import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — the Trajectory view.
 *
 * Judges one claim: a session can be read **two ways** — as the conversation it was, and as the ledger of what
 * the harness did — and the two cannot disagree about it.
 *
 * It is a browser check because the failure mode this guards is a view that answers `200` and renders
 * nothing, which is exactly how the Chat view's history broke once and no API-level check could see it. The
 * API half is judged too, because the ledger's shape is a contract: turn, step, kind, timing and usage must
 * be **fields**, not prose a check would have to parse.
 */

const CAPABILITY = 'two views of one session: the conversation, and the ledger of what the harness did'

/**
 * Start the Web UI and resolve once it prints its URL.
 *
 * `runCli` waits for the process to exit, which a server never does — measured, and it is why the first
 * version of this check failed with "the server answered with a URL" while the server was running fine.
 */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
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
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      })
    })()
  })
}

/** Start a server with a scripted model and hand back everything a check needs to stop it. */
async function startServer(label) {
  const home = isolatedHome(`trajectory-${label}`)
  const work = fixtureDir(`trajectory-${label}`)
  const { config } = (await import('../../_tools_/check-helpers/lib.mjs')).scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'bash', arguments: { command: 'pwd' } } },
      { text: 'the answer' },
    ],
  })
  return {
    home,
    work,
    config,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    args: ['--session-root', join(home, 'sessions'), '--sandbox-root', work, '--endpoint', 'scripted'],
  }
}

/** Exchange a server's launch URL for the cookie heddle issues. */
async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

/** Run one turn that uses a tool, so the ledger has something with timing and usage to project. */
async function runOneTurn(server, cookie) {
  const origin = new URL(server.url).origin
  const turn = await fetch(`${origin}/api/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'run pwd and answer' }),
  })
  assert.equal(turn.status, 200, 'the turn that fills the ledger succeeded')
  await turn.text()
  return origin
}

test('the ledger is a projection of the recorded events, in fields rather than prose', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await startServer('api')
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', ...fixture.args], fixture.env)
  try {
    const cookie = await handshakeCookie(server.url)
    await runOneTurn(server, cookie)
    const origin = new URL(server.url).origin
    const sessions = await (await fetch(`${origin}/api/sessions`, { headers: { cookie } })).json()
    const id = sessions[0].id

    const body = await (await fetch(`${origin}/api/sessions/${id}?view=ledger`, { headers: { cookie } })).json()
    assert.ok(body.ledger, 'the response carries a ledger')
    assert.equal(body.id, id, 'for the session asked for')
    assert.ok(Array.isArray(body.ledger.turns) && body.ledger.turns.length > 0, 'with turns')

    const turn = body.ledger.turns[0]
    assert.ok(Array.isArray(turn.steps) && turn.steps.length > 0, 'each turn has steps')
    assert.equal(typeof turn.index, 'number', 'a turn is numbered')
    const step = turn.steps[0]
    assert.equal(typeof step.index, 'number', 'and a step is numbered')

    const records = turn.steps.flatMap((entry) => entry.records)
    const kinds = new Set(records.map((record) => record.kind))
    assert.ok(kinds.has('user'), 'the prompt is a record')
    assert.ok(kinds.has('tool') || kinds.has('assistant'), 'and so is what the harness did about it')
    for (const record of records) {
      assert.equal(typeof record.kind, 'string', 'every record names its kind as a field')
      assert.equal(typeof record.label, 'string', 'and has a label')
      assert.equal(typeof record.text, 'string', 'and its text')
    }

    /**
     * The two rules a reader would believe if they were wrong: a duration only where the events measure one,
     * and a token count only where one was reported.
     */
    const running = records.filter((record) => record.inFlight === true)
    assert.ok(running.every((record) => record.durationMs === undefined), 'an in-flight record carries no duration')
    const withUsage = records.filter((record) => record.usage !== undefined)
    assert.ok(withUsage.length > 0, 'at least the request carries a token count')
    assert.ok(
      withUsage.every((record) => record.usageSource === 'provider' || record.usageSource === 'estimated'),
      'and every count says where it came from',
    )
    assert.equal(body.ledger.inFlight, running.length, 'the ledger counts its in-flight records')

    /**
     * One route, two views. The Chat projection must still answer on the same path, because a second route is
     * how two views of one record start to disagree.
     */
    const chat = await (await fetch(`${origin}/api/sessions/${id}`, { headers: { cookie } })).json()
    assert.ok(Array.isArray(chat.turns), 'the same route still serves the conversation')
    assert.ok(
      chat.turns.some((entry) => entry.text.includes('run pwd')),
      'and it holds the same prompt the ledger does',
    )

    const refused = await fetch(`${origin}/api/sessions/not-a-session?view=ledger`, { headers: { cookie } })
    assert.ok(refused.status === 400 || refused.status === 404, `a non-id is refused (HTTP ${refused.status})`)
  } finally {
    server.kill()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('a browser renders the ledger, its timeline, and switches back to the conversation', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const fixture = await startServer('browser')
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', ...fixture.args], fixture.env)
  /**
   * A deliberately **short** window, because the tail claim only means something if the ledger scrolls: in a
   * tall window a ledger of a few records does not, and "opens at the tail" would pass by being at the top.
   */
  const browser = await openBrowser({ width: 1100, height: 420 })
  try {
    const cookie = await handshakeCookie(server.url)
    await runOneTurn(server, cookie)
    /** A second turn, so the ledger is longer than the pane and the position is testable. */
    await runOneTurn(server, cookie)

    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("views") !== null', 20_000)
    /** Selected through the page's own handler: the left panel's grouping is not what this check judges. */
    const id = (await (await fetch(`${new URL(server.url).origin}/api/sessions`, { headers: { cookie } })).json())[0].id
    await browser.evaluate(`(async () => { await showSession(${JSON.stringify(id)}); return true })()`)
    assert.ok(await browser.waitFor('document.querySelectorAll("#log .turn").length > 0', 20_000), 'the session was selected and its history drawn')

    /**
     * The ring must **offer** both views. It is not asserted to hold exactly these two: the list has changed before —
     * a Docs tab came and went — and a check that pinned the whole list reported that change as a regression in this
     * one. What this part judges is that the conversation and the ledger are both reachable.
     */
    const tabs = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#views button')].map((b) => b.textContent))`))
    assert.ok(tabs.includes('Chat'), `the ring offers the conversation (${JSON.stringify(tabs)})`)
    assert.ok(tabs.includes('Trajectory'), 'and the ledger')

    await browser.evaluate(`document.querySelector('#views button[data-view="trajectory"]').click()`)
    /**
     * The ledger is drawn as a **table**, DSH's shape: one row per event, a kind badge and its content per
     * row. The table's fidelity — one call per row, the details pane, the columns — is judged by the Web UI
     * part's own trajectory check; what this part judges is that the ledger *is* the session's record, in
     * the same window its conversation is.
     */
    assert.ok(await browser.waitFor('document.querySelectorAll("#tr-table tbody tr").length > 0', 20_000), 'the ledger drew rows')

    const drawn = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tr-table tbody tr')]
        return JSON.stringify({
          rows: rows.length,
          kinds: [...new Set(rows.map((row) => row.dataset.kind))],
          withEvent: rows.filter((row) => (row.querySelector('.tr-event') || { innerText: '' }).innerText.trim().length > 0).length,
          withContent: rows.filter((row) => (row.querySelector('.tr-content') || { innerText: '' }).innerText.trim().length > 0).length,
          chatHidden: document.getElementById('log').hidden
        })
      })()`),
    )
    assert.ok(drawn.rows > 0, 'there are rows')
    assert.equal(drawn.withEvent, drawn.rows, 'every row says what happened')
    assert.equal(drawn.withContent, drawn.rows, 'and carries the record itself')
    assert.ok(drawn.kinds.includes('user') && drawn.kinds.includes('assistant'), `the ledger holds the conversation's own turns (${JSON.stringify(drawn.kinds)})`)
    assert.ok(drawn.chatHidden, 'while the conversation is hidden')
    /**
     * And it is hidden **on screen**, not merely marked so.
     *
     * Measured: both views were visible at once. `#log` sets `display: flex` with an id selector and the
     * browser's `[hidden] { display: none }` is a type-level default, so the id won and `hidden` did nothing —
     * the ledger had chat rows drawn above it. A view ring that leaves the previous view visible is worse
     * than no ring, because it looks like one view is wrong rather than two being shown.
     */
    const onlyOneView = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        log: document.getElementById('log').offsetParent !== null,
        ledger: document.getElementById('ledger').offsetParent !== null,
        timeline: document.getElementById('timeline').offsetParent !== null
      })`),
    )
    assert.equal(onlyOneView.log, false, 'the conversation is not drawn while the ledger is shown')
    assert.equal(onlyOneView.ledger, true, 'the ledger is')
    assert.equal(onlyOneView.timeline, true, 'with its timeline')

    /**
     * A row opens its record in the details pane — the reading this view exists for. The pane's own
     * sections are judged by the Web UI part's trajectory check; here the claim is only that the row a
     * reader picks is the one the details pane shows.
     */
    await browser.evaluate(`document.querySelector('#tr-table tbody tr').click()`)
    assert.ok(
      await browser.waitFor('document.getElementById("tr-details") !== null && !document.getElementById("tr-details").hidden', 10_000),
      'clicking a row opens its record',
    )
    const opened = JSON.parse(await browser.evaluate(`JSON.stringify({ chars: document.getElementById('tr-details').innerText.length })`))
    assert.ok(opened.chars > 0, 'and the record is there to read')

    /**
     * The timeline: a strip of **ticks**, one per turn, positioned on the session's recorded span and named by
     * their turn, with the span itself stated beside it.
     *
     * The design changed on 2026-10-17 from one pickable segment per turn to a lane strip of ticks — the shape DSH
     * uses — so the claim is a tick per turn rather than a segment, and the marker is the **scroll that follows the
     * pick**, not an `aria-current` the new control does not set. The old claim is kept in the Git history rather
     * than left in the check, where it would judge a design that no longer exists.
     */
    const timeline = JSON.parse(
      await browser.evaluate(`(() => {
        const band = document.getElementById('timeline')
        const ticks = [...band.querySelectorAll('.tr-tick')]
        return JSON.stringify({
          exists: band !== null,
          ticks: ticks.length,
          proportional: ticks.every((tick) => {
            const left = parseFloat(tick.style.left)
            const width = parseFloat(tick.style.width)
            return Number.isFinite(left) && left >= 0 && left <= 100 && Number.isFinite(width) && width > 0
          }),
          labelled: ticks.every((tick) => /turn \\d+/.test(tick.getAttribute('aria-label') || '')),
          lanes: [...new Set(ticks.map((tick) => tick.dataset.lane))],
          legend: (document.getElementById('timeline-legend') || { innerText: '' }).innerText
        })
      })()`),
    )
    assert.ok(timeline.exists, 'the timeline exists')
    assert.ok(timeline.ticks >= 1, 'with a tick for a turn')
    assert.ok(timeline.proportional, 'each positioned along the axis, with a width the axis gives it')
    assert.ok(timeline.labelled, 'and named by its turn')
    assert.ok(timeline.lanes.length >= 1, `assigned to a lane (${JSON.stringify(timeline.lanes)})`)
    assert.match(timeline.legend, /recorded/, 'with the recorded span stated')

    /**
     * Picking a tick takes the reader to that turn. Measured by **scrolling**: the strip's job is navigation, and a
     * control that changes its own appearance while leaving the reader where they were has not navigated.
     */
    const picked = JSON.parse(
      await browser.evaluate(`(() => {
        const ticks = [...document.querySelectorAll('#timeline .tr-tick')]
        const pane = document.querySelector('.tr-pane')
        const before = Math.round(pane.scrollTop)
        const last = ticks[ticks.length - 1]
        if (last !== undefined) last.click()
        return JSON.stringify({ before, ticks: ticks.length, scrollable: pane.scrollHeight > pane.clientHeight })
      })()`),
    )
    assert.ok(picked.scrollable, 'the ledger is long enough to scroll, so the position means something')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 900))
    const afterPick = await browser.evaluate(`Math.round(document.querySelector('.tr-pane').scrollTop)`)
    assert.notEqual(afterPick, picked.before, `picking the last tick moves the ledger (${picked.before} -> ${afterPick})`)

    /**
     * The ledger opens at its **tail**, and following stops when the reader scrolls up.
     *
     * The rule DSH states, and the reason it exists: a ledger that always jumped to the bottom would be unusable
     * during a long turn, which is exactly when a person wants to read what already happened. The scrolling element
     * is the table's pane rather than the view's outer box, which is a fact about this layout and not about the rule.
     */
    await browser.evaluate(`(() => { const pane = document.querySelector('.tr-pane'); pane.scrollTop = 0; pane.dispatchEvent(new Event('scroll')) })()`)
    await browser.evaluate(`document.querySelector('#tr-table tbody tr').click()`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))
    assert.equal(
      await browser.evaluate(`document.querySelector('.tr-pane').scrollTop`),
      0,
      'and a reader who scrolls to the top is left there, rather than pulled back to the tail',
    )

    await browser.evaluate(`document.querySelector('#views button[data-view="chat"]').click()`)
    assert.ok(await browser.waitFor('!document.getElementById("log").hidden', 5_000), 'and Chat comes back')
    assert.ok(await browser.evaluate('document.getElementById("ledger").hidden'), 'with the ledger put away')
    const backToChat = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        log: document.getElementById('log').offsetParent !== null,
        ledger: document.getElementById('ledger').offsetParent !== null
      })`),
    )
    assert.equal(backToChat.log, true, 'and the conversation drawn again')
    assert.equal(backToChat.ledger, false, 'with the ledger off screen')

    /**
     * The ring is a **tablist**, which is what DSH uses for the same control and what this control is: one of two
     * panels is shown, the other put away. Measured from DSH on 2026-10-17 — `role=tab` with `aria-selected` — while
     * this page said `aria-current`, which means "the current one" and not "one of a set of alternatives".
     *
     * The pattern's promise is that the arrow keys cross the list, so that is judged too, along with the panel each tab
     * names: a tab whose `aria-controls` points at nothing is worse than no tab, because a reader is offered a control
     * that leads nowhere.
     */
    const semantics = JSON.parse(
      await browser.evaluate(`(() => {
        const ring = document.getElementById('views')
        const tabs = [...ring.querySelectorAll('[role="tab"]')]
        return JSON.stringify({
          role: ring.getAttribute('role'),
          tabs: tabs.map((tab) => ({
            text: tab.textContent.trim(),
            selected: tab.getAttribute('aria-selected'),
            controls: tab.getAttribute('aria-controls'),
            target: tab.getAttribute('aria-controls') === null ? false : document.getElementById(tab.getAttribute('aria-controls')) !== null,
            tabIndex: tab.tabIndex
          }))
        })
      })()`),
    )
    assert.equal(semantics.role, 'tablist', 'the ring is a tablist')
    assert.equal(semantics.tabs.length, 2, 'with the two views as tabs')
    assert.ok(semantics.tabs.every((tab) => tab.controls !== null && tab.target), 'and each names a panel that exists')
    assert.equal(semantics.tabs.filter((tab) => tab.selected === 'true').length, 1, 'exactly one is selected')
    assert.equal(semantics.tabs.filter((tab) => tab.tabIndex === 0).length, 1, 'and one of them is in the Tab order')

    /** ArrowRight crosses to the other tab and shows its panel — the behaviour the pattern promises. */
    const crossed = JSON.parse(
      await browser.evaluate(`(() => {
        const ring = document.getElementById('views')
        const selected = ring.querySelector('[role="tab"][aria-selected="true"]')
        selected.focus()
        selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        return JSON.stringify({
          selected: [...ring.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.textContent.trim()),
          focused: document.activeElement === ring.querySelector('[role="tab"][aria-selected="true"]'),
          ledgerShown: !document.getElementById('ledger').hidden,
          logHidden: document.getElementById('log').hidden
        })
      })()`),
    )
    assert.equal(crossed.selected.length, 1, 'the arrow key moves the selection to exactly one tab')
    assert.equal(crossed.focused, true, 'and the focus follows it')
    assert.ok(crossed.ledgerShown && crossed.logHidden, 'with the panel it names shown and the other put away')

  } finally {
    browser.close()
    server.kill()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

/**
 * The sessions a reader can click, in the left panel's "ad hoc" group.
 *
 * The panel became a **folder-bound tree** — a session row exists for an instance of a type folder — so the
 * flat `#sessions` list these checks were written against is gone. What replaced it marks a session row with
 * `data-kind="session"`. The group is opened first, because a collapsed `details` renders nothing to click.
 */
const SESSION_ROW = '#adhoc li[data-kind="session"]'

/** Open the left panel's session group and return how many rows it holds. */
async function openSessionGroup(browser) {
  return browser.evaluate(`(() => {
    const group = document.getElementById('history')
    if (group) group.open = true
    return document.querySelectorAll('${SESSION_ROW}').length
  })()`)
}


/** Whether this build serves a Web UI at all. */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}
