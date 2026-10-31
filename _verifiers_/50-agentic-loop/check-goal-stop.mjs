import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A goal round stops when a person stops it, and the goal does not continue on its own after a stopped or a failed
 * round (#93, DSH parity).
 *
 * DSH's `dsh-goal-round-driver` README, *When continuation stops*: "The driver also stops on its own when … the agent
 * is cancelled … Cancellation never auto-restarts a round: a goal whose round was under way is paused at the next idle
 * point". And *No abnormal auto-retry*: "transient provider and persistence failures require a later
 * human-authorized resume rather than an implicit retry policy".
 *
 * Measured live on both builds before the fix (#93): the stop route answered `stopped: 0`, because a goal round is
 * started by the goal driver, not by the route's own turn handler. Round 1 ran on, and rounds 2, 3 and 4 started on
 * their own until the cap.
 *
 * Two claims, each through a real `heddle web` (the TypeScript build, or the binary through `HEDDLE_BIN`) on the
 * offline scripted endpoint:
 *
 * 1. **Stop.** Stopping the session during round 1 stops that round (`stopped` ≥ 1). The goal is paused and disarmed,
 *    and no second round starts.
 * 2. **Failure.** A provider that fails every call fails round 1, and no further round starts on its own. The goal
 *    stays active but disarmed until a person resumes it.
 * 3. **Output limit.** A round whose answer is cut at the output limit ends the chain the same way ("the driver also
 *    stops on its own when a turn ends on max tokens"). The chain never waits for an edge between rounds, so this is
 *    the case a trigger-side guard alone cannot stop.
 */

/** One slow round: a tool call that runs long enough to be stopped in, then an answer. */
const SLOW_ROUND = [{ toolCall: { name: 'bash', arguments: { command: 'sleep 6' } } }, { text: 'round done' }]

/** Every answer is cut at the output limit (the canonical finish reason the provider adapters produce). */
const CUT_SHORT = [{ text: 'a partial answer', finishReason: 'max_output_tokens' }]

/** Every call fails, and is not one a retry would fix. */
const FAILING = [{ error: { code: 'SCRIPT', status: 400, message: 'the provider refused the request' } }]

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  return {
    url,
    logs: () => output,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

async function cookieFor(url) {
  const response = await fetch(url, { redirect: 'manual' })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text }
}

async function events(url, cookie, session) {
  const { text } = await api(url, cookie, `/api/sessions/${session}/log`)
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const goalRounds = (log) =>
  log.filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'goal').map((event) => event.message.source)

async function waitFor(read, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A session with one ordinary turn, on a script that the test then replaces. */
async function openSession(url, cookie, work) {
  const first = await api(url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'start', folder: work, new: true }) })
  assert.equal(first.status, 200, first.text)
  const session = /session-[0-9a-f-]{36}/.exec(first.text)?.[0]
  assert.ok(session, `the turn named its session\n${first.text.slice(0, 400)}`)
  return session
}

test('Stop stops a running goal round, pauses the goal, and no further round starts (#93)', { timeout: 90_000 }, async () => {
  const home = isolatedHome('goal-stop')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const session = await openSession(url, cookie, work)
    writeFileSync(script, JSON.stringify({ steps: SLOW_ROUND }))

    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'write numbers, never complete', max_goal_rounds: 4 }),
    })
    assert.equal(created.status, 200, created.text)

    // Round 1 is running its six-second tool call; stop the session the way the page's Stop does.
    await waitFor(async () => (goalRounds(await events(url, cookie, session)).length >= 1 ? true : undefined), 20_000, 'round 1 to start')
    await sleep(1_000)
    const stop = await api(url, cookie, `/api/sessions/${session}/stop`, { method: 'POST', body: '{}' })
    assert.equal(stop.status, 200, stop.text)
    assert.ok(stop.body.stopped >= 1, `the stop route stopped the running goal round\nsaw: ${stop.text}`)

    const settled = await waitFor(
      async () => {
        const goal = (await api(url, cookie, `/api/goal?session=${session}`)).body.goal
        return goal !== undefined && goal.phase !== 'active' ? goal : undefined
      },
      15_000,
      'the goal to stop being active',
    )
    assert.equal(settled.phase, 'paused', 'a goal whose round was under way is paused')
    assert.equal(settled.activation, 'disarmed')

    // Longer than a round would take: nothing starts on its own.
    await sleep(8_000)
    const log = await events(url, cookie, session)
    assert.deepEqual(goalRounds(log).map((source) => source.round), [1], 'one round, not cap-many')
    const ended = log.filter((event) => event.type === 'assistant/completed').at(-1)
    const closing = log.filter((event) => event.type === 'turn/completed').at(-1)
    assert.ok(
      closing?.stopped === true || (ended?.ended ?? []).includes('stopped by the caller'),
      `the round is recorded as stopped\nsaw: ${JSON.stringify({ ended, closing })}`,
    )
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})

test('a failed goal round does not retry on its own: one round, and the goal waits disarmed for a person', { timeout: 90_000 }, async () => {
  const home = isolatedHome('goal-fail')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const session = await openSession(url, cookie, work)
    writeFileSync(script, JSON.stringify({ steps: FAILING }))

    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'keep going', max_goal_rounds: 4 }),
    })
    assert.equal(created.status, 200, created.text)

    await waitFor(async () => (goalRounds(await events(url, cookie, session)).length >= 1 ? true : undefined), 20_000, 'round 1 to start')
    await waitFor(
      async () => ((await events(url, cookie, session)).some((event) => event.type === 'turn/completed' && event.error !== undefined) ? true : undefined),
      20_000,
      'round 1 to fail',
    )
    await sleep(6_000)
    const rounds = goalRounds(await events(url, cookie, session))
    assert.deepEqual(rounds.map((source) => source.round), [1], `a failed round starts no other round\nsaw rounds ${JSON.stringify(rounds)}`)
    const goal = (await api(url, cookie, `/api/goal?session=${session}`)).body.goal
    assert.equal(goal.phase, 'active', 'a failure is not a block: the goal keeps its phase')
    assert.equal(goal.activation, 'disarmed', 'and waits for a person to resume it')
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})

test('a goal round cut at the output limit ends the chain: one round, and the goal waits disarmed', { timeout: 90_000 }, async () => {
  const home = isolatedHome('goal-cut')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const session = await openSession(url, cookie, work)
    writeFileSync(script, JSON.stringify({ steps: CUT_SHORT }))

    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'keep going', max_goal_rounds: 4 }),
    })
    assert.equal(created.status, 200, created.text)

    await waitFor(async () => (goalRounds(await events(url, cookie, session)).length >= 1 ? true : undefined), 20_000, 'round 1 to start')
    await sleep(5_000)
    const log = await events(url, cookie, session)
    const rounds = goalRounds(log)
    assert.deepEqual(rounds.map((source) => source.round), [1], `a round cut at the output limit starts no other round\nsaw rounds ${JSON.stringify(rounds)}`)
    const cut = log.filter((event) => event.type === 'assistant/completed').at(-1)
    assert.equal(cut?.finishReason, 'max_output_tokens', `the round was cut at the output limit\nsaw: ${JSON.stringify(cut)}`)
    const goal = (await api(url, cookie, `/api/goal?session=${session}`)).body.goal
    assert.equal(goal.phase, 'active')
    assert.equal(goal.activation, 'disarmed')
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})
