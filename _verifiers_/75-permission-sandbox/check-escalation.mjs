import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless, tempDir } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8, the escalation half — one approved wider retry, and nothing more.
 *
 * A denied call may be retried once at a strictly wider mode with a one-sentence justification, and the retry is
 * approved by a person **before** it executes. This file judges that on the delivered harness, without a browser:
 * a real server, a scripted endpoint, the approval question over `GET /api/approvals`, and the answer over
 * `POST /api/approvals/<id>`.
 *
 * Three outcomes are measured: an approved retry runs the one call and leaves the session's own mode where it was;
 * a rejected retry leaves the effect undone; and a run with no one to answer (the CLI) is refused with the sentence
 * that says so, rather than waiting or silently widening.
 */

const CAPABILITY = 'a one-call escalation approved by a person'

/** A profile whose sandbox row carries the deployment mode and root. */
function profile(home, options) {
  const dir = fixtureDir('escalation-profile')
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: console
      name: ${prefix}/src/plugins/console-exporter.ts
    - id: session
      name: ${prefix}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${prefix}/src/plugins/model.ts
    - id: context
      name: ${prefix}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 200000
    - id: sandbox
      name: ${prefix}/src/sandbox/service.ts
      config:
        mode: ${options.mode}
        workspaceRoot: ${options.workspace}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [write_file, read_file, list_dir, bash]
`,
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'script.json'), `${JSON.stringify({ steps: options.steps })}\n`)
  writeFileSync(
    join(home, 'heddle.json'),
    `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(dir, 'script.json'), model: 'scripted' }] }, null, 2)}\n`,
  )
  return dir
}

/** One fixture: read-only deployment, a workspace, and the retry script. */
function harness(label) {
  const home = fixtureDir(`escalation-home-${label}`)
  const workspace = fixtureDir(`escalation-workspace-${label}`)
  const outsideDir = tempDir(`escalation-outside-${label}-`)
  const steps = [
    { toolCall: { name: 'write_file', arguments: { path: 'escalated.txt', content: 'x' } } },
    {
      toolCall: {
        name: 'write_file',
        arguments: { path: 'escalated.txt', content: 'x', sandbox_permissions: 'workspace-write', justification: 'the session started read-only and this file is inside its workspace' },
      },
    },
    { text: 'done' },
  ]
  return { home, workspace, outsideDir, profileDir: profile(home, { mode: 'read-only', workspace, steps }), env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') } }
}

function startWeb(h) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'dist', 'cli.js'), 'web', '--host', '127.0.0.1', '--port', '0', '--profile', h.profileDir, '--endpoint', 'scripted'],
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...h.env }, stdio: ['ignore', 'pipe', 'pipe'] },
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

/** Poll the pending-approval route until a question appears (the turn is blocked while it waits). */
async function waitForApproval(server, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const body = await request(server, '/api/approvals').then((response) => response.json())
    const pending = (body.requests ?? [])[0]
    if (pending !== undefined) return pending
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the escalation never asked for approval')
}

/** Post a turn without awaiting it, so the question can be answered while it waits. */
function startTurn(server, body) {
  return request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) }).then((response) => response.text())
}

/** The tool results a session recorded, in order. */
function resultsOf(home) {
  const session = sessionsUnder(join(home, 'sessions'))[0]
  assert.ok(session !== undefined, 'the turn created a session')
  return readTranscript(join(home, 'sessions', session))
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
}

async function sessionMode(server, id) {
  const body = await request(server, `/api/sessions/${encodeURIComponent(id)}`).then((response) => response.json())
  return body.permission?.mode
}

async function withHarness(label, body) {
  const h = harness(label)
  let server
  try {
    server = await startWeb(h)
    await body(h, server)
  } finally {
    if (server !== undefined) server.kill()
    removeDir(h.home)
    removeDir(h.workspace)
    removeDir(h.outsideDir)
  }
}

test('an approved retry runs the one denied call under the wider mode, and the session stays read-only', async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness('approved', async (h, server) => {
    const turn = startTurn(server, { prompt: 'write inside' })
    const pending = await waitForApproval(server)
    assert.match(pending.displayReason ?? '', /workspace-write/, 'the question names the mode being requested')
    assert.match(pending.displayReason ?? '', /inside its workspace/, 'and carries the model’s justification verbatim')

    const answered = await request(server, `/api/approvals/${encodeURIComponent(pending.id)}`, {
      method: 'POST',
      body: JSON.stringify({ outcome: 'allowed-once' }),
    })
    assert.equal(answered.status, 200, 'the answer is accepted')
    const text = await turn
    assert.equal(sessionsUnder(join(h.home, 'sessions')).length, 1, 'the turn finished')

    assert.equal(existsSync(join(h.workspace, 'escalated.txt')), true, `the approved retry wrote the file\n${text.slice(0, 300)}`)
    const results = resultsOf(h.home)
    assert.ok(results.some((result) => /wrote/.test(result)), `the retry's result says it wrote\nsaw: ${results.join(' | ').slice(0, 300)}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.equal(await sessionMode(server, session), 'read-only', 'the session’s own mode never moved')
  })
})

test('a rejected retry leaves the effect undone', async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness('rejected', async (h, server) => {
    const turn = startTurn(server, { prompt: 'write inside' })
    const pending = await waitForApproval(server)
    await request(server, `/api/approvals/${encodeURIComponent(pending.id)}`, { method: 'POST', body: JSON.stringify({ outcome: 'rejected' }) })
    await turn

    assert.equal(existsSync(join(h.workspace, 'escalated.txt')), false, 'the rejected retry wrote nothing')
    const results = resultsOf(h.home)
    assert.ok(
      results.some((result) => /rejected/.test(result)),
      `and the call's result says the ask was rejected\nsaw: ${results.join(' | ').slice(0, 400)}`,
    )
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.equal(await sessionMode(server, session), 'read-only', 'the mode is where it was')
  })
})

test('a run with no one to answer refuses the escalation instead of waiting or widening', async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  const h = harness('unattended')
  try {
    const run = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'write inside'], { env: h.env, timeoutMs: 60_000 })
    assert.equal(existsSync(join(h.workspace, 'escalated.txt')), false, 'nothing was written')
    const results = resultsOf(h.home)
    assert.ok(
      results.some((result) => /no one can approve/i.test(result)),
      `the call says no one could approve it\nsaw: ${results.join(' | ').slice(0, 400)}\n${run.stdout.slice(-300)}`,
    )
  } finally {
    removeDir(h.home)
    removeDir(h.workspace)
    removeDir(h.outsideDir)
  }
})
