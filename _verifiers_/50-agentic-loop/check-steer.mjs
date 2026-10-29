import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Steering during a tool call, judged the way DSH's agent inbox behaves (R-developer-two-5).
 *
 * DSH queues a steered message in the agent's **next-step inbox** and claims it at the next step boundary, so a
 * steer sent while a tool runs is written **after** that tool's result. DSH's session cancel keeps the inbox
 * (`keepInbox: true`), so a stop leaves the steer pending, and the next turn writes it before its own prompt.
 * Measured on both builds before the fix: the steer was written between the assistant's `bash` call and its
 * result, and a stop then left nothing pending.
 *
 * Two claims, each driven through `heddle web` with a scripted model whose first step is a `bash sleep`:
 *
 * 1. a steer accepted while the call runs is written after the call's result, and the same turn answers it;
 * 2. a steer accepted while the call runs, followed by a stop, is still pending in the session view's `inbox`
 *    and absent from the conversation; the next turn writes it before that turn's prompt and empties the inbox.
 *
 * The raw log (`GET /api/sessions/{id}/log`) is the judge of order, not the view: the view draws a tool's result
 * on the call's row, so a steer written between them still reads as following the tool there.
 */

const CAPABILITY = 'the web server'

function startServer(home, config) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', HEDDLE_CONFIG: config, HEDDLE_HOME: home },
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
    })()
  })
}

/** The token in the printed URL, exchanged for the cookie everything else uses. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

function client(url, cookie) {
  const origin = new URL(url).origin
  const call = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), {
      ...init,
      headers: { cookie, origin, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    return { status: response.status, text: await response.text() }
  }
  return {
    call,
    json: async (path, init) => {
      const { status, text } = await call(path, init)
      try {
        return { status, body: JSON.parse(text) }
      } catch {
        return { status, body: text }
      }
    },
    log: async (id) => {
      const { status, text } = await call(`/api/sessions/${id}/log`)
      assert.equal(status, 200, `the log is readable (${status})`)
      return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
    },
  }
}

async function until(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const textOf = (message) => (message?.content ?? []).map((part) => part.text ?? '').join('')
const isUser = (text) => (event) => event.type === 'message' && event.message?.role === 'user' && textOf(event.message) === text
const isToolResult = (event) => event.type === 'message' && event.message?.role === 'tool'
const isCall = (event) => event.type === 'assistant/chunk' && event.chunk?.type === 'tool-call'

/** Start a turn without waiting for it, and find its session once it is running. */
async function startTurn(api, body) {
  const done = api.call('/api/turn', { method: 'POST', body: JSON.stringify(body) })
  const id = await until('a running session', async () => {
    const { body: listed } = await api.json('/api/sessions')
    const rows = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
    return rows.find((row) => row.running === true)?.id
  })
  return { id, done }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('a steer sent during a tool call is written after the call’s result, and the same turn answers it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('steer-order')
  const work = fixtureDir('steer-order-work')
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 3' } } }, { text: 'answered after the steer' }],
  })
  const server = await startServer(home, config)
  try {
    const api = client(server.url, await cookieFor(server.url))
    const { id, done } = await startTurn(api, { prompt: 'run the long tool', folder: work })
    await until('the bash call to be in flight', async () => {
      const log = await api.log(id)
      return log.some(isCall) && !log.some(isToolResult)
    })
    const steer = await api.json(`/api/sessions/${id}/steer`, { method: 'POST', body: JSON.stringify({ prompt: 'steered during the tool' }) })
    assert.equal(steer.status, 200, `the steer was accepted while the call ran (${steer.status} ${JSON.stringify(steer.body)})`)
    const turn = await done
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)

    const log = await api.log(id)
    const result = log.find(isToolResult)
    const steered = log.find(isUser('steered during the tool'))
    assert.ok(result !== undefined, 'the call was answered')
    assert.ok(steered !== undefined, 'the steer reached the conversation')
    const call = log.find(isCall)
    assert.ok(
      steered.seq > result.seq,
      `the steer (seq ${steered.seq}) is written after the call's result (seq ${result.seq}), not between the call (seq ${call?.seq}) and its result`,
    )
    const answered = log.find((event) => event.seq > steered.seq && event.type === 'assistant/chunk' && event.chunk?.type === 'text-delta' && event.chunk.text === 'answered after the steer')
    assert.ok(answered !== undefined, 'the same turn asked the model again after the steer and answered it')
    const view = await api.json(`/api/sessions/${id}`)
    assert.deepEqual(view.body?.inbox?.['next-step'], [], 'nothing is left pending once the turn has taken the steer')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a stop during a tool call keeps the steer pending, and the next turn writes it before its own prompt', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('steer-stop')
  const work = fixtureDir('steer-stop-work')
  const { config, script } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 20' } } }, { text: 'the stopped turn never asks this' }],
  })
  const server = await startServer(home, config)
  try {
    const api = client(server.url, await cookieFor(server.url))
    const { id, done } = await startTurn(api, { prompt: 'run then stop', folder: work })
    await until('the bash call to be in flight', async () => {
      const log = await api.log(id)
      return log.some(isCall) && !log.some(isToolResult)
    })
    const steer = await api.json(`/api/sessions/${id}/steer`, { method: 'POST', body: JSON.stringify({ prompt: 'steered then stopped' }) })
    assert.equal(steer.status, 200, `the steer was accepted while the call ran (${steer.status})`)
    const stop = await api.json(`/api/sessions/${id}/stop`, { method: 'POST', body: '{}' })
    assert.equal(stop.status, 200, `the stop was accepted (${stop.status})`)
    await done
    await until('the stopped turn to settle', async () => {
      const { body: listed } = await api.json('/api/sessions')
      const rows = Array.isArray(listed) ? listed : (listed?.sessions ?? [])
      return rows.some((row) => row.id === id && row.running === false)
    })

    const afterStop = await api.log(id)
    assert.ok(!afterStop.some(isUser('steered then stopped')), 'the stopped turn did not write the steer into the conversation')
    const view = await api.json(`/api/sessions/${id}`)
    const pending = view.body?.inbox?.['next-step']
    assert.ok(Array.isArray(pending), `the session view reports its inbox (${JSON.stringify(view.body?.inbox)})`)
    assert.deepEqual(pending.map((item) => textOf(item)), ['steered then stopped'], 'the steer is still pending after the stop, as DSH keeps it')

    // The next turn of the same session: its rounds start again at step 0, so the script now answers at once.
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'both answered' }] }))
    const next = await api.call('/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'the next prompt', session: id }) })
    assert.equal(next.status, 200, `the next turn ran (${next.status})`)
    const log = await api.log(id)
    const steered = log.find(isUser('steered then stopped'))
    const prompt = log.find(isUser('the next prompt'))
    const result = log.find(isToolResult)
    assert.ok(steered !== undefined && prompt !== undefined, 'both messages reached the conversation')
    assert.ok(steered.seq < prompt.seq, `the kept steer (seq ${steered.seq}) is written before the next prompt (seq ${prompt.seq})`)
    assert.ok(result !== undefined && result.seq < steered.seq, 'and after the stopped call’s result')
    const settled = await api.json(`/api/sessions/${id}`)
    assert.deepEqual(settled.body?.inbox?.['next-step'], [], 'the inbox is empty once the next turn has taken the steer')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
