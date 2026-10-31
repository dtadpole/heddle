import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, httpConfig, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — a prompt of only whitespace is refused, as an empty one is (#32).
 *
 * **The claim it decides:** `POST /api/turn` answers 400 for a prompt that is only spaces, tabs or newlines, and the
 * model is never asked; an ordinary prompt still runs.
 *
 * Measured before on both builds (draft developer-ten-5): `""` was refused with 400, but `"   "` was accepted and ran
 * a model turn on nothing. DSH refuses content without non-whitespace text (`hasPromptContent`: "prompt content must
 * include non-whitespace text or an attachment").
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'

/** A chat double that answers at once and counts what it was asked. */
async function countingDouble() {
  let asked = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      /** A new session's title request is not the turn this double counts (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      asked += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked: () => asked, close: () => new Promise((done) => server.close(done)) }
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

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('a prompt of only whitespace is refused with 400 and never reaches the model', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await countingDouble()
  const home = fixtureDir('blank-prompt')
  httpConfig({ home, baseUrl: double.url })
  const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: join(home, 'heddle.json'),
  })
  try {
    for (const prompt of ['', '   ', '\n\t \n']) {
      const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt }) })
      const body = await response.text()
      assert.equal(response.status, 400, `${JSON.stringify(prompt)} is refused\n${body.slice(0, 300)}`)
    }
    assert.equal(double.asked(), 0, 'the model was never asked')
    const ordinary = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'hi' }) })
    assert.equal(ordinary.status, 200, 'an ordinary prompt still runs')
    await ordinary.text()
    assert.equal(double.asked(), 1, 'and reaches the model once')
  } finally {
    server.kill()
    await double.close()
    removeDir(home)
  }
})
