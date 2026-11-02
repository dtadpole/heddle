import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The model is told what a `bash` timeout does (developer-five's finding, 2026-11-01).
 *
 * DSH picks the `timeoutMs` description by whether a timed-out call is promoted (dsh-tool-bash lib/index.js:506-508).
 * With promotion on: "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the
 * command moves to the background as a job instead of being killed." Otherwise: "... kills the command on expiry".
 * heddle's jobs row promotes by default (`promoteOnTimeout`), but the schema a provider received still said "Wall time
 * before the command is killed" on both builds.
 *
 * One turn against a Chat Completions double; the `bash` schema in the request must carry the promotion text.
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

/** A Chat Completions double that answers everything at once and keeps every request body. */
async function double() {
  const requests = []
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
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = raw.includes('Create a concise title') ? 'A title' : 'a short answer'
      for (const frame of [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
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

test('the bash schema a provider receives says a timed-out call moves to a background job', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('bash-timeout-text')
  const work = fixtureDir('bash-timeout-text-work')
  mkdirSync(work, { recursive: true })
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'say hello', folder: work, new: true }),
    })
    assert.equal(turn.status, 200, 'the turn ran')
    await turn.text()
    const request = provider.requests.map((raw) => JSON.parse(raw)).find((body) => Array.isArray(body.tools) && JSON.stringify(body.messages ?? []).includes('say hello'))
    assert.ok(request !== undefined, 'the turn’s request reached the double with its tools')
    const bash = request.tools.find((tool) => tool?.function?.name === 'bash')
    assert.ok(bash !== undefined, 'bash is offered')
    const text = String(bash.function.parameters?.properties?.timeoutMs?.description ?? '')
    assert.match(text, /on expiry the command moves to the background as a job instead of being killed\.$/, `the timeout text says promotion\nsaw: ${text}`)
    assert.ok(bash.function.parameters?.properties?.run_in_background !== undefined, 'and the jobs row is attached')
  } finally {
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
