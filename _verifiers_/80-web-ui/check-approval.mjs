import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

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
        process.execPath,
        [
          join(repoRoot, 'dist', 'cli.js'),
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
        ],
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
      }, 15_000)
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
  } finally {
    browser.close()
    await server.close()
  }
})
