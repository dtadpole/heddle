import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The model's goal verbs and who may use them, judged as DSH's `dsh-tool-goal` behaves
 * (goals-todo-spec.md section A; R-developer-nine-2, -3 and -4).
 *
 * Five claims, each through the build under test (the TypeScript dist, or the binary `HEDDLE_BIN` names):
 *
 * 1. **A person's turn may edit a goal**: `update_goal` takes DSH's `edit` verb, which replaces the objective,
 *    bumps the revision and leaves the phase alone.
 * 2. **A person's turn may block a goal with a plain sentence**: `blocked_reason` is a string, stored as
 *    `{ code: 'model-reported', message }`, and a person's own verb ends no run.
 * 3. **A goal round cannot rewrite its own goal**: `edit` needs a direct human turn, so the round gets DSH's
 *    `GOAL_TOOL_AUTHORITY_REQUIRED` refusal and the objective stands.
 * 4. **A goal round cannot give up early**: `blocked` from a goal round before round 3 is DSH's
 *    `GOAL_TOOL_BLOCK_THRESHOLD` refusal, and the goal stays active.
 * 5. **A goal round's `complete` ends the run in DSH's words**: the answer carries DSH's `<goal_complete>`
 *    closing instruction and the goal is complete.
 *
 * It is gated on the Web command alone, never on the goal verbs, so a build without the fix fails here rather
 * than skipping: the failures this exists to catch are a verb the model is taught that the tool refuses, a reason
 * shape the model cannot produce, and a harness-started turn borrowing a person's authority.
 *
 * Every model step comes from the offline scripted endpoint, which re-reads its script on every model request, so
 * the check rewrites it between steps: a later step names the goal's real id and revision.
 *
 * - Claims 1 and 2 run in a person's turns, on a server without the round driver: with the driver loaded, the goal
 *   the person's first turn creates would start continuing on its own, and a round racing the person's second turn
 *   could close the turn the person's message opened.
 * - Claims 3 to 5 run in a real goal round on the default profile. A goal created through `POST /api/goal` at rest
 *   starts its first round at once, before the check can know the new goal's id, so the round's first step is a
 *   gate (a shell call that waits for a file); the check rewrites the script with the real ref and then opens the
 *   gate, and the round's next step makes the call. The cap is one round, so the driver stops by itself: at its
 *   `round-limit` block, or at the goal the round completed.
 */
const CAPABILITY = 'the Web UI'

/** DSH's sentences, verbatim (dsh-tool-goal:64, 360); the session log renders a refusal as `error (CODE): message`. */
const HUMAN_REQUIRED = 'error (GOAL_TOOL_AUTHORITY_REQUIRED): this goal operation requires a direct human turn on a top-level agent'
const BLOCK_THRESHOLD_AT_ROUND_1 = 'error (GOAL_TOOL_BLOCK_THRESHOLD): blocked requires at least 3 consecutive goal rounds; current round is 1'

async function startServer(label, options = {}) {
  const home = isolatedHome(`goal-tool-${label}`)
  const work = fixtureDir(`goal-tool-${label}-work`)
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  /**
   * A `--patch` overlay replaces the project patch beside `--config` rather than following it, so the server
   * without the driver names the default tree's own patch first and removes the driver after it.
   */
  let patch = []
  if (options.withoutDriver === true) {
    const file = join(home, 'no-driver.yml')
    writeFileSync(file, '- remove:\n    - goal-driver\n')
    patch = ['--patch', join(repoRoot, 'heddle.patch.yml'), '--patch', file]
  }
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), ...patch, '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  const close = () => {
    child.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
  try {
    const url = await new Promise((resolvePromise, reject) => {
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match) resolvePromise(match[1])
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
      setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
    })
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
    return { home, work, url, script, cookie, output: () => output, close }
  } catch (error) {
    // A server that never came up leaves nothing behind either.
    close()
    throw error
  }
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function openSession(server, folder) {
  mkdirSync(folder, { recursive: true })
  await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
  const opened = await api(server, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder }) })
  const id = opened.body.session?.id ?? opened.body.id
  assert.match(String(id), /^session-/, `the folder opened a session\nsaw: ${JSON.stringify(opened)}`)
  return id
}

const steps = (server, list) => writeFileSync(server.script, JSON.stringify({ steps: list }))

/** A person's turn: a prompt sent through the page's own route, which writes it with no source. */
async function turn(server, session, folder, list) {
  steps(server, list)
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'goal probe', folder, session }),
  })
  assert.equal(response.status, 200, `the turn ran (${response.status})`)
  await response.text()
}

