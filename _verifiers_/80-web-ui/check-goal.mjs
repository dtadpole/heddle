import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Goal management, judged where a person and a model each touch it.
 *
 * Two claims. **The model can start a goal**: a scripted turn calls the `create_goal` tool, the tool runs
 * in the loop, and the session's log grows a `goal/change` event that the goal API reads back. **A person
 * can drive it**: the goal bar shows the durable phase and the process-local activation, and its own
 * buttons pause, resume, complete and clear the goal — including the one verb the model is refused,
 * resuming a paused goal, because a pause is a person's decision.
 *
 * The interesting failure this exists to catch is not "the route answers": it is a bar that shows a goal
 * which no longer matches the log, or buttons that offer a transition the table refuses. Every click is
 * therefore followed by a read of the service, not only of the DOM.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`goal-${label}`)
  const work = fixtureDir(`goal-${label}-work`)
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'create_goal', arguments: { objective: 'ship goal management', max_goal_rounds: 3 } } }, { text: 'the goal is created' }],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('the model starts a goal through its tool, and a person drives it from the bar', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('bar')
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    // The tool runs inside a real turn: the scripted endpoint asks for `create_goal`, the loop executes it.
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make this a goal', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    const read = await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)
    assert.equal(read.status, 200, 'the goal API answers')
    const goal = read.body.goal
    assert.ok(goal !== null && typeof goal === 'object', `the model's tool created a goal\nsaw: ${JSON.stringify(read.body).slice(0, 200)}`)
    assert.equal(goal.phase, 'active')
    assert.equal(goal.activation, 'armed')
    assert.equal(goal.objective, 'ship goal management')
    assert.equal(goal.maxGoalRounds, 3)
    assert.equal(goal.roundsStarted, 0)

    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("goal-bar") !== null && document.getElementById("goal-bar").hidden === false', 20_000)
    const shown = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        phase: document.getElementById('goal-phase').textContent,
        objective: document.getElementById('goal-objective').textContent,
        rounds: document.getElementById('goal-rounds').textContent,
        verbs: [...document.querySelectorAll('#goal-actions button')].map((button) => button.dataset.goalAction),
      })`),
    )
    assert.match(shown.phase, /active/i, 'the bar states the durable phase')
    assert.equal(shown.objective, 'ship goal management', 'and the objective')
    assert.match(shown.rounds, /0\/3/, 'and the round it has reached')
    assert.deepEqual(shown.verbs, ['pause', 'complete', 'edit', 'clear'], 'offering only the verbs the table allows on an active goal')

    // Pause: a person's verb, then read the service rather than trusting the DOM.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="pause"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "paused"', 10_000)
    const paused = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(paused.phase, 'paused')
    assert.equal(paused.activation, 'disarmed', 'pausing stops automatic continuation')
    assert.equal(paused.revision, 2)

    // Resume — the verb the model is refused — is offered here because this is a person.
    await browser.waitFor('document.querySelector(\'#goal-actions button[data-goal-action="resume"]\') !== null', 10_000)
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="resume"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "active"', 10_000)
    const resumed = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(resumed.phase, 'active')
    assert.equal(resumed.activation, 'armed')

    // Complete ends the goal, and the bar says so rather than disappearing.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="complete"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "complete"', 10_000)
    assert.equal((await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.phase, 'complete')

    // Clear removes it, and the bar goes away with it.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="clear"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)
    assert.equal((await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal, null)

    // A stale revision is refused with a code, so a client can tell "it moved" from "it is gone".
    const stale = await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'complete', goal_id: 'goal-nothing', revision: 1 }),
    })
    assert.equal(stale.status, 404, 'a goal that does not exist is not found')
    assert.equal(stale.body.code, 'GOAL_NOT_FOUND')
  } finally {
    browser.close()
    await server.close()
  }
})
