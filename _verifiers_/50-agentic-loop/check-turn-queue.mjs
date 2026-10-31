import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, readTranscript, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — one session runs one turn at a time; a prompt sent while a turn runs waits for it (#28).
 *
 * **The claim it decides:** two `POST /api/turn` for one session, the second sent while the first is still streaming,
 * both finish, and the session's log is one ordered conversation: the second prompt is written after the first turn
 * completed, and the model reads the first exchange whole before the second prompt.
 *
 * Measured on both live builds before the fix (draft developer-ten-1): both requests ran at once, their writes
 * interleaved in one log (message A, request A, message B, request B, B completed, request A again), the first turn's
 * next request carried B's exchange and the provider refused it, and the transcript drew the two answers in
 * alternating fragments. DSH admits a prompt sent to a busy session as a follow-up (`agent.followup`) and claims it
 * after the running turn.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** A chat double whose first answer streams slowly, so a second turn arrives while it runs. */
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
      const parsed = JSON.parse(body || '{}')
      requests.push(parsed.messages ?? [])
      const first = requests.length === 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const pieces = first ? Array.from({ length: 10 }, (_, index) => `${index + 1} `) : ['BETA']
      for (const piece of pieces) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`)
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

const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a prompt sent while a turn runs waits for it: both finish and the log is one ordered conversation', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowDouble()
  const home = fixtureDir('turn-queue')
  httpConfig({ home, baseUrl: double.url })
  const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: join(home, 'heddle.json'),
  })
  try {
    const first = await postTurn(server, { prompt: 'COUNT to ten' })
    const session = await first.session
    assert.ok(typeof session === 'string', 'the first turn named its session')
    // The first answer is still streaming (ten pieces, 150 ms apart) when the second prompt is sent.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = await postTurn(server, { session, prompt: 'Reply with only the word BETA.' })
    const [firstText, secondText] = await Promise.all([first.done, second.done])
    for (const [label, text] of [['first', firstText], ['second', secondText]]) {
      assert.doesNotMatch(text, /^event: error$/m, `the ${label} turn did not fail\n${text.slice(-1500)}`)
      assert.match(text, /^event: done$/m, `the ${label} turn finished`)
    }

    const events = readTranscript(join(home, 'sessions', session))
    const promptAt = (word) => events.findIndex((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event).includes(word))
    const firstEnd = events.findIndex((event) => event.type === 'turn/completed')
    const secondPrompt = promptAt('BETA')
    assert.ok(promptAt('COUNT') >= 0 && firstEnd >= 0 && secondPrompt >= 0, `both prompts and a completed turn are logged\n${events.map((event) => event.type).join(' ')}`)
    assert.ok(
      secondPrompt > firstEnd,
      `the second prompt is written after the first turn completed, not inside it\n${events.map((event) => event.type).join(' ')}`,
    )
    // The model reads the first exchange whole before the second prompt.
    const secondRequest = double.requests.find((messages) => JSON.stringify(messages).includes('BETA'))
    assert.ok(secondRequest, 'the second prompt reached the model')
    const assistant = secondRequest.filter((message) => message.role === 'assistant').map((message) => message.content).join('')
    assert.match(assistant, /1\s+2\s+3\s+4\s+5\s+6\s+7\s+8\s+9\s+10/, 'with the first answer whole before it')
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
  }
})