const events = (server, session) => readTranscript(join(server.home, 'sessions', session))
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')
/** The answers one tool gave, in order; the scripted endpoint names every call `call-<tool>`. */
const answersOf = (list, tool) => list.filter((event) => event.type === 'message' && event.message?.role === 'tool' && event.message?.toolCallId === `call-${tool}`).map(textOf)
const isRound = (event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'goal'
const goalChanges = (list) => list.filter((event) => event.type === 'goal/change')

async function goalOf(server, session) {
  const read = await api(server, `/api/goal?session=${encodeURIComponent(session)}`)
  assert.equal(read.status, 200, `the goal route answers\nsaw: ${JSON.stringify(read)}`)
  return read.body.goal
}

async function waitFor(read, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

/** The tool answer as JSON; a refusal that is not JSON fails the comparison with its own text in view. */
function json(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { unparsed: text }
  }
}

/**
 * Run one goal round whose second step is `call(goal)`, and return what it left.
 *
 * A person's turn first, so the goal is created **at rest** and its round never races a person's turn. The goal is
 * the person's, created through the page's route with a one-round cap; the driver starts round 1 on its own, and
 * the round waits at its gate until the script names the real goal.
 */
async function oneRound(server, label, objective, call, after = []) {
  const folder = join(server.work, label)
  const session = await openSession(server, folder)
  await turn(server, session, folder, [{ text: 'ready' }])

  const ready = join(server.work, `${label}.ready`)
  const gate = {
    toolCall: { name: 'bash', arguments: { command: `i=0; while [ ! -e '${ready}' ]; do i=$((i+1)); if [ $i -gt 300 ]; then echo 'the gate never opened'; exit 1; fi; sleep 0.05; done; echo 'gate open'` } },
  }
  steps(server, [gate, { text: 'the round has no goal ref yet' }])
  const created = await api(server, '/api/goal', { method: 'POST', body: JSON.stringify({ session, action: 'create', objective, max_goal_rounds: 1 }) })
  assert.equal(created.status, 200, `the person created a goal at rest\nsaw: ${JSON.stringify(created)}`)
  const goal = created.body.goal
  assert.equal(goal.phase, 'active')
  steps(server, [gate, call(goal), ...after, { text: 'round finished' }])
  writeFileSync(ready, '')

  /** Settled: the round's turn has completed, and the goal has left `active` (the round's own verb, or the cap). */
  const roundOf = (all) => {
    const start = all.findIndex(isRound)
    const end = start < 0 ? -1 : all.findIndex((event, index) => index > start && event.type === 'turn/completed')
    return end > start ? { start, end } : undefined
  }
  const settled = await waitFor(
    async () => {
      if (roundOf(events(server, session)) === undefined) return undefined
      const current = await goalOf(server, session)
      return current !== null && current !== undefined && current.phase !== 'active' ? current : undefined
    },
    20_000,
    'the goal round to complete and the goal to leave active',
  )
  const all = events(server, session)
  const { start, end } = roundOf(all)
  return { session, goal, settled, all, round: all.slice(start, end + 1), source: all[start].message.source }
}

test("in a person's turn, update_goal edit replaces the objective, bumps the revision and keeps the phase", { timeout: 60_000 }, async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('edit', { withoutDriver: true })
  try {
    const folder = join(server.work, 'edit')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'create_goal', arguments: { objective: 'draft the release notes' } } }, { text: 'goal set' }])
    const created = json(answersOf(events(server, session).slice(mark), 'create_goal')[0] ?? '')
    assert.match(String(created.id), /^goal-/, `create_goal answers the goal it created\nsaw: ${JSON.stringify(created)}`)

    mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'update_goal', arguments: { goal_id: created.id, revision: created.revision, action: 'edit', objective: 'draft and publish the release notes' } } },
      { text: 'goal edited' },
    ])
    const answer = answersOf(events(server, session).slice(mark), 'update_goal')[0] ?? ''
    const edited = json(answer)
    assert.equal(edited.objective, 'draft and publish the release notes', `update_goal takes DSH's edit verb in a person's turn\nsaw: ${answer}`)
    assert.equal(edited.revision, created.revision + 1, 'an edit is one new revision')
    assert.equal(edited.phase, 'active', 'an edit leaves the phase alone')

    const goal = await goalOf(server, session)
    assert.equal(goal.id, created.id, 'the same goal, edited in place')
    assert.equal(goal.objective, 'draft and publish the release notes')
    assert.equal(goal.revision, created.revision + 1)
    assert.equal(goal.phase, 'active')
  } finally {
    server.close()
  }
})

test("in a person's turn, update_goal blocked takes a plain sentence and stores it as a model-reported reason", { timeout: 60_000 }, async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('blocked', { withoutDriver: true })
  try {
    const folder = join(server.work, 'blocked')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'create_goal', arguments: { objective: 'migrate the database' } } }, { text: 'goal set' }])
    const created = json(answersOf(events(server, session).slice(mark), 'create_goal')[0] ?? '')
    assert.match(String(created.id), /^goal-/, `create_goal answers the goal it created\nsaw: ${JSON.stringify(created)}`)

    mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'update_goal', arguments: { goal_id: created.id, revision: created.revision, action: 'blocked', blocked_reason: 'waiting for the user' } } },
      { text: 'goal blocked' },
    ])
    const answer = answersOf(events(server, session).slice(mark), 'update_goal')[0] ?? ''
    assert.equal(json(answer).phase, 'blocked', `update_goal blocked takes a string reason in a person's turn\nsaw: ${answer}`)
    assert.ok(!answer.includes('<goal_blocked>'), `a person's own blocked ends no run, so no closing instruction follows\nsaw: ${answer}`)

    const goal = await goalOf(server, session)
    assert.equal(goal.id, created.id)
    assert.equal(goal.phase, 'blocked', `the goal is blocked\nsaw: ${JSON.stringify(goal)}`)
    assert.deepEqual(goal.blockedReason, { code: 'model-reported', message: 'waiting for the user' }, "the reason is stored in DSH's shape")
  } finally {
    server.close()
  }
})

