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
