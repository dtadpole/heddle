import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A goal's round cap holds when the goal is edited during a round (R-developer-two-31, DSH parity S131).
 *
 * DSH's `dsh-goal` fold counts rounds for the goal, across revisions: every goal change carries `roundsStarted`
 * forward unchanged, and each goal-sourced user message must be round `roundsStarted + 1` of the revision current
 * at that point. So `max_goal_rounds: 3` means three rounds in total. Measured on both builds before the fix: an
 * edit landing during round 2 gave five rounds, labelled 1/3, 2/3, 3/3, 3/3, 3/3, before the round-limit block.
 *
 * The check drives a real `heddle web` (the TypeScript build, or the binary through `HEDDLE_BIN`) on the offline
 * scripted endpoint. Every round runs a two-second `sleep` so the edit lands while round 2 is still running, then
 * the check reads the session log the server wrote.
 */

const CAP = 3
/** One round: a tool call that takes long enough for an edit to land in it, then an answer. */
const ROUND_STEPS = [{ toolCall: { name: 'bash', arguments: { command: 'sleep 2' } } }, { text: 'round done' }]

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

/** The session's events, read through the server that wrote them. */
async function events(url, cookie, session) {
  const { text } = await api(url, cookie, `/api/sessions/${session}/log`)
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** The goal rounds the log holds, in order: the user messages whose source is the goal. */
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

test('an edit during a goal round does not let the goal run past its cap', { timeout: 90_000 }, async () => {
  const home = isolatedHome('goal-rounds')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: ROUND_STEPS })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)

    // A session to hold the goal: one ordinary turn, which also proves the slow script runs.
    const first = await api(url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'start', folder: work, new: true }) })
    assert.equal(first.status, 200, first.text)
    const session = /session-[0-9a-f-]{36}/.exec(first.text)?.[0]
    assert.ok(session, `the turn named its session\n${first.text.slice(0, 400)}`)

    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'three rounds at most', max_goal_rounds: CAP }),
    })
    assert.equal(created.status, 200, created.text)
    assert.equal(created.body.goal.phase, 'active')

    // Edit the objective as soon as round 2 has started, while its sleep is still running.
    await waitFor(async () => (goalRounds(await events(url, cookie, session)).some((source) => source.round === 2) ? true : undefined), 30_000, 'round 2 to start')
    const current = (await api(url, cookie, `/api/goal?session=${session}`)).body.goal
    const edited = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'edit', goal_id: current.id, revision: current.revision, objective: 'three rounds at most, sharper' }),
    })
    assert.equal(edited.status, 200, edited.text)

    const settled = await waitFor(
      async () => {
        const goal = (await api(url, cookie, `/api/goal?session=${session}`)).body.goal
        return goal !== undefined && goal.phase !== 'active' ? goal : undefined
      },
      60_000,
      'the goal to stop being active',
    )

    const all = await events(url, cookie, session)
    const rounds = goalRounds(all)
    assert.deepEqual(
      rounds.map((source) => source.round),
      [1, 2, 3],
      `a cap of ${CAP} allows ${CAP} rounds in total, edit or not; the log held rounds ${JSON.stringify(rounds)}`,
    )
    assert.equal(settled.phase, 'blocked')
    assert.equal(settled.blockedReason?.code ?? settled.blocked_reason?.code, 'round-limit')
    assert.equal(settled.roundsStarted ?? settled.rounds_started, CAP)
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})
