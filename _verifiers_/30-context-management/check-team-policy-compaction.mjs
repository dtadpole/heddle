import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A team Lead keeps the Agent Teams policy across a compaction (issue #185).
 *
 * DSH injects the team policy into every member's system prompt, which compaction never shadows ("Every selected
 * range starts at the first surface node that is not a system/message", dsh-compaction-basic). heddle writes the
 * policy once as a durable `context/note` (origin `team-policy`) and checked "any such note in the whole log", so a
 * `/compact` that folded the note left the Lead without the team rules for good, on both builds.
 *
 * A Lead session is written with a teammate, the policy note and four turns. `/compact` folds the note. The Lead's
 * next model request must still carry the policy, because the note is written again after the compaction.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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
  })
}

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const POLICY_PROBE = 'Write-scope overlap is advisory, not a lock.'

/** A Chat Completions double that answers everything at once and keeps every request body. */
async function double() {
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      requests.push(raw)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = raw.includes('Create a concise title') ? 'A title' : 'a short answer'
      for (const frame of [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}

test('#185: a Lead’s next request after /compact still carries the Agent Teams policy', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('team-policy-compaction')
  const work = fixtureDir('team-policy-compaction-work')
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const root = join(home, 'sessions')
  const { SessionStore } = await import('../../src/session/store.ts')
  const { TEAM_POLICY, TEAM_POLICY_NOTE_ORIGIN } = await import('../../src/team/policy.ts')
  const { TEAM_EVENT_VERSION: version } = await import('../../src/team/state.ts')
  assert.ok(TEAM_POLICY.includes(POLICY_PROBE), 'the probe is a sentence of the policy')
  const store = new SessionStore(root)
  const lead = store.create({ cwd: work, title: 'the Lead' })
  const turn = (text) => {
    store.message(lead, { role: 'user', content: [{ type: 'text', text: `${text} ${'background detail '.repeat(40)}` }] })
    store.append(lead, { type: 'assistant/completed', text: `noted: ${text}` })
    store.append(lead, { type: 'turn/completed', rounds: 1 })
  }
  turn('first, build the team')
  const member = store.create({ cwd: work, title: 'teammate alpha', parentSession: lead.id, origin: 'subagent', delegationDepth: 1, teamId: lead.id })
  store.append(lead, { type: 'team/member', version, teamId: lead.id, member: { id: member.id, name: 'alpha', description: 'the teammate', context: 'fresh', phase: 'active' } })
  store.append(lead, { type: 'context/note', message: { role: 'system', content: [{ type: 'text', text: TEAM_POLICY }] }, origin: TEAM_POLICY_NOTE_ORIGIN })
  turn('second')
  turn('third')
  turn('fourth')
  for (const handle of [lead, member]) store.release(handle)
  const noteSeq = readTranscript(join(root, lead.id)).find((event) => event.origin === TEAM_POLICY_NOTE_ORIGIN).seq

  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const compacted = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(lead.id)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
    assert.equal(compacted.status, 200, `/compact answered (${JSON.stringify(compacted.body)})`)
    const log = readTranscript(join(root, lead.id))
    const start = log.find((event) => event.type === 'compaction/start')
    assert.ok(start !== undefined && log.some((event) => event.type === 'compaction/end'), `the compaction landed\n${log.map((event) => event.type).join(' ')}`)
    assert.ok((start.shadowedSeqs ?? []).includes(noteSeq), `the compaction folded the policy note (seq ${noteSeq})\nshadowed: ${JSON.stringify(start.shadowedSeqs)}`)

    const asked = provider.requests.length
    const probe = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a probe after the compaction', folder: work, session: lead.id }),
    })
    assert.equal(probe.status, 200, 'the probe turn ran')
    await probe.text()
    const request = provider.requests.slice(asked).find((one) => one.includes('a probe after the compaction'))
    assert.ok(request !== undefined, 'the probe reached the model')
    assert.ok(request.includes(POLICY_PROBE), 'and the Lead’s request still carries the Agent Teams policy')
  } finally {
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
