import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A goal round that fails starts no next round (DSH's dsh-goal-round-driver).
 *
 * DSH: "The driver also stops on its own when a turn ends on max tokens, a durability write fails, or the agent is
 * cancelled"; "Cancellation never auto-restarts a round"; "No abnormal auto-retry — transient provider and
 * persistence failures require a later human-authorized resume rather than an implicit retry policy".
 *
 * Since d9443684 every failed or stopped turn writes `turn/completed` (with `error` or `stopped`), and heddle's
 * goal driver requests a pass on every `turn/completed`. Measured before the guard (developer-six, and this check
 * on main): a provider that fails every call chained the goal's rounds up to its cap. The chain itself stops on a
 * failed round ('turn-failed'), but the failed turn's completion started a new chain.
 *
 * The check drives a real `heddle web` (the TypeScript build, or the binary through `HEDDLE_BIN`) on the offline
 * scripted endpoint. One ordinary turn opens the session; then the script is rewritten so every call fails, a goal
 * with a cap of three is created, and the log must hold round 1 only. (A Stop of a goal round needs #93 first: Stop
 * does not reach the driver's rounds yet. A round cut on `length`, where DSH also stops, continues inside the
 * driver's own chain and is a separate change.)
 */

const CAP = 3

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


async function oneRoundOnly(label, steps) {
  const home = isolatedHome(`goal-abnormal-${label}`)
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const first = await api(url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'start', folder: work, new: true }) })
    assert.equal(first.status, 200, first.text)
    const session = /session-[0-9a-f-]{36}/.exec(first.text)?.[0]
    assert.ok(session, `the turn named its session\n${first.text.slice(0, 400)}`)

    // From here on, every model call of a turn answers as `steps` says (the file is read on every call).
    writeJson(script, { steps })
    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: `${label}: three rounds at most`, max_goal_rounds: CAP }),
    })
    assert.equal(created.status, 200, created.text)

    // Round 1 runs and ends (abnormally). Then a driver that chains would start round 2 within milliseconds.
    await waitFor(
      async () => {
        const log = await events(url, cookie, session)
        const at = log.findIndex((event) => event.type === 'message' && event.message?.source?.kind === 'goal')
        return at !== -1 && log.slice(at).some((event) => event.type === 'turn/completed') ? true : undefined
      },
      30_000,
      'goal round 1 to end',
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const log = await events(url, cookie, session)
    const rounds = goalRounds(log).map((source) => source.round)
    const closed = log.filter((event) => event.type === 'turn/completed').map((event) => ({ ...event, seq: undefined, time: undefined }))
    assert.deepEqual(rounds, [1], `an abnormal end starts no next round (DSH: no abnormal auto-retry); the log held rounds ${JSON.stringify(rounds)}; turn ends ${JSON.stringify(closed)}`)
    return log
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
}

test('a goal round whose model call fails starts no next round', { timeout: 90_000 }, async () => {
  const log = await oneRoundOnly('failed', [{ error: { message: 'the provider is down' } }])
  const ended = log.filter((event) => event.type === 'turn/completed').at(-1)
  assert.ok(ended?.error !== undefined, `the round ended with an error in its turn/completed: ${JSON.stringify(ended)}`)
})
