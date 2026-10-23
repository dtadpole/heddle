import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, harnessEntry, heddleCommand, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless, tempDir } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8, the session-scoped half — the access mode a session carries and every tool call is gated by.
 *
 * The three-mode claims in `check.mjs` are judged under three **profiles**: the mode is fixed when the
 * service is constructed. What this file judges is the mechanism a person now uses: one session starts under
 * the deployment mode, the owner changes that session's mode through the HTTP API, and the same scripted
 * action is refused or permitted according to the session it belongs to — not according to the process.
 *
 * It is also where the security rule is judged by **refusal rather than by declaration**:
 *
 * - a session's mode overrides the deployment mode for that session, and for no other;
 * - an escalation to full access is refused by the server unless it carries the explicit confirmation, so a
 *   script or a stale page cannot widen access by accident;
 * - a mode outside the vocabulary is refused;
 * - the mode is one appended event and the API is its only writer — a tool call records none;
 * - a read-only session refuses a write; whether its shell runs confined or is refused is the
 *   shell-confinement check's claim, so this file does not repeat it.
 *
 * No browser: the API and a scripted endpoint are enough to judge enforcement, and the control itself is
 * judged in `_verifiers_/80-web-ui/check-access.mjs`.
 */

const CAPABILITY = 'a permission sandbox whose modes are per session'

/** A profile whose sandbox row carries the deployment mode and root, with the scripted endpoint wired. */
function sessionProfile(home, options) {
  const dir = fixtureDir('session-mode-profile')
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
        workspaceRoot: ${options.workspaceRoot}
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

/**
 * One fixture: an isolated home, a workspace, a profile, and the outside path a refusal is about.
 *
 * The outside path exists **before** the profile is written because the script has to name it.
 */
function harness(label, options) {
  const home = fixtureDir(`session-mode-home-${label}`)
  const workspace = fixtureDir(`session-mode-workspace-${label}`)
  const outsideDir = fixtureDir(`session-mode-outside-${label}`)
  const outsidePath = join(outsideDir, 'outside.txt')
  const steps = typeof options.steps === 'function' ? options.steps({ outsidePath }) : options.steps
  const profileDir = sessionProfile(home, { ...options, steps, workspaceRoot: workspace })
  return {
    home,
    workspace,
    outsidePath,
    outsideDir,
    profileDir,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') },
  }
}

/** Spawn `heddle web` on an ephemeral port and resolve once it prints its URL. */
function startWeb(profileDir, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--profile', profileDir, '--endpoint', 'scripted']),
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

/** The printed URL's token, attached to every API request the way the page's own cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
}

/** The SSE blocks a turn answered with, named and parsed. */
function sseBlocks(text) {
  const blocks = []
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (name === undefined || data === undefined) continue
    try {
      blocks.push({ name, data: JSON.parse(data) })
    } catch {
      // A block that is not JSON is not one of the turn's events.
    }
  }
  return blocks
}

/** Run one turn and answer with its session id and the text of every tool result the turn recorded. */
async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted\n${text.slice(0, 400)}`)
  const blocks = sseBlocks(text)
  const session = blocks.find((block) => block.name === 'session')?.data.session
  assert.ok(typeof session === 'string' && session.length > 0, 'the turn named the session it ran in')
  const results = blocks
    .filter((block) => block.name === 'session' && block.data.event?.type === 'message' && block.data.event.message?.role === 'tool')
    .map((block) => (block.data.event.message.content ?? []).map((part) => part.text ?? '').join(''))
  return { session, results }
}

/** The session as the page reads it — the record a reload comes back to. */
async function sessionOf(server, id) {
  const response = await request(server, `/api/sessions/${encodeURIComponent(id)}`)
  assert.equal(response.status, 200, 'the session is readable')
  return response.json()
}

/** Change a session's mode through the API, answering with the status and the parsed body. */
async function changeMode(server, id, body) {
  const response = await request(server, `/api/sessions/${encodeURIComponent(id)}/permission`, { method: 'POST', body: JSON.stringify(body) })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // A refusal may be plain text, and the check reports it verbatim either way.
  }
  return { status: response.status, body: parsed, text }
}

/** The `permission/mode` events a session's log holds, in order. */
function permissionEvents(home, session) {
  return readTranscript(join(home, 'sessions', session)).filter((event) => event.type === 'permission/mode')
}

/** Whether the built CLI and this profile are available to judge the claim at all. */
async function supportsSessionMode() {
  const help = await runCli(['--help'])
  return /^  web\b/m.test(help.stdout) && existsSync(harnessEntry())
}

async function withHarness(label, options, body) {
  const h = harness(label, options)
  let server
  try {
    server = await startWeb(h.profileDir, h.env)
    await body(h, server)
  } finally {
    if (server !== undefined) server.kill()
    removeDir(h.home)
    removeDir(h.workspace)
    removeDir(h.outsideDir)
  }
}

test('a session mode outranks the deployment mode, and one session does not change another', async (context) => {
  if (!skipUnless(context, await supportsSessionMode(), CAPABILITY)) return
  /**
   * The deployment mode is `read-only`, so the first turn's write and shell are refused without any session
   * event existing. Switching **that session** to `workspace-write` is the owner's action; the same scripted
   * steps must then succeed, and a second session started afterwards must still be refused.
   */
  await withHarness(
    'override',
    {
      mode: 'read-only',
      /**
       * A shell is not in this check: whether read-only's shell runs confined or is refused is the shell-confinement
       * check's claim (`check-shell-confinement.mjs`), and this file judges the session mode's write behaviour.
       */
      steps: [{ toolCall: { name: 'write_file', arguments: { path: 'inside.txt', content: 'inside' } } }, { text: 'done' }],
    },
    async (h, server) => {
      const first = await turn(server, { prompt: 'write inside' })
      assert.ok(
        first.results.some((text) => /read-only/.test(text)),
        `the read-only turn refused the write, naming the mode\nsaw: ${first.results.join(' | ').slice(0, 300)}`,
      )
      assert.equal(existsSync(join(h.workspace, 'inside.txt')), false, 'nothing landed under the deployment mode')
      assert.equal((await sessionOf(server, first.session)).permission?.mode, 'read-only', 'the session reports the deployment mode')

      const switched = await changeMode(server, first.session, { mode: 'workspace-write' })
      assert.equal(switched.status, 200, `the owner's change was accepted\n${switched.text.slice(0, 300)}`)
      assert.equal(switched.body?.mode, 'workspace-write', 'and the API answers with the new mode')
      assert.equal((await sessionOf(server, first.session)).permission?.mode, 'workspace-write', 'the session record carries it')

      const second = await turn(server, { session: first.session, prompt: 'write again' })
      assert.ok(
        second.results.some((text) => /wrote/.test(text)),
        `the write now lands under the session's own mode\nsaw: ${second.results.join(' | ').slice(0, 300)}`,
      )
      assert.equal(existsSync(join(h.workspace, 'inside.txt')), true, 'and the write the read-only turn refused landed')

      /** A session that never changed still runs under the deployment mode. */
      const neighbour = await turn(server, { prompt: 'a second session' })
      assert.notEqual(neighbour.session, first.session, 'a turn without a session starts another one')
      assert.equal((await sessionOf(server, neighbour.session)).permission?.mode, 'read-only', 'the neighbour never saw the change')

      /** One change is one event, and the only writer was the API — the tool calls recorded none. */
      assert.ok(sessionsUnder(join(h.home, 'sessions')).includes(first.session), 'the session has a log on disk')
      assert.deepEqual(
        permissionEvents(h.home, first.session).map((event) => event.mode),
        ['workspace-write'],
        'the API wrote the one permission event; no tool call did',
      )
    },
  )
})

