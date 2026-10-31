import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

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
      const child = spawn(...heddleCommand(args), {
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
      }, 15_000).unref()
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
    // The answer is kept whole: a refused completion read as `.body.goal` was an undefined goal and a TypeError that
    // named neither the status nor the server's reason (seen once in eight runs against the Rust binary).
    const completion = await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'complete', goal_id: after.id, revision: after.revision }),
    })
    assert.equal(completion.status, 200, `the goal completed\n${JSON.stringify(completion.body).slice(0, 240)}`)
    const completed = completion.body.goal
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

    await browser.gotoSession(server.url, session)
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

    // Completing hides the dock, as DSH's does; the durable goal is still there until it is cleared.
    await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="complete"]\').click()')
    await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)
    const completedByBar = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(completedByBar.phase, 'complete', 'the record survives the dock that hid it')
    await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'clear', goal_id: completedByBar.id, revision: completedByBar.revision }),
    })
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
    await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)
    const completedSecond = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal(completedSecond.phase, 'complete', 'the second goal completed and its dock went away')
    await api(server.url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'clear', goal_id: completedSecond.id, revision: completedSecond.revision }),
    })

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

test('an active goal is visible in the chat window, live, without a reload', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  /**
   * The owner's report: a session running a goal showed no indicator. The cause was not a missing element — the
   * bar existed above the log — but that it was only refreshed on a session switch or a button press, so a goal
   * created inside a live turn (or advanced by the round driver) never appeared. DSH docks its GoalDock above the
   * composer through `conversation.input.dock`; this test judges the same two claims: it is **in the chat window,
   * above the composer**, and it **appears and updates from the live stream, with no reload**.
   */
  const server = await startServer('dock', [{ text: 'round work' }])
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    const browser = await openBrowser()
    try {
      // Opened before the goal exists: what appears later must come from the stream rather than a reload.
      await browser.gotoSession(server.url, session)
      // The page's own contract (page.html, where `data-ready` is set): waiting for an element waits for the markup,
      // not the behaviour. The event stream opens during boot, so a goal created before boot finished could be missed
      // by a page that was not yet listening — the goal bar then never showed (once in eight runs against the Rust
      // binary). The claim is unchanged: the goal must appear live, created after the page is ready.
      await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
      assert.equal(await browser.evaluate('document.getElementById("goal-bar").hidden'), true, 'no goal, no indicator')

      // A wide budget keeps the goal active while the page reads it, instead of racing a one-round cap.
      const created = await api(server.url, cookie, '/api/goal', {
        method: 'POST',
        body: JSON.stringify({ session, action: 'create', objective: 'be visible while pushing', max_goal_rounds: 500 }),
      })
      assert.equal(created.status, 200, 'the person started a goal')

      await browser.waitFor('document.getElementById("goal-bar").hidden === false', 10_000)
      const shown = JSON.parse(await browser.evaluate(`JSON.stringify({
        phase: document.getElementById('goal-bar').dataset.phase,
        text: document.getElementById('goal-objective').textContent,
        rounds: document.getElementById('goal-rounds').textContent,
        hasGlyph: document.getElementById('goal-glyph') !== null,
        hasRunning: document.getElementById('goal-running') !== null,
        /** DSH's dock tucks 9px into the composer, so "above" is its top edge, not its bottom. */
        abovePrompt: document.getElementById('goal-bar').getBoundingClientRect().top < document.getElementById('prompt').getBoundingClientRect().top,
        tuck: Math.round(document.getElementById('goal-bar').getBoundingClientRect().bottom - document.getElementById('prompt').getBoundingClientRect().top),
        belowLogTop: document.getElementById('goal-bar').getBoundingClientRect().top > document.getElementById('log').getBoundingClientRect().top,
      })`))
      assert.equal(shown.text, 'be visible while pushing', 'the objective is read from the durable goal')
      assert.equal(shown.phase, 'active', 'the indicator knows the goal is active')
      assert.equal(shown.hasGlyph, true, 'DSH parity: the dock carries a goal glyph')
      assert.equal(shown.hasRunning, true, 'and a running state, from the live stream')
      assert.equal(shown.abovePrompt, true, 'the indicator sits above the composer, where DSH docks it')

      assert.equal(shown.belowLogTop, true, 'and inside the chat column rather than over it')
      /** DSH names the dock's objective and verbs; a person reading with a screen reader gets the same facts. */
      assert.equal(
        await browser.evaluate('document.getElementById("goal-objective").getAttribute("aria-label")'),
        'Goal objective',
        'the objective is named',
      )
      /**
       * The ledger in `_context_/dsh-mechanisms/goal-ui-parity.md` is what these assertions encode: DSH's own
       * dock was measured live (127.0.0.1:8080) and each row is either matched here or kept with a reason.
       */
      assert.equal(await browser.evaluate('document.getElementById("goal-phase").textContent'), 'Ongoing Goal', 'DSH words the phrase, not the phase name')
      const verb = JSON.parse(await browser.evaluate(`(() => {
        const b = document.querySelector('#goal-actions button[data-goal-action="pause"]')
        const s = getComputedStyle(b)
        const r = b.getBoundingClientRect()
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, border: s.borderStyle, svg: b.querySelector('svg') !== null, aria: b.getAttribute('aria-label') })
      })()`))
      assert.deepEqual(verb, { w: 28, h: 28, radius: '999px', border: 'none', svg: true, aria: 'Pause goal' }, 'the verb is a 28px round icon button, as measured on DSH')
      const textVerbs = JSON.parse(await browser.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#goal-actions button')).filter((b) => (b.textContent || '').trim().length > 0).map((b) => b.textContent.trim()))`))
      assert.deepEqual(textVerbs, [], 'every verb is an icon button, none of them text')
      const dockStyle = JSON.parse(await browser.evaluate(`(() => {
        const el = document.getElementById('goal-bar')
        const s = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return JSON.stringify({ border: s.borderStyle, radius: s.borderRadius, gap: s.gap, h: Math.round(r.height) })
      })()`))
      assert.equal(dockStyle.border, 'none', 'the dock has no border, like DSH\'s')
      /**
       * DSH derives its dock width from the composer card rather than from its content; the owner asked for the
       * visible bar to follow the input area, so the two boxes must share their width and left edge.
       */
      const align = JSON.parse(await browser.evaluate(`(() => {
        const b = document.getElementById('goal-bar').getBoundingClientRect()
        const c = document.getElementById('composer-card').getBoundingClientRect()
        return JSON.stringify({ barX: Math.round(b.x), barW: Math.round(b.width), cardX: Math.round(c.x), cardW: Math.round(c.width) })
      })()`))
      /**
       * DSH's own relationship: bar = min(100%, text column), card = text column + 32, so the bar is 32px narrower
       * than the input card and inset 16px on each side (measured on DSH: bar 680 inside a 712 card).
       */
      assert.ok(Math.abs(align.cardW - align.barW - 32) <= 1, `the bar is DSH's 32px narrower than the input card (bar ${align.barW} vs card ${align.cardW})`)
      assert.ok(Math.abs(align.barX - align.cardX - 16) <= 1, `and inset 16px like DSH's dock inset (bar ${align.barX} vs card ${align.cardX})`)
      /** The rest of the trait ledger: surface, tuck, height, radius, icon colour — DSH's measured values. */
      const traits = JSON.parse(await browser.evaluate(`(() => {
        const bar = document.getElementById('goal-bar')
        const card = document.getElementById('composer-card')
        const b = bar.getBoundingClientRect()
        const c = card.getBoundingClientRect()
        const strip = (el) => { const t = document.createElement('div'); t.style.color = el; document.body.append(t); const v = getComputedStyle(t).color; t.remove(); return v }
        void strip
        return JSON.stringify({
          barBottom: Math.round(b.bottom),
          cardTop: Math.round(c.y),
          height: Math.round(b.height),
          radius: getComputedStyle(bar).borderRadius,
          beforeBg: getComputedStyle(bar, '::before').backgroundColor,
          beforeFilter: getComputedStyle(bar, '::before').backdropFilter,
          iconColor: getComputedStyle(bar.querySelector('[data-goal-action="pause"]')).color,
        })
      })()`))
      /**
       * Measured on DSH: the bar's bottom edge is 6px above the composer card's top edge (bar 679, card 685, with
       * the dock's top aligned to the composer stack). Not a tuck and not a gap of zero — a visible separation.
       */
      const separation = Math.round(traits.cardTop - traits.barBottom)
      assert.ok(separation >= 4 && separation <= 8, `the dock is separated from the input by DSH's 6px (measured ${separation}px)`)
      assert.equal(traits.height, 36, 'the row is DSH\'s fixed 36px')
      assert.equal(traits.radius, '12px', 'with its measured radius')
      assert.notEqual(traits.beforeBg, 'rgba(0, 0, 0, 0)', 'the visible surface is a menu fill on a pseudo-element, not a transparent row')
      assert.match(traits.beforeFilter, /blur/, 'with DSH\'s backdrop blur')
      assert.equal(traits.iconColor, 'rgb(173, 178, 184)', 'the verbs are tertiary-label coloured, as DSH\'s are')

      assert.equal(dockStyle.radius, '12px', 'and DSH\'s 12px radius')
      assert.equal(dockStyle.gap, '10px', 'and its 10px gap')
      assert.ok(dockStyle.h <= 40, 'the row stays a single composer-height row')
      const surface = await browser.evaluate('getComputedStyle(document.getElementById("goal-bar")).boxShadow')
      assert.notEqual(surface, 'none', 'DSH gives the row a hairline ring and a soft shadow rather than a fill')
      assert.equal(await browser.evaluate('getComputedStyle(document.getElementById("goal-bar")).backgroundColor'), 'rgba(0, 0, 0, 0)', 'and no fill behind it')
      const rounds = JSON.parse(await browser.evaluate(`(() => {
        const el = document.getElementById('goal-rounds')
        const r = el.getBoundingClientRect()
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), title: document.getElementById('goal-bar').title })
      })()`))
      assert.ok(rounds.w <= 1 && rounds.h <= 1, 'the round count is not visible text — DSH keeps it in its info popover')
      assert.match(rounds.title, /round \d+\/500/, 'but it is still exposed, as the dock\'s title')

      // The driver is already pushing rounds: the count must move without a reload.
      await browser.waitFor('Number(document.getElementById("goal-rounds").textContent.split(" ")[1].split("/")[0]) >= 1', 20_000)
      const pushing = JSON.parse(await browser.evaluate(`JSON.stringify({
        rounds: document.getElementById('goal-rounds').textContent,
        running: document.getElementById('goal-bar').dataset.running,
      })`))
      assert.match(pushing.rounds, /\d+\s*\/\s*500/, 'the round count is drawn from the goal')
      /**
       * The running state follows a turn in flight through the same `runningSessions` set the composer uses, and a
       * scripted round can start and finish between two reads — so this asserts the state is wired (a boolean from
       * the stream), and the negative case below is the deterministic half.
       */
      assert.ok(['true', 'false'].includes(pushing.running), 'the running state is wired to the live stream')

      // A pause is a live edge too: the same dock must follow it, and stop saying "running".
      const current = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      await api(server.url, cookie, '/api/goal', {
        method: 'POST',
        body: JSON.stringify({ session, action: 'pause', goal_id: current.id, revision: current.revision }),
      })
      await browser.waitFor('document.getElementById("goal-bar").dataset.phase === "paused"', 10_000)
      const paused = JSON.parse(await browser.evaluate(`JSON.stringify({
        running: document.getElementById('goal-bar').dataset.running,
        runningHidden: document.getElementById('goal-running').hidden,
      })`))
      assert.equal(paused.running, 'false')
      assert.equal(paused.runningHidden, true, 'a paused goal is not running')

      // Completing it is another live edge: the dock goes away rather than becoming a tombstone over the composer.
      await browser.evaluate('document.querySelector(\'#goal-actions button[data-goal-action="complete"]\').click()')
      await browser.waitFor('document.getElementById("goal-bar").hidden === true', 10_000)
      const completed = (await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
      assert.equal(completed.phase, 'complete', 'the record survives the dock that hid it')
      await api(server.url, cookie, '/api/goal', {
        method: 'POST',
        body: JSON.stringify({ session, action: 'clear', goal_id: completed.id, revision: completed.revision }),
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(await browser.evaluate('document.getElementById("goal-bar").hidden'), true, 'and clearing it changes nothing visually, because it was already gone')
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})