test('a goal round cannot edit its own goal', { timeout: 60_000 }, async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('round-edit')
  try {
    const objective = 'keep the objective a person wrote'
    const { goal, settled, all, round, source } = await oneRound(
      server,
      'round-edit',
      objective,
      (current) => ({ toolCall: { name: 'update_goal', arguments: { goal_id: current.id, revision: current.revision, action: 'edit', objective: 'an objective the round wrote itself' } } }),
      [{ toolCall: { name: 'get_goal', arguments: {} } }],
    )
    assert.deepEqual(source, { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, "the call ran in the goal's exact round 1")
    assert.equal(answersOf(round, 'update_goal')[0], HUMAN_REQUIRED, 'edit needs a direct human turn, and a goal round is not one')
    const seen = json(answersOf(round, 'get_goal')[0] ?? '')
    assert.equal(seen.objective, objective, `the goal the round read back is unedited\nsaw: ${JSON.stringify(seen)}`)
    assert.equal(seen.revision, goal.revision)
    assert.equal(settled.id, goal.id)
    assert.equal(settled.objective, objective, 'the objective stands after the round')
    assert.ok(!goalChanges(all).some((event) => event.operation === 'edit'), 'no edit reached the log')
  } finally {
    server.close()
  }
})

test('a goal round cannot mark its goal blocked before round 3', { timeout: 60_000 }, async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('round-blocked')
  try {
    const { goal, settled, all, round, source } = await oneRound(
      server,
      'round-blocked',
      'finish the migration',
      (current) => ({ toolCall: { name: 'update_goal', arguments: { goal_id: current.id, revision: current.revision, action: 'blocked', blocked_reason: 'the staging database is down' } } }),
      [{ toolCall: { name: 'get_goal', arguments: {} } }],
    )
    assert.deepEqual(source, { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, "the call ran in the goal's exact round 1")
    assert.equal(answersOf(round, 'update_goal')[0], BLOCK_THRESHOLD_AT_ROUND_1, 'a goal round may not block before round 3')
    const seen = json(answersOf(round, 'get_goal')[0] ?? '')
    assert.equal(seen.phase, 'active', `the goal is still active after the refusal\nsaw: ${JSON.stringify(seen)}`)
    assert.equal(seen.blockedReason, undefined, 'and carries no reason')
    assert.equal(seen.revision, goal.revision)
    // The one-round cap then stops the driver with its own block; the model's reason never landed.
    assert.equal(settled.blockedReason?.code, 'round-limit', `only the driver's cap blocked the goal\nsaw: ${JSON.stringify(settled)}`)
    assert.ok(!goalChanges(all).some((event) => event.goal?.blockedReason?.code === 'model-reported'), 'no model-reported block reached the log')
  } finally {
    server.close()
  }
})

test("a goal round's complete ends the run with DSH's closing instruction", { timeout: 60_000 }, async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('round-complete')
  try {
    const objective = 'ship the goal tools'
    const { session, goal, settled, all, round, source } = await oneRound(server, 'round-complete', objective, (current) => ({
      toolCall: { name: 'update_goal', arguments: { goal_id: current.id, revision: current.revision, action: 'complete' } },
    }))
    assert.deepEqual(source, { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, "the call ran in the goal's exact round 1")
    const answer = answersOf(round, 'update_goal')[0] ?? ''
    const cut = answer.indexOf('\n\n<goal_complete>\n')
    assert.ok(cut > 0, `a goal round's complete appends DSH's <goal_complete> block to the goal\nsaw: ${answer}`)
    const view = json(answer.slice(0, cut))
    assert.equal(view.phase, 'complete', `the answer starts with the completed goal\nsaw: ${answer.slice(0, cut)}`)
    const closing = answer.slice(cut + 2)
    assert.ok(
      closing.startsWith(`<goal_complete>\nObjective: ${JSON.stringify(objective)}\nThe goal is marked complete and this autonomous run is ending. Write the closing message to the user now: `),
      `the closing block opens in DSH's words\nsaw: ${closing}`,
    )
    assert.ok(
      closing.endsWith("Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"),
      `the closing block ends in DSH's words\nsaw: ${closing}`,
    )
    assert.equal(settled.phase, 'complete', `the goal is complete\nsaw: ${JSON.stringify(settled)}`)
    assert.equal(settled.revision, goal.revision + 1)
    assert.equal((await goalOf(server, session)).phase, 'complete')
    assert.equal(all.filter(isRound).length, 1, 'a completed goal starts no further round')
  } finally {
    server.close()
  }
})