test('an escalation to full access needs the explicit confirmation, and a refusal leaves the mode alone', async (context) => {
  if (!skipUnless(context, await supportsSessionMode(), CAPABILITY)) return
  await withHarness(
    'escalation',
    {
      mode: 'workspace-write',
      steps: ({ outsidePath }) => [
        { toolCall: { name: 'write_file', arguments: { path: outsidePath, content: 'outside' } } },
        { text: 'done' },
      ],
    },
    async (h, server) => {
      const first = await turn(server, { prompt: 'write outside' })
      assert.ok(
        first.results.some((text) => /outside the sandbox root/.test(text)),
        `workspace-write refused the outside write\nsaw: ${first.results.join(' | ').slice(0, 300)}`,
      )
      assert.equal(existsSync(h.outsidePath), false, 'and nothing landed outside')

      const unconfirmed = await changeMode(server, first.session, { mode: 'danger-full-access' })
      assert.ok(
        unconfirmed.status === 400 || unconfirmed.status === 409,
        `the unconfirmed escalation is refused (status ${unconfirmed.status})\n${unconfirmed.text.slice(0, 300)}`,
      )
      assert.match(unconfirmed.text, /confirm/i, 'and the refusal says what is missing')
      assert.equal((await sessionOf(server, first.session)).permission?.mode, 'workspace-write', 'the mode did not move')

      const invalid = await changeMode(server, first.session, { mode: 'root' })
      assert.ok(invalid.status === 400 || invalid.status === 409, `a mode outside the vocabulary is refused (status ${invalid.status})`)
      assert.equal((await sessionOf(server, first.session)).permission?.mode, 'workspace-write', 'and the mode still did not move')

      const confirmed = await changeMode(server, first.session, { mode: 'danger-full-access', confirm: 'full-access' })
      assert.equal(confirmed.status, 200, `the confirmed escalation is accepted\n${confirmed.text.slice(0, 300)}`)
      assert.equal((await sessionOf(server, first.session)).permission?.mode, 'danger-full-access', 'and the session carries full access')

      const second = await turn(server, { session: first.session, prompt: 'write outside again' })
      assert.ok(
        second.results.some((text) => /wrote/.test(text)),
        `full access permitted the write the other mode refused\nsaw: ${second.results.join(' | ').slice(0, 300)}`,
      )
      assert.equal(existsSync(h.outsidePath), true, 'and the file landed outside the workspace')

      assert.deepEqual(
        permissionEvents(h.home, first.session).map((event) => event.mode),
        ['danger-full-access'],
        'only the confirmed change is recorded',
      )
    },
  )
})
