import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { endChild, fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A fresh teammate runs at its Lead's reasoning effort (issue #174).
 *
 * DSH's child inherits the parent's provider, model and reasoning effort (dsh-subagent `resolveChildAgentOptions` /
 * `parentAgentOptionsForDelegation`). Teammates are continuable children and go the same way. heddle's fresh teammate
 * took the Lead's endpoint and model but not its effort, on both builds. So a Lead at low spawned a teammate at the
 * model's own default (high for DeepSeek flash). A `fork` teammate already took it, through the store's fork.
 *
 * The Lead's session is born at effort `low` through the turn route; its scripted turn spawns a fresh teammate; the
 * teammate's session must record `low`, and its model request must carry it.
 */

const CAPABILITY = 'a turn with tools, served by the Web UI'

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
      // A harness that exited before printing its URL has already emitted 'exit', and the event is not replayed:
      // waiting for it would hang the check instead of letting it report that the server did not start.
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
  return { status: response.status, body }
}

const metaOf = (root, id) => JSON.parse(readFileSync(join(dirname(transcriptFile(join(root, id))), `${id}.json`), 'utf8'))
// Both builds write a session's metadata in place (truncate, then write), so a poll can catch the file empty or
// half-written; measured in lane runs as "Unexpected end of JSON input" thrown out of the wait below. While polling, an
// unreadable file means "not yet", never a verdict.
const metaWhenReadable = (root, id) => {
  try {
    return metaOf(root, id)
  } catch {
    return undefined
  }
}
async function waitFor(read, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('#174: a fresh teammate records its Lead\'s reasoning effort and its model request carries it', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test((await import('node:child_process')).execFileSync(...heddleCommand(['--help']), { encoding: 'utf8' })), CAPABILITY)) return
  const home = isolatedHome('teammate-effort')
  const work = fixtureDir('teammate-effort-work')
  const root = join(home, 'sessions')
  const steps = [
    { toolCall: { name: 'spawn_teammate', arguments: { name: 'scout', description: 'the teammate', prompt: 'Reply with only: TEAM-174' } } },
    { text: 'the Lead is done' },
    { purpose: 'team', text: 'TEAM-174' },
  ]
  const { config, script } = scriptedConfig({ home, steps })
  // A model that declares levels, default high (as DeepSeek flash does), so an effort the Lead records is sent, and a
  // teammate that took none would run at high.
  writeFileSync(config, `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted', reasoning: { default: 'high', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] } }] }, null, 2)}\n`)
  // The Lead is written at effort low before the server starts, as a session whose person chose low.
  const { SessionStore } = await import('../../src/session/store.ts')
  const store = new SessionStore(root)
  const leadHandle = store.create({ cwd: work, endpoint: 'scripted', reasoningEffort: 'low', title: 'the Lead' })
  store.release(leadHandle)
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const turn = await fetch(new URL('/api/turn', url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Lead: spawn a scout', folder: work, session: leadHandle.id }),
    })
    const answer = await turn.text()
    assert.equal(turn.status, 200, `the Lead turn ran\n${answer.slice(0, 400)}`)
    const lead = leadHandle.id
    assert.equal(metaOf(root, lead).reasoningEffort, 'low', 'the Lead is at low')
    const childId = await waitFor(() => sessionsUnder(root).find((id) => id !== lead && metaWhenReadable(root, id)?.teamId === lead), 15_000, 'the teammate session')
    const child = await waitFor(() => metaWhenReadable(root, childId), 5_000, 'the teammate metadata, readable')
    assert.equal(child.endpoint, metaOf(root, lead).endpoint, 'the teammate takes the Lead\'s endpoint')
    assert.equal(child.reasoningEffort, 'low', `the teammate runs at the Lead's effort, not the model's default\nmeta: ${JSON.stringify(child)}`)
    const request = await waitFor(() => {
      try {
        return readTranscript(join(root, childId)).find((event) => event.type === 'model/request')
      } catch {
        return undefined
      }
    }, 15_000, "the teammate's model request")
    const leadRequest = readTranscript(join(root, lead)).find((event) => event.type === 'model/request')
    const effortOf = (event) => event?.reasoningEffort ?? event?.request?.reasoningEffort ?? event?.options?.reasoningEffort
    assert.equal(effortOf(leadRequest), 'low', `the Lead's own request carries low\n${JSON.stringify(leadRequest).slice(0, 400)}`)
    assert.equal(effortOf(request), 'low', `and so does the teammate's\n${JSON.stringify(request).slice(0, 400)}`)
  } finally {
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})
