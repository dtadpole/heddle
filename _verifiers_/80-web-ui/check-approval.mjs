import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The approval card as a **control**, judged in a browser.
 *
 * The escalation contract in the permission verifier judges the channel; this file judges what a person sees and
 * presses: DSH's card appears when a call asks for a wider mode, carries the model's justification verbatim, offers
 * Reject and Allow once, and the answer actually settles the waiting turn — the allow path lets the one denied call
 * run, the reject path leaves it undone, and the session's own mode never moves in either case.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/** Start a server whose endpoint is scripted, so a specific denied-and-retried call can be arranged. */
function startServer(label, stepsFor) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const home = isolatedHome(`approval-${label}`)
      const work = fixtureDir(`approval-${label}-work`)
      const outsideDir = fixtureDir(`approval-${label}-outside`)
      const outsidePath = join(outsideDir, 'outside.txt')
      const steps = stepsFor({ outsidePath })
      const { config } = scriptedConfig({ home, steps })
      const child = spawn(
        ...heddleCommand([
          'web',
          '--host',
          '127.0.0.1',
          '--port',
          '0',
          '--endpoint',
          'scripted',
          '--session-root',
          join(home, 'sessions'),
          '--sandbox-root',
          work,
        ]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            url: match[1],
            outsidePath,
            work,
            output: () => output,
            close: async () => {
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
              removeDir(outsideDir)
            },
          })
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
    })()
  })
}

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** A turn whose first call is denied under workspace-write and whose retry asks to widen to full access. */
const escalationSteps = ({ outsidePath }) => [
  { toolCall: { name: 'bash', arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}` } } },
  {
    toolCall: {
      name: 'bash',
      arguments: {
        command: `echo outside > ${JSON.stringify(outsidePath)}`,
        sandbox_permissions: 'danger-full-access',
        justification: 'the write target is outside the workspace and the task requires it',
      },
    },
  },
  { text: 'done' },
]

/** Send one message through the composer, the way a person does. */
async function sendMessage(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    return true
  })()`)
}

test('the approval card appears with the justification, and Allow once runs the one denied call', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('allow', escalationSteps)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await sendMessage(browser, 'write outside the workspace')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === false', 20_000), 'the approval card appears')

    const card = JSON.parse(
      await browser.evaluate(`(() => {
        const card = document.getElementById('approval-card')
        return JSON.stringify({
          title: document.getElementById('approval-title').textContent,
          reason: document.getElementById('approval-reason').textContent,
          reject: document.getElementById('approval-reject').textContent,
          allow: document.getElementById('approval-allow').textContent,
          role: card.getAttribute('role'),
        })
      })()`),
    )
    assert.equal(card.title, 'Waiting for approval', 'the card says what it is waiting for')
    assert.equal(card.role, 'alertdialog', 'and is a blocking question, not a decoration')
    assert.match(card.reason, /danger-full-access/, 'the question names the mode being requested')
    assert.match(card.reason, /the write target is outside the workspace/, 'and carries the model’s justification verbatim')
    assert.equal(card.reject, 'Reject', 'a way to say no')
    assert.equal(card.allow, 'Allow once', 'and a way to allow exactly this call')

    await browser.evaluate('document.getElementById("approval-allow").click()')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === true', 10_000), 'answering hides the card')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 20_000), 'and the turn finishes')
    assert.equal(existsSync(server.outsidePath), true, 'the allowed retry wrote the file the mode refused a moment ago')

    /** The widening was for one call, never for the session: the chip still says workspace-write. */
    assert.equal(await browser.evaluate('document.getElementById("access-label").textContent'), 'Workspace Write', 'the session’s own mode did not move')
    const sessions = await request(server, '/api/sessions').then((response) => response.json())
    const record = await request(server, `/api/sessions/${encodeURIComponent(sessions[0].id)}`).then((response) => response.json())
    assert.equal(record.permission?.mode, 'workspace-write', 'and the session record agrees')
  } finally {
    browser.close()
    await server.close()
  }
})

test('Reject answers the card, and the denied call stays undone', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('reject', escalationSteps)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await sendMessage(browser, 'write outside the workspace')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === false', 20_000), 'the card appears')

    await browser.evaluate('document.getElementById("approval-reject").click()')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === true', 10_000), 'Reject hides it')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 20_000), 'and the turn finishes')
    assert.equal(existsSync(server.outsidePath), false, 'the rejected call wrote nothing')
    assert.ok(
      await browser.waitFor('document.getElementById("log").innerText.includes("rejected")', 10_000),
      'and the transcript says the ask was rejected',
    )
  } finally {
    browser.close()
    await server.close()
  }
})

