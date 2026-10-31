import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — a steer sent during a step that calls a tool is written after the tool's result (#31).
 *
 * **The claim it decides:** a steer is delivered at the next step boundary. The log holds the call, its result, then
 * the steered message, never a user message between a call and its result. The next request reads them in that
 * order and ends with the steer.
 *
 * Measured before (draft developer-ten-4, TS live): the steer route wrote the message at once. A steer sent while a
 * shell call ran sat between the call and its output in the log, the page drew it above the tool row, and the model
 * did not follow it. DSH's steer is a next-step inbox splice (`send(message, 'next-step', true)`), claimed at the
 * step boundary.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns, with a steer route and the list_dir tool'

/** A chat double: the first step streams slowly and calls list_dir; the next answers. */
async function toolDouble() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', async () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      requests.push(JSON.parse(body || '{}').messages ?? [])
      const first = requests.length === 1
      const frame = (delta, finish = null) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (first) {
        frame({ role: 'assistant', content: 'looking ' })
        await new Promise((resolve) => setTimeout(resolve, 600))
        frame({ tool_calls: [{ index: 0, id: 'call-list', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] })
        frame({}, 'tool_calls')
      } else {
        frame({ role: 'assistant', content: 'STEERED' })
        frame({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((done) => server.close(done)) }
}

/** Start the Web UI and resolve once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
      }, 15_000).unref()
    })()
  })
}

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

/** Post a turn; resolve its session as soon as the stream names it, and the whole body when it ends. */
async function postTurn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })
  assert.equal(response.status, 200, `the turn was accepted (${JSON.stringify(body.prompt)})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let nameSession
  const session = new Promise((resolve) => {
    nameSession = resolve
  })
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      text += decoder.decode(value, { stream: true })
      const named = /event: session\ndata: (\{.*\})/.exec(text)
      if (named) {
        try {
          const id = JSON.parse(named[1]).session
          if (typeof id === 'string') nameSession(id)
        } catch {
          // A block not yet whole.
        }
      }
    }
    nameSession(undefined)
    return text
  })()
  return { session, done }
}

const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a steer sent during a step that calls a tool is written after the result, and the model reads it last', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await toolDouble()
  const home = fixtureDir('steer-tool')
  httpConfig({ home, baseUrl: double.url })
  const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: join(home, 'heddle.json'),
  })
  try {
    const turn = await postTurn(server, { prompt: 'look at the folder' })
    const session = await turn.session
    assert.ok(typeof session === 'string', 'the turn named its session')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const steer = await request(server, `/api/sessions/${encodeURIComponent(session)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'STEER: reply with only the word STEERED' }),
    })
    assert.equal(steer.status, 200, `the steer was accepted while the turn ran\n${await steer.text()}`)
    const text = await turn.done
    assert.doesNotMatch(text, /^event: error$/m, `the turn did not fail\n${text.slice(-1500)}`)

    const events = readTranscript(join(home, 'sessions', session))
    const types = events.map((event) => (event.type === 'message' ? `message:${event.message?.role}` : event.type)).join(' ')
    const result = events.findIndex((event) => event.type === 'message' && event.message?.role === 'tool')
    const steered = events.findIndex((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event).includes('STEER:'))
    assert.ok(result >= 0 && steered >= 0, `the tool result and the steer are both logged\n${types}`)
    assert.ok(steered > result, `the steer is written after the tool's result, not between the call and it\n${types}`)

    const next = double.requests.find((messages) => JSON.stringify(messages).includes('STEER:'))
    assert.ok(next, 'the steer reached the model')
    const roles = next.map((message) => message.role)
    assert.deepEqual(roles.slice(-3), ['assistant', 'tool', 'user'], `the request reads the call, its result, then the steer\n${roles.join(' ')}`)
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
  }
})
