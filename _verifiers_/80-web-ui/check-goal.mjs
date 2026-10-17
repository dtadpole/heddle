import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

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

async function startServer(label, steps, options = {}) {
  const home = options.home ?? isolatedHome(`goal-${label}`)
  const work = options.work ?? fixtureDir(`goal-${label}-work`)
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({
    home,
    steps: steps ?? [{ toolCall: { name: 'create_goal', arguments: { objective: 'ship goal management', max_goal_rounds: 3 } } }, { text: 'the goal is created' }],
  })
  /**
   * The bar test judges the **verbs**, so its server leaves the round driver out: with the driver loaded,
   * the goal the model creates would start continuing on its own and the test would be judging the bar
   * against a moving target. The rounds test is the one that wants the driver, and it uses the default
   * profile.
   */
  let patch = []
  if (options.withoutDriver === true) {
    const file = join(home, 'no-driver.yml')
    writeFileSync(file, '- remove:\n    - goal-driver\n')
    patch = ['--patch', file]
  }
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), ...patch, '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      /** A restart test keeps the home between lifetimes; the caller removes it at the end. */
      if (options.keep === true) return
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

test('an active goal keeps being pushed after the harness restarts', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  /**
   * The owner's rule, judged end to end: a restart must not stop an active goal. The harness is killed while
   * it is pushing, started again on the same session store, and the goal is expected to pick up **without a
   * turn and without a person** — because the durable phase is the authority and the server sweeps runnable
   * goals at boot. A purely edge-driven driver would leave it idle here: no event fires for a session that
   * was already active when the process died.
   */
  const home = isolatedHome('goal-restart')
  const work = fixtureDir('goal-restart-work')
  mkdirSync(work, { recursive: true })
  const steps = [{ text: 'keep working' }]
  let server = await startServer('restart', steps, { home, work, keep: true })
  try {
    let cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: work }) })
    const session = opened.body.session?.id ?? opened.body.id

    // An armed goal at rest starts pushing by itself.
    await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'survive a restart', max_goal_rounds: 500 }),
    })
    let before
    for (let attempt = 0; attempt < 100; attempt += 1) {
      before = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      if ((before?.roundsStarted ?? 0) >= 1) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok((before?.roundsStarted ?? 0) >= 1, `the goal was being pushed before the restart\nsaw: ${JSON.stringify(before).slice(0, 240)}`)
    const roundsBeforeRestart = before.roundsStarted

    // Kill the harness mid-push, then bring it back on the same store.
    await server.close()
    server = await startServer('restart', steps, { home, work, keep: true })
    cookie = await cookieFor(server.url)

    let after
    for (let attempt = 0; attempt < 100; attempt += 1) {
      after = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      if ((after?.roundsStarted ?? 0) > roundsBeforeRestart) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(
      (after?.roundsStarted ?? 0) > roundsBeforeRestart,
      `pushing survived the restart\nbefore: ${roundsBeforeRestart}, after: ${JSON.stringify(after).slice(0, 240)}`,
    )
    assert.equal(after.phase, 'active', 'and the goal is still the active one')

    // Leave nothing pushing: complete it and check the rounds stop.
    const completed = (await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'complete', goal_id: after.id, revision: after.revision }),
    })).body.goal
    assert.equal(completed.phase, 'complete')
    const stoppedAt = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.roundsStarted
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.roundsStarted,
      stoppedAt,
      'no round ran after the completion',
    )
  } finally {
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})

