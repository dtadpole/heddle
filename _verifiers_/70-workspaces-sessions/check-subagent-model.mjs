import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A subagent's session, a teammate's included, offers no model choice (issue #175).
 *
 * DSH registers its `model` command with `available: (session) => sessions.subagentAddress(session.sessionId) ===
 * void 0`, and its options and onSelect throw "model selection is unavailable for addressed subagent sessions"
 * (dsh-client-ui-model-selection). Its server's selectModel resolves the agent first, which answers
 * `session/agent-busy` for a session subagent routing owns. A child's model and effort come from its delegation.
 * heddle let a person switch a teammate's model from its page, and the server recorded it, so the Lead's later
 * messages ran the teammate on that model.
 *
 * The store holds a Lead, its teammate and a plain session, on a run with two endpoints. The teammate's model switch
 * is refused with `session/agent-busy`, and a turn into it that names the other endpoint runs on its own. (The page's
 * seat follows `SessionRules.modelSelectable`, judged in test/session-model-seat.test.ts.)
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

async function setup(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(`${label}-work`)
  mkdirSync(work, { recursive: true })
  const script = join(home, 'script.json')
  writeFileSync(script, JSON.stringify({ steps: Array.from({ length: 8 }, () => ({ text: 'answered' })) }))
  const config = join(home, 'heddle.json')
  writeFileSync(
    config,
    `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' }, { name: 'other', kind: 'scripted', baseUrl: script, model: 'other-model' }] }, null, 2)}\n`,
  )
  const root = join(home, 'sessions')
  const { SessionStore } = await import('../../src/session/store.ts')
  const { TEAM_EVENT_VERSION: version } = await import('../../src/team/state.ts')
  const store = new SessionStore(root)
  const lead = store.create({ cwd: work, title: 'the Lead', endpoint: 'scripted' })
  store.message(lead, { role: 'user', content: [{ type: 'text', text: 'lead the team' }] })
  store.append(lead, { type: 'assistant/completed', text: 'noted' })
  const mate = store.create({ cwd: work, title: 'teammate scout', endpoint: 'scripted', parentSession: lead.id, origin: 'subagent', delegationDepth: 1, teamId: lead.id })
  store.append(lead, { type: 'team/member', version, teamId: lead.id, member: { id: mate.id, name: 'scout', description: 'the teammate', context: 'fresh', phase: 'active' } })
  const plain = store.create({ cwd: work, title: 'a plain session', endpoint: 'scripted' })
  store.message(plain, { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  store.append(plain, { type: 'assistant/completed', text: 'hi' })
  for (const handle of [lead, mate, plain]) store.release(handle)
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  const cookie = await cookieFor(server.url)
  await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
  const metaOf = async (id) => ((await api(server.url, cookie, '/api/sessions')).body ?? []).find((meta) => meta.id === id)
  return {
    server,
    cookie,
    work,
    lead,
    mate,
    plain,
    metaOf,
    close: () => {
      server.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

test('#175: a teammate’s model switch is refused as session/agent-busy, and a turn into it keeps its own endpoint', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const s = await setup('subagent-model-api')
  try {
    const switched = await api(s.server.url, s.cookie, `/api/sessions/${encodeURIComponent(s.mate.id)}/model`, { method: 'POST', body: JSON.stringify({ endpoint: 'other' }) })
    assert.equal(switched.status, 409, `the switch is refused\nsaw: ${switched.status} ${JSON.stringify(switched.body)}`)
    assert.equal(switched.body.code, 'session/agent-busy')
    assert.equal((await s.metaOf(s.mate.id))?.endpoint, 'scripted', 'and nothing was recorded')
    const plain = await api(s.server.url, s.cookie, `/api/sessions/${encodeURIComponent(s.plain.id)}/model`, { method: 'POST', body: JSON.stringify({ endpoint: 'other' }) })
    assert.equal(plain.status, 200, `a plain session still switches (${JSON.stringify(plain.body)})`)

    const turn = await fetch(new URL('/api/turn', s.server.url), {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: s.mate.id, prompt: 'a person writes to the teammate', endpoint: 'other', model: 'other-model' }),
    })
    assert.equal(turn.status, 200, 'the turn into the teammate ran')
    await turn.text()
    const meta = await s.metaOf(s.mate.id)
    assert.equal(meta?.endpoint, 'scripted', `the teammate keeps its own endpoint\nmeta: ${JSON.stringify(meta)}`)
    assert.notEqual(meta?.model, 'other-model', 'and model')

    // #239 beside #175: a model its endpoint does not offer is not judged for a teammate, since the teammate does not
    // run on it. The turn runs on the teammate's own model, with no 400, and nothing is recorded.
    const unoffered = await fetch(new URL('/api/turn', s.server.url), {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: s.mate.id, prompt: 'another message for the teammate', model: 'a-model-nobody-offers' }),
    })
    const answer = await unoffered.text()
    assert.equal(unoffered.status, 200, `a turn naming an unoffered model runs on the teammate's own\n${answer.slice(0, 300)}`)
    const after = await s.metaOf(s.mate.id)
    assert.equal(after?.endpoint, 'scripted', 'the teammate keeps its endpoint')
    assert.notEqual(after?.model, 'a-model-nobody-offers', 'and records no model it was not going to use')
  } finally {
    s.close()
  }
})
