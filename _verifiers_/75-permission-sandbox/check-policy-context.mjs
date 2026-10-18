import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8, the model-context half — the standing file policy is **told** to the model, not only enforced.
 *
 * DSH contributes a `sandbox:policy` runtime-context snapshot before each request. Without it the model learns
 * the policy from a denial, which is a wasted round and a confusing lesson; heddle now writes the same statement
 * as one durable `context/note` that is replaced when the mode changes. This check judges it end to end: a real
 * server, a local chat double, and the request bodies the double actually received.
 *
 * It also judges the other half of the claim: the note is the harness's, not the person's — the Web UI's
 * transcript must not show it as a user turn.
 */

const CAPABILITY = 'a model told the session’s file policy'

/** Spawn `heddle web` on an ephemeral port and resolve once it prints its URL. */
function startWeb(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'dist', 'cli.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(env.HEDDLE_HOME, 'sessions')],
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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
  })
}

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** The session id from a turn's SSE body. */
function sessionOf(text) {
  for (const block of text.split('\n\n')) {
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (data === undefined) continue
    try {
      const payload = JSON.parse(data)
      if (typeof payload.session === 'string') return payload.session
    } catch {
      // not one of the turn's events
    }
  }
  return undefined
}

async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted\n${text.slice(0, 300)}`)
  return sessionOf(text)
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /--profile/.test(help.stdout)
}

test('the model reads the standing policy in its request, and the note is not a person’s turn', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('policy-context')
  const work = fixtureDir('policy-context-work')
  const double = await chatDouble({ content: 'ok' })
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  const server = await startWeb({ HEDDLE_HOME: home, HEDDLE_CONFIG: config })
  try {
    const session = await turn(server, { prompt: 'first turn' })
    assert.ok(typeof session === 'string' && session.length > 0, 'the turn named its session')

    const bodies = () => double.requests.map((entry) => entry.body)
    const shared = bodies().filter((body) => body.includes('Current heddle file policy: workspace-write'))
    assert.equal(shared.length, 1, `the workspace-write policy is in the request the model received\nsaw ${bodies().length} request(s)`)
    assert.ok(shared[0].includes(repoRoot), 'and names the session workspace the mode promises')
    assert.equal(
      bodies().filter((body) => body.includes('Current heddle file policy:')).length,
      1,
      'one policy statement per request, not a pile of them',
    )

    /** The note is the harness's: the transcript must not render it as something the person typed. */
    const history = await request(server, `/api/sessions/${encodeURIComponent(session)}`).then((response) => response.json())
    assert.ok(
      !(history.turns ?? []).some((entry) => String(entry.text ?? '').includes('Current heddle file policy:')),
      'the policy note is not drawn as a conversation turn',
    )

    /** A change of mode is a change of statement: the next request carries the new one, once. */
    const changed = await request(server, `/api/sessions/${encodeURIComponent(session)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'read-only' }),
    })
    assert.equal(changed.status, 200, 'the session can be narrowed')
    await turn(server, { session, prompt: 'second turn' })
    const readOnly = bodies().filter((body) => body.includes('Current heddle file policy: read-only'))
    assert.equal(readOnly.length, 1, 'the next request carries the read-only policy')
    assert.ok(
      !readOnly[0].includes('Current heddle file policy: workspace-write'),
      'and not the previous one beside it',
    )
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})
