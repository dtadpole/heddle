import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { endChild, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A goal round starts only after the session's working subagents settle (inventory A9).
 *
 * DSH's round driver awaits `subagents.waitForChildren(agent)` before it reserves the next round
 * (dsh-goal-round-driver lib/index.js:130-134; README "When continuation stops": "A round starts only at whole-agent
 * idle and, when the subagent service is loaded, only after the agent's progressing descendants settle"). heddle's
 * driver started the next round the moment a round's turn ended, while a child the round had delegated was still
 * working, on both builds.
 *
 * Each round delegates a child that runs `sleep 4`; the goal has two rounds. Round 2's prompt must be written after
 * round 1's child has finished its turn.
 */

const ROUND = [{ toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } }, { text: 'round done' }]
const CHILD = [
  { purpose: 'subagent', toolCall: { name: 'bash', arguments: { command: 'sleep 4; echo child-worked' } } },
  { purpose: 'subagent', text: 'child answer' },
]
const NOTICE = [{ purpose: 'subagent-notice', text: 'parent read the notice' }]

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
      // Bounded: SIGTERM, then SIGKILL after 5 s, so a harness slow to exit fails the check by name, not by the lane's limit.
      await endChild(child)
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

test('a goal round waits for the child its previous round delegated to finish (A9)', { timeout: 120_000 }, async () => {
  const home = isolatedHome('goal-waits-children')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const session = await openSession(url, cookie, work)
    writeFileSync(script, JSON.stringify({ steps: [...ROUND, ...CHILD, ...NOTICE] }))

    const created = await api(url, cookie, '/api/goal', {
      method: 'POST',
      body: JSON.stringify({ session, action: 'create', objective: 'delegate a child each round, never complete', max_goal_rounds: 2 }),
    })
    assert.equal(created.status, 200, created.text)

    const rounds = await waitFor(
      async () => {
        const found = (await events(url, cookie, session)).filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'goal')
        return found.length >= 2 ? found : undefined
      },
      60_000,
      'two goal rounds',
    )
    const listed = (await api(url, cookie, '/api/sessions')).body
    const children = (Array.isArray(listed) ? listed : [])
      .filter((meta) => meta.parentSession === session && meta.origin === 'subagent')
      .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
    assert.ok(children.length >= 1, 'round 1 delegated a child')
    const first = children[0].id
    const childEnd = await waitFor(
      async () => (await events(url, cookie, first)).find((event) => event.type === 'turn/completed' || event.type === 'turn/failed'),
      30_000,
      "the first child's turn to end",
    )
    const round2At = Date.parse(rounds[1].at)
    const childEndAt = Date.parse(childEnd.at)
    assert.ok(
      round2At >= childEndAt,
      `round 2 began only after round 1's child finished\nround 2 prompt at ${rounds[1].at}; the child's turn ended at ${childEnd.at}`,
    )
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})
