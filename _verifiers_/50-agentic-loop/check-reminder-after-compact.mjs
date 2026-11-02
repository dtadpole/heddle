import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A reminder that falls due during `/compact` runs as soon as the compaction settles (issue #197).
 *
 * DSH's `runMaintenance` latches a wake that arrives during maintenance and replays it in its `finally`
 * (dsh-agent-loop), so the reminder's followup runs right after the compaction. TS heddle parked the reminder behind
 * the busy session and woke it only on a turn event; `/compact` holds the session through the live-turn registry and
 * writes none, so the reminder waited for the 60 s busy recheck. The Rust build already woke on the registry.
 *
 * A turn creates an `after_seconds: 2` reminder; `/compact` follows at once, and its summary request is held 5 s. The
 * reminder's message must follow the compaction's `command/done` within 3 s.
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

const SUMMARY_HOLD_MS = 5_000

/** A Chat Completions double: the reminder turn's tool call, a held summary, and short answers otherwise. */
async function double() {
  const requests = []
  const send = (response, delta, finish = 'stop') => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.end('data: [DONE]\n\n')
  }
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
      const body = JSON.parse(raw)
      const messages = Array.isArray(body.messages) ? body.messages : []
      const last = messages.at(-1)
      const text = JSON.stringify(last ?? {})
      if (raw.includes('Create a concise title')) return send(response, { content: 'A title' })
      if (raw.includes('acting as a compaction engine') || raw.includes('Summarise the conversation above')) {
        setTimeout(() => send(response, { content: 'a briefing of the conversation so far' }), SUMMARY_HOLD_MS)
        return
      }
      if (text.includes('[SCHEDULE REMINDER]')) return send(response, { content: 'reminder answered' })
      if (last?.role === 'user' && text.includes('set the reminder')) {
        return send(
          response,
          { tool_calls: [{ index: 0, id: 'call_197', type: 'function', function: { name: 'schedule_create', arguments: JSON.stringify({ prompt: 'REMIND-197 look again', title: 'Look again', after_seconds: 2 }) } }] },
          'tool_calls',
        )
      }
      return send(response, { content: `noted ${'detail '.repeat(30)}` })
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

test('#197: a reminder that falls due during /compact runs as soon as the compaction settles', { timeout: 120_000 }, async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('reminder-after-compact')
  const work = fixtureDir('reminder-after-compact-work')
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const root = join(home, 'sessions')
  let server = null
  try {
    server = await startCli(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
      { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    )
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const turn = async (prompt, session) => {
      const response = await fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, folder: work, ...(session === undefined ? { new: true } : { session }) }),
      })
      const text = await response.text()
      assert.equal(response.status, 200, `the turn ran: ${text.slice(0, 200)}`)
      return /event: session\ndata: (.*)/.exec(text)?.[1] === undefined ? session : JSON.parse(/event: session\ndata: (.*)/.exec(text)[1]).session
    }
    // History for the compaction to fold, then the turn that sets the reminder.
    const session = await turn(`first, some background ${'context '.repeat(60)}`)
    await turn(`second ${'context '.repeat(60)}`, session)
    await turn(`third ${'context '.repeat(60)}`, session)
    await turn('set the reminder', session)
    const compacted = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/compact' }) })
    assert.equal(compacted.status, 200, `/compact answered (${JSON.stringify(compacted.body)})`)
    const log = () => readTranscript(join(root, session))
    const done = log().findLast((event) => event.type === 'command/done')
    assert.ok(log().some((event) => event.type === 'compaction/end'), `the compaction landed\n${log().map((event) => event.type).join(' ')}`)
    const due = log().find((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'schedule')
    // Wait up to 10 s for the reminder; the busy recheck would take about 60 s.
    let reminder = due
    const deadline = Date.now() + 10_000
    while (reminder === undefined && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
      reminder = log().find((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'schedule')
    }
    assert.ok(reminder !== undefined, 'the reminder was delivered within 10 s of the compaction')
    const lag = Date.parse(reminder.at) - Date.parse(done.at)
    assert.ok(lag < 3_000, `the reminder followed the compaction's command/done within 3 s (lag ${lag} ms)`)
  } finally {
    server?.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
