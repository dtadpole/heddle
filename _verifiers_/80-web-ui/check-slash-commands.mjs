import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The slash-command layer, judged at the server (C78-C83, R-developer-twelve-1, R-developer-six-5).
 *
 * DSH runs a command line on the host: it is never sent to the model, it is recorded in the session log as a
 * `command/run` and a `command/done`, and a line that names no command is left alone so it reaches the model as an
 * ordinary prompt. Phase A found the opposite on both builds — `/compact`, `/goal` and `/export` were answered by the
 * model and logged as prompts — so these checks fail on a build without the layer and pass with it.
 *
 * Every assertion reads the server back (`/api/goal`, the session's log) rather than trusting the command's own
 * answer, because the failure this exists to catch is a reply that says "done" while the log says a model ran.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`slash-${label}`)
  const work = fixtureDir(`slash-${label}-work`)
  mkdirSync(work, { recursive: true })
  /** Any turn that did run would answer this, which is how a line that reached the model would show. */
  const { config } = scriptedConfig({ home, steps: [{ text: 'the model answered' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    work,
    url: child.url,
    close: () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`heddle web exited ${code} before printing its URL:\n${output}`))
      })
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
          reject(new Error(`heddle web printed no URL within 30s:\n${output}`))
        }
      }, 30_000)
    })()
  })
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { text }
  }
  return { status: response.status, body }
}

/** A session in the server's own workspace, as the page opens one. */
async function openSession(server, cookie) {
  await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
  const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
  const id = opened.body.session?.id ?? opened.body.id
  assert.match(String(id), /^session-/, `a session was opened: ${JSON.stringify(opened)}`)
  return id
}

/** The session's log as the Download log route serves it: the bytes and the parsed events. */
async function sessionLog(server, cookie, id) {
  const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/log`, server.url), { headers: { cookie } })
  assert.equal(response.status, 200, 'the session log downloads')
  const text = await response.text()
  return { text, events: text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line)) }
}

function runLine(server, cookie, id, line) {
  return api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ line }) })
}

/** Whether a log shows any sign of the model: a request, a streamed answer, or the line recorded as a message. */
function reachedModel(events, line) {
  return events.some(
    (event) =>
      event.type === 'model/request' ||
      event.type === 'assistant/chunk' ||
      (event.type === 'message' && JSON.stringify(event.message ?? event).includes(line)),
  )
}

test("the server lists DSH's host commands for the composer's slash menu", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('list')
  try {
    const cookie = await cookieFor(server.url)
    const listed = await api(server.url, cookie, '/api/commands')
    assert.equal(listed.status, 200, `GET /api/commands answers: ${JSON.stringify(listed.body).slice(0, 200)}`)
    const commands = listed.body.commands
    assert.ok(Array.isArray(commands), 'the answer carries a commands list')
    const names = commands.map((entry) => entry.name)
    for (const name of ['compact', 'export', 'feedback', 'goal', 'permission']) {
      assert.ok(names.includes(name), `/${name} is listed (listed: ${names.join(', ')})`)
    }
    for (const entry of commands) {
      assert.equal(typeof entry.description, 'string', `/${entry.name} has a description`)
      assert.ok(entry.description.length > 0)
      assert.ok(entry.section === 'add' || entry.section === 'commands', `/${entry.name} names a menu section`)
    }
    assert.equal(commands.find((entry) => entry.name === 'goal')?.input?.hint, '[<objective>|clear|edit <objective>|pause|resume]')
    assert.equal(commands.find((entry) => entry.name === 'compact')?.input, undefined, '/compact takes no input, so the menu runs it at once')
  } finally {
    server.close()
  }
})

test('a command line runs on the host, is recorded in the log, and never reaches the model', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('goal')
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    const line = '/goal ship the parity table'
    const ran = await runLine(server, cookie, id, line)
    assert.equal(ran.status, 200, `the run is answered: ${JSON.stringify(ran.body).slice(0, 200)}`)
    assert.equal(ran.body.matched, true, 'the line is a command')
    assert.equal(ran.body.kind, 'success', `it succeeded: ${ran.body.text}`)

    const goal = await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(id)}`)
    assert.equal(goal.body.goal?.objective, 'ship the parity table', 'the goal service holds what the command set')

    const { events } = await sessionLog(server, cookie, id)
    const run = events.find((event) => event.type === 'command/run')
    const done = events.find((event) => event.type === 'command/done')
    assert.ok(run !== undefined, 'the log records command/run')
    assert.equal(run.name, 'goal')
    assert.equal(run.args, 'ship the parity table')
    assert.ok(done !== undefined && done.commandId === run.commandId, 'and the matching command/done')
    assert.equal(done.kind, 'success')
    assert.ok(events.some((event) => event.type === 'goal/change'), 'the goal change itself is in the log')
    /**
     * The goal driver is part of the default profile, so a goal set here starts being pushed as soon as the session is
     * idle — DSH's "set and drive a goal from the composer". What must never happen is the **line** reaching the model:
     * it is not a message, and any model request is the driver's round, after the command finished, without the line.
     */
    assert.equal(
      events.some((event) => event.type === 'message' && JSON.stringify(event).includes(line)),
      false,
      'the command line is never recorded as a message',
    )
    for (const request of events.filter((event) => event.type === 'model/request')) {
      assert.ok(request.seq > done.seq, `a model request (seq ${request.seq}) is the goal being driven, after the command (seq ${done.seq})`)
      assert.equal(JSON.stringify(request).includes(line), false, 'and it does not carry the command line')
    }
  } finally {
    server.close()
  }
})

test('/export answers a download of exactly the bytes Download log serves, without the model', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('export')
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    const ran = await runLine(server, cookie, id, '/export')
    assert.equal(ran.body.matched, true)
    assert.equal(ran.body.kind, 'success')
    const href = ran.body.action?.href
    assert.equal(ran.body.action?.kind, 'download', 'the page is asked to download')
    assert.equal(typeof href, 'string')
    const exported = await fetch(new URL(href, server.url), { headers: { cookie } })
    assert.equal(exported.status, 200)
    const exportedText = await exported.text()
    const { text, events } = await sessionLog(server, cookie, id)
    assert.equal(exportedText, text, '/export downloads the same bytes as Download log')
    assert.equal(reachedModel(events, '/export'), false)

    const refused = await runLine(server, cookie, id, '/export /tmp/x.zip')
    assert.equal(refused.body.matched, true)
    assert.equal(refused.body.kind, 'error', 'a path is refused rather than sent anywhere')
    assert.equal(refused.body.action, undefined)
  } finally {
    server.close()
  }
})

test('a line that names no command is left for the model, and nothing is recorded for it', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('unknown')
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    const before = (await sessionLog(server, cookie, id)).events.length
    for (const line of ['/nosuchcommand please', 'plain words', '/Goal capitalised']) {
      const ran = await runLine(server, cookie, id, line)
      assert.equal(ran.status, 200, `${line} is answered`)
      assert.deepEqual(ran.body, { matched: false }, `${line} is not a command, so the page sends it as a prompt`)
    }
    assert.equal((await sessionLog(server, cookie, id)).events.length, before, 'an unmatched line writes nothing')
  } finally {
    server.close()
  }
})