test('Stop ends a turn that is waiting on an approval, instead of leaving it stuck', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's report: approving the card seemed to change nothing, and then Stop did nothing either — the turn sat
   * waiting. The two are the same defect: the escalation's approval ask never carried the call's abort signal, so
   * Stop could not settle it and the wait ran to its five-minute timeout. DSH's approval service races the signal
   * (`dsh-user-approval.decide` answers `cancelled` on abort), and this proves the same here: a card is showing, the
   * person presses Stop, and the turn ends in seconds with nothing executed.
   */
  const server = await startServer('stop', escalationSteps)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await sendMessage(browser, 'write outside the workspace')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === false', 20_000), 'the approval card appears')

    /** Stop while the question is open: the abort must answer the ask, not wait for its timeout. */
    const started = Date.now()
    await browser.evaluate('document.getElementById("stop").click()')
    assert.ok(
      await browser.waitFor(
        'document.getElementById("approval-card").hidden === true && document.getElementById("send").hidden === false',
        10_000,
      ),
      'Stop ends the turn and the card goes away',
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `the stop took ${elapsed}ms, not the answer timeout`)
    assert.equal(existsSync(server.outsidePath), false, 'and the stopped call ran nothing')

    /** The question is gone from the server too: a reload has nothing to repaint. */
    const pending = await request(server, '/api/approvals').then((response) => response.json())
    assert.deepEqual(pending.requests, [], 'no question is left waiting after the stop')

    /**
     * The stopped turn left a **well-formed log**: every tool call the model asked for has an answer, because an
     * assistant `tool_calls` message without its tool messages is refused by the provider — that was the 400 a real
     * session hit after a stop.
     */
    const sessions = await request(server, '/api/sessions').then((response) => response.json())
    const sessionId = sessions[0].id
    const record = await request(server, `/api/sessions/${encodeURIComponent(sessionId)}`).then((response) => response.json())
    const tools = (record.turns ?? []).filter((turn) => turn.kind === 'tool')
    assert.ok(tools.length >= 1, 'the turn did ask for a tool')
    for (const tool of tools) assert.notEqual(tool.state, 'running', `the stopped turn's tool call '${tool.name}' is answered`)
    assert.ok(
      tools.some((tool) => /INTERRUPTED|CANCELLED|refused|cancelled/i.test(String(tool.result ?? ''))),
      'and its answer says why it did not run',
    )
  } finally {
    browser.close()
    await server.close()
  }
})