test('the model starts a goal through its tool, and a person drives it from the bar', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * Two goals, because they judge two different things.
   *
   * The first is the model's: its tool creates it, the round driver (live in this profile) spends its single
   * allowed round and blocks it at the cap — which lets the bar's *blocked* state and the refusal to resume
   * an exhausted goal be judged. The second is created by the person with a cap the driver cannot reach before
   * the test is done, and since the driver only triggers on a completed turn and no turn runs after it, its
   * verbs can be judged without a moving target.
   */
  const server = await startServer('bar', [
    { toolCall: { name: 'create_goal', arguments: { objective: 'ship goal management', max_goal_rounds: 1 } } },
    { text: 'round one work' },
    { text: 'extra' },
  ])
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

    // The driver continues the goal after the turn; wait for the cap to turn that into a block.
    let first
    for (let attempt = 0; attempt < 100; attempt += 1) {
      first = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      if (first?.phase === 'blocked') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(first !== null && typeof first === 'object', `the model's tool created a goal\nsaw: ${JSON.stringify(first).slice(0, 200)}`)
    assert.equal(first.phase, 'blocked', 'the driver spent the only round and blocked at the cap')
    assert.equal(first.objective, 'ship goal management')
    assert.equal(first.roundsStarted, 1)
    assert.equal(first.blockedReason?.code, 'round-limit')

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
    assert.match(shown.phase, /blocked/i, 'the bar states the durable phase')
    assert.equal(shown.objective, 'ship goal management', 'and the objective')
    assert.match(shown.rounds, /1\/1/, 'and the round it reached')
    assert.deepEqual(shown.verbs, ['resume', 'complete', 'edit', 'clear'], 'a blocked goal offers resume, not pause')

    // Resuming an exhausted goal is the one refusal the bar must show rather than swallow.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="resume"]\').click()')
    await browser.waitFor('document.getElementById("tree-note").textContent.length > 0', 10_000)
    assert.match(await browser.evaluate('document.getElementById("tree-note").textContent'), /exhausted/, 'the bar says the goal has no rounds left')
    assert.equal((await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.phase, 'blocked')

    // Complete then clear: a blocked goal can still be finished and removed.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="complete"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "complete"', 10_000)
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="clear"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)
    const afterClear = await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)
    assert.equal(afterClear.body.goal, null, `the cleared goal is gone (status ${afterClear.status}, body ${JSON.stringify(afterClear.body).slice(0, 200)})`)

    /**
     * The second goal is the person's, with rounds to spare. No turn runs after it is created, so the driver
     * has had no trigger and the bar's pause/resume can be judged directly.
     */
    const second = await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'a goal with room to run', max_goal_rounds: 500 }),
    })
    assert.equal(second.status, 200, 'the person started a second goal')

    /**
     * A goal created at rest is armed, so the driver starts rounds on its own — the behaviour the rounds test
     * judges by counts. Here it is stopped immediately with the person's own verb, because this test is about
     * the **bar** rather than the loop: pausing at rest must leave a paused goal with no round in flight.
     */
    const paused = (await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'pause', goal_id: second.body.goal.id, revision: second.body.goal.revision }),
    })).body.goal
    assert.equal(paused.phase, 'paused')
    assert.equal(paused.activation, 'disarmed')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(
      (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.roundsStarted,
      paused.roundsStarted,
      'no round ran after the pause',
    )

    // Reload so the bar is drawn from the paused goal, then drive it with the person's verbs.
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "paused"', 20_000)
    await browser.waitFor('document.querySelector(\'#goal-actions button[data-goal-action="resume"]\') !== null', 10_000)
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="resume"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "active"', 10_000)
    const resumed = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(resumed.phase, 'active')
    assert.equal(resumed.activation, 'armed')
    const verbs = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#goal-actions button')].map((button) => button.dataset.goalAction))`))
    assert.deepEqual(verbs, ['pause', 'complete', 'edit', 'clear'], 'an active goal offers pause')

    // Pause from the bar: the driver must stop after whatever round is in flight.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="pause"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "paused"', 10_000)
    const pausedAgain = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(pausedAgain.phase, 'paused')
    assert.equal(pausedAgain.activation, 'disarmed')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.roundsStarted,
      pausedAgain.roundsStarted,
      'no round ran after the bar paused the goal',
    )

    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="complete"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "complete"', 10_000)
    assert.equal((await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal.phase, 'complete')
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="clear"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)

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

test('an armed goal continues by itself, round by round, and blocks at its cap', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  /**
   * The round driver, judged end to end. A person creates a goal with a two-round cap; one turn is sent;
   * the driver continues the goal on its own until the cap turns "continue" into "this goal is exhausted",
   * which is DSH's `round-limit` block.
   *
   * The claim is about **attribution**, not only about turns: each automatic round must be a user message
   * the harness wrote, carrying the goal id, its revision and its round number, because that is what the
   * goal fold counts. A driver that ran three anonymous turns would satisfy "it kept going" and violate
   * the thing that makes the cap and the history trustworthy.
   */
  const server = await startServer('rounds', [{ text: 'round one work' }, { text: 'round two work' }, { text: 'round three work' }, { text: 'extra' }])
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    // A turn first, so the goal is created **at rest** and the driver's rounds never race a human turn.
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'begin', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the first turn ran (${turn.status})`)
    await turn.text()

    /**
     * Creating an armed goal while the session is idle is itself an edge: the reckoner starts the rounds
     * with no turn sent, which is what "an armed goal" means to a person.
     */
    const created = await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'walk two rounds and stop', max_goal_rounds: 2 }),
    })
    assert.equal(created.status, 200, 'the person started a capped goal')

    // The driver runs in the server process after the turn; wait for the cap to turn into a block.
    let goal
    for (let attempt = 0; attempt < 100; attempt += 1) {
      goal = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      if (goal?.phase === 'blocked') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(goal.phase, 'blocked', `the goal stopped by itself at its cap\nsaw: ${JSON.stringify(goal)}`.slice(0, 400))
    assert.equal(goal.roundsStarted, 2, 'two rounds were admitted, not one and not three')
    assert.equal(goal.blockedReason?.code, 'round-limit', 'and it says why it stopped')
    assert.equal(goal.activation, 'disarmed', 'a blocked goal does not continue')

    // The rounds are attributable in the transcript: goal-sourced user messages, numbered 1 and 2.
    const events = readTranscript(join(server.home, 'sessions', session))
    const rounds = events
      .filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'goal')
      .map((event) => ({
        round: event.message.source.round,
        goalId: event.message.source.goalId,
        revision: event.message.source.revision,
        text: (event.message.content ?? []).map((part) => part.text ?? '').join(''),
      }))
    assert.deepEqual(rounds.map((round) => round.round), [1, 2], `exactly the two rounds the cap allowed\nsaw: ${JSON.stringify(rounds).slice(0, 300)}`)
    assert.ok(rounds.every((round) => round.goalId === goal.id), 'each round names the goal it serves')
    assert.match(rounds[0].text, /Round: 1\/2/, 'and carries its round number')
    assert.match(rounds[1].text, /Round: 2\/2/)
    assert.match(rounds[0].text, /Objective: "walk two rounds and stop"/)
  } finally {
    await server.close()
  }
})
