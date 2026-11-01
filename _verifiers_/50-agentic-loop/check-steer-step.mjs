import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — a steer sent while the model streams is read after the whole step (#30).
 *
 * **The claim it decides:** a message steered into a turn while the model is still streaming does not split the
 * model's step. The next request carries one assistant message holding the whole streamed answer, and ends with the
 * steered message.
 *
 * Measured before the fix (developer-one, main 8ce30549; the live reports in draft developer-ten-3): the steer route
 * writes the message straight into the log, the fold closed the chunk run there, and the rest of the step became a
 * second assistant node after the steer. So the next request ended with an assistant message, which a provider reads
 * as a prefix to continue. The DeepSeek reasoning model refused it with its 400 on reasoning content, and in any mode
 * the model never saw its own reply before the steer. DSH claims steered input at the next step boundary.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns and accepts a steer'

/** A chat double whose first answer streams slowly (reasoning, then ten pieces), so a steer lands mid-stream. */
async function slowDouble() {
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
      /** A new session's title request is not one of the turns this double answers in order (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      requests.push(JSON.parse(body || '{}').messages ?? [])
      const first = requests.length === 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
      if (first) frame({ role: 'assistant', reasoning_content: 'counting ' })
      for (const piece of first ? Array.from({ length: 10 }, (_, index) => `${index + 1} `) : ['noted']) {
        frame({ content: piece })
        if (first) await new Promise((resolve) => setTimeout(resolve, 150))
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`)
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

/** A chat message's text, whichever shape the build sends. */
const contentText = (message) =>
  typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('')

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a steer sent while the model streams is read after one assistant message holding the whole step', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowDouble()
  const home = fixtureDir('steer-step')
  httpConfig({ home, baseUrl: double.url })
  const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: join(home, 'heddle.json'),
  })
  try {
    const turn = await postTurn(server, { prompt: 'COUNT to ten' })
    const session = await turn.session
    assert.ok(typeof session === 'string', 'the turn named its session')
    // Three or so of the ten pieces have streamed when the steer lands.
    await new Promise((resolve) => setTimeout(resolve, 450))
    const steer = await request(server, `/api/sessions/${encodeURIComponent(session)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'NOTICE: also say done' }),
    })
    assert.equal(steer.status, 200, `the steer was accepted while the turn ran\n${await steer.text()}`)
    const text = await turn.done
    assert.doesNotMatch(text, /^event: error$/m, `the turn did not fail\n${text.slice(-1500)}`)

    const next = double.requests.find((messages) => JSON.stringify(messages).includes('NOTICE'))
    assert.ok(next, `the steer reached the model in a later request\n${double.requests.length} request(s)`)
    const shape = next.map((message) => `${message.role}:${contentText(message).slice(0, 40)}`)
    assert.equal(next.at(-1)?.role, 'user', `the request ends with the steered message, not an assistant prefix\n${shape.join('\n')}`)
    assert.match(contentText(next.at(-1)), /NOTICE/, `the last message is the steer\n${shape.join('\n')}`)
    const afterPrompt = next.slice(next.findIndex((message) => message.role === 'user' && contentText(message).includes('COUNT')) + 1, -1)
    const assistants = afterPrompt.filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, 1, `one assistant message for the one streamed step\n${shape.join('\n')}`)
    assert.match(contentText(assistants[0]), /1\s+2\s+3\s+4\s+5\s+6\s+7\s+8\s+9\s+10/, 'holding the whole answer')
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
  }
})