test('a session awaiting approval says Approval on its row, and a turn that ends off screen keeps a done dot until it is opened', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's row status (`sessionStatuses`, dsh-client-ui-workspace `client.js:2068-2117`, drawn at `client.js:2304-2321`): a
   * session waiting on a person carries a warning dot with `Approval` where its time was, whichever session is open; a
   * turn that ends while its session is off screen leaves a done dot (`completionUnread`, dsh-client-ui-session
   * `client.js:948-965`) until the session is opened. Phase A measured neither: only the spinner and "now".
   */
  const server = await startServer('row-status', escalationSteps)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const added = await request(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    assert.equal(added.status, 200, 'the work folder is a workspace')
    const made = async (title) => {
      const response = await request(server, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: server.work, title }) })
      assert.equal(response.status, 200, `created ${title}`)
      return (await response.json()).session
    }
    const quiet = await made('quiet session')
    const busy = await made('busy session')
    const row = (id) => `document.querySelector('#tree li[data-row-key="session:${id}"] > .row')`
    const status = async (id) =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const row = ${row(id)}
          const dot = row === null ? null : row.querySelector(':scope > .status-dot')
          return JSON.stringify({
            row: row !== null,
            state: dot === null ? null : dot.dataset.state,
            label: dot === null ? null : dot.getAttribute('aria-label'),
            beforeName: dot !== null && dot.nextElementSibling !== null && dot.nextElementSibling.classList.contains('label'),
            time: row === null ? null : row.querySelector('.age')?.textContent ?? null,
            fill: dot === null ? null : getComputedStyle(dot, '::after').backgroundColor,
          })
        })()`),
      )
    const open = async (id, title) => {
      await browser.evaluate(`${row(id)}.click()`)
      assert.ok(await browser.waitFor(`document.getElementById('session-title').textContent.includes(${JSON.stringify(title)})`, 10_000), `${title} opens`)
    }

    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    assert.ok(await browser.waitFor(`${row(busy)} !== null && ${row(quiet)} !== null`, 15_000), 'both rows are drawn')
    await open(busy, 'busy session')
    await sendMessage(browser, 'write outside the workspace')
    assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === false', 20_000), 'the turn asks for approval')

    assert.ok(await browser.waitFor(`${row(busy)}.querySelector(':scope > .status-dot[data-state="warning"]') !== null`, 10_000), 'the row turns to the warning dot')
    const waiting = await status(busy)
    assert.equal(waiting.label, 'Waiting for approval', `the dot says what it waits for\nsaw: ${JSON.stringify(waiting)}`)
    assert.equal(waiting.beforeName, true, 'before the name, where the spinner was')
    assert.equal(waiting.time, 'Approval', 'and the row says Approval in place of its time')
    assert.match(String(waiting.fill), /183, 121, 31/, `drawn as a filled warning dot\nsaw: ${waiting.fill}`)

    /** Another session open: the waiting row still says so, and the open one is quiet. */
    await open(quiet, 'quiet session')
    const elsewhere = await status(busy)
    assert.deepEqual([elsewhere.state, elsewhere.time], ['warning', 'Approval'], `the waiting row keeps its mark while off screen\nsaw: ${JSON.stringify(elsewhere)}`)

    /** Answered from outside the page; the turn finishes while the busy session is off screen. */
    const pending = await request(server, '/api/approvals').then((response) => response.json())
    const asked = pending.requests.find((entry) => entry.session === busy)
    assert.ok(asked !== undefined, `the waiting question belongs to the busy session\nsaw: ${JSON.stringify(pending)}`)
    const answer = await request(server, `/api/approvals/${encodeURIComponent(asked.id)}`, { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once' }) })
    assert.equal(answer.status, 200, 'the answer lands')
    assert.ok(await browser.waitFor(`${row(busy)}?.querySelector(':scope > .status-dot[data-state="done"]') != null`, 20_000), 'the finished row carries the done dot')
    const finished = await status(busy)
    assert.equal(finished.label, 'Completed', `labelled for a reader who cannot see it\nsaw: ${JSON.stringify(finished)}`)
    assert.notEqual(finished.time, 'Approval', 'and its time is back')
    assert.match(String(finished.fill), /47, 163, 107/, `in the done colour\nsaw: ${finished.fill}`)
    assert.equal((await status(quiet)).state, null, 'the open session carries no mark')
    assert.equal(existsSync(server.outsidePath), true, 'the allowed call ran')

    /** Opening it is what reads it. */
    await open(busy, 'busy session')
    assert.ok(await browser.waitFor(`${row(busy)}?.querySelector(':scope > .status-dot') === null`, 10_000), 'opening the session clears the done dot')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * Wait out the tree redraw that a turn's end or a session switch schedules (`scheduleTreeRefresh`, 400 ms later): mark the
 * drawn row, then wait until it is replaced or gone. A redraw that already ran leaves the mark where it is, so the wait
 * gives up after five seconds and the caller judges the rows as they stand.
 */
async function afterRedraw(browser, rowExpression) {
  await browser.evaluate(`(() => { const row = ${rowExpression}; if (row !== null) row.dataset.beforeRedraw = 'true'; return true })()`)
  try {
    await browser.waitFor(`(() => { const row = ${rowExpression}; return row === null || row.dataset.beforeRedraw !== 'true' })()`, 5_000)
  } catch {
    // no redraw after the mark: the one the change scheduled had already run
  }
}

test('a session below the fold waits for approval in view, and stays in view after its turn ends off screen (#62)', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH raises a workspace's Show more watermark to the last session within the first fifty that is running, has a
   * running child, awaits the person or carries an unread completion, or is open (`requiredWatermark`,
   * dsh-client-ui-workspace `lib/client.js:2820-2833`), and keeps the raise (`:3095-3096`; README: "the rows stay visible
   * after a run or notification ends"). Before #62 the page raised it for running and open rows only and kept nothing:
   * a session at the seventh row was drawn while its turn ran, and fell back behind `Show 2 more sessions` the moment
   * the turn ended off screen, done dot and all.
   *
   * Six pinned sessions lead the group (pins first, `sessionOrder`), so the busy session is the seventh row however
   * recently it ran.
   */
  const server = await startServer('fold', escalationSteps)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const added = await request(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    assert.equal(added.status, 200, 'the work folder is a workspace')
    const title = (await added.json()).record?.title
    const made = async (name) => {
      const response = await request(server, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: server.work, title: name }) })
      assert.equal(response.status, 200, `created ${name}`)
      return (await response.json()).session
    }
    const busy = await made('busy session')
    const pinned = []
    for (let index = 1; index <= 6; index += 1) {
      const id = await made(`pinned session ${index}`)
      const pin = await request(server, `/api/sessions/${encodeURIComponent(id)}/flags`, { method: 'POST', body: JSON.stringify({ pinned: true }) })
      assert.equal(pin.status, 200, `pinned session ${index} is pinned`)
      pinned.push(id)
      // Distinct pin times, so newest-pin-first has one answer.
      await new Promise((done) => setTimeout(done, 15))
    }
    const group = `document.querySelector('#tree > li[data-kind="workspace"] > ul[role="group"]')`
    const row = (id) => `document.querySelector('#tree li[data-row-key="session:${id}"] > .row')`
    const rows = async () =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const list = ${group}
          if (list === null) return JSON.stringify({ ids: [], control: null })
          return JSON.stringify({
            ids: [...list.querySelectorAll(':scope > li[data-kind="session"]')].map((li) => li.dataset.sessionId),
            control: list.querySelector(':scope > li[data-kind="more"] .label')?.textContent ?? null,
          })
        })()`),
      )
    const status = async (id) =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const row = ${row(id)}
          const dot = row === null ? null : row.querySelector(':scope > .status-dot')
          return JSON.stringify({ state: dot === null ? null : dot.dataset.state, time: row === null ? null : row.querySelector('.age')?.textContent ?? null })
        })()`),
      )
    const open = async (id, name) => {
      await browser.evaluate(`${row(id)}.click()`)
      assert.ok(await browser.waitFor(`document.getElementById('session-title').textContent.includes(${JSON.stringify(name)})`, 10_000), `${name} opens`)
    }

    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    assert.ok(await browser.waitFor(`${row(pinned[5])} !== null`, 15_000), 'the group is drawn')
    await open(pinned[5], 'pinned session 6')
    const before = await rows()
    assert.deepEqual(before.ids, [...pinned].reverse().slice(0, 5), `five rows, the pins newest first\nsaw: ${JSON.stringify(before)}`)
    assert.notEqual(before.control, null, 'the busy session starts below the fold, behind the control')

    /** The busy session's turn starts from outside the page and asks for approval while another session is open. */
    const turn = request(server, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'write outside the workspace', session: busy }) }).then((response) =>
      response.text(),
    )
    let asked
    for (let attempt = 0; attempt < 100 && asked === undefined; attempt += 1) {
      const pending = await request(server, '/api/approvals').then((response) => response.json())
      asked = pending.requests.find((entry) => entry.session === busy)
      if (asked === undefined) await new Promise((done) => setTimeout(done, 200))
    }
    assert.ok(asked !== undefined, 'the busy session asks for approval')
    assert.ok(await browser.waitFor(`${row(busy)}?.querySelector(':scope > .status-dot[data-state="warning"]') != null`, 15_000), 'its row comes into view, waiting')
    const waiting = await rows()
    assert.equal(waiting.ids.indexOf(busy), 6, `as the seventh row, without Show more\nsaw: ${JSON.stringify(waiting)}`)
    assert.equal((await status(busy)).time, 'Approval')

    /** Answered from outside the page: the turn ends while the busy session is still off screen. */
    const answer = await request(server, `/api/approvals/${encodeURIComponent(asked.id)}`, { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once' }) })
    assert.equal(answer.status, 200, 'the answer lands')
    await turn
    assert.ok(
      await browser.waitFor(`(() => { const row = ${row(busy)}; return row === null || row.querySelector(':scope > .status-dot[data-state="done"]') !== null })()`, 20_000),
      'the page sees the turn end',
    )
    await afterRedraw(browser, row(busy))
    const finished = await rows()
    assert.equal(finished.ids.indexOf(busy), 6, `the unread row stays in view after the redraw its end scheduled\nsaw: ${JSON.stringify(finished)}`)
    assert.equal(finished.control, null, 'with nothing behind a control')
    assert.equal((await status(busy)).state, 'done', 'and keeps its done dot')

    /** Read it, open a New session, then leave it: the redraw that drops the placeholder still keeps the busy row. */
    await open(busy, 'busy session')
    assert.ok(await browser.waitFor(`${row(busy)}?.querySelector(':scope > .status-dot') === null`, 10_000), 'opening it reads it')
    await browser.evaluate(`document.querySelector('#tree > li[data-kind="workspace"] > .row button[aria-label="New session in ${title}"]').click()`)
    const known = JSON.stringify([busy, ...pinned])
    const selected = `${group}?.querySelector(':scope > li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId`
    assert.ok(await browser.waitFor(`(() => { const id = ${selected}; return id !== undefined && !${known}.includes(id) })()`, 15_000), 'New session opens a placeholder in the workspace')
    const blank = await browser.evaluate(selected)
    await open(pinned[5], 'pinned session 6')
    assert.ok(await browser.waitFor(`${row(blank)} === null`, 10_000), 'leaving the placeholder redraws the tree without it')
    const kept = await rows()
    assert.equal(kept.ids.indexOf(busy), 6, `the watermark does not fall on its own: the busy row is still the seventh\nsaw: ${JSON.stringify(kept)}`)
    assert.equal(kept.ids.length, 7, 'and the placeholder is gone')
    assert.equal(kept.control, 'Show less', 'Show less is what folds it back, as DSH\'s control does')
  } finally {
    browser.close()
    await server.close()
  }
})
