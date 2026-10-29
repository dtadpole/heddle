// The machine configuration applies to the next request without a server restart, as DSH's provider settings do
// (A109): a running `web` server whose machine file (HEDDLE_CONFIG) is edited lists the new endpoints and default at
// once, and the next turn that names no endpoint goes to the new default. Runs against whichever harness HEDDLE_BIN
// names, or the TypeScript build. Two local OpenAI-compatible doubles stand in for providers; nothing real is called.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

function startServer(env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--sandbox-root', env.HOME]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL') })
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}${path.includes('?') ? '&' : '?'}token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

test('an edit to the machine file applies to the next request without a restart', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), 'web')) return
  const home = isolatedHome('live-config')
  const one = await chatDouble({ content: 'answered by one' })
  const two = await chatDouble({ content: 'answered by two' })
  let server
  try {
    const file = join(home, 'heddle.json')
    const endpoint = (name, double) => ({ name, kind: 'openai-chat', baseUrl: double.baseUrl, model: 'double', stream: true })
    writeFileSync(file, JSON.stringify({ default: 'one', exclude: ['scripted'], endpoints: [endpoint('one', one), endpoint('two', two)] }))
    server = await startServer({ HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: file })

    const first = await call(server, 'POST', '/api/turn', { prompt: 'which endpoint answers?' })
    assert.equal(first.status, 200, `the first turn ran\n${JSON.stringify(first.body).slice(0, 300)}`)
    assert.equal(one.requests.length, 1, 'the configured default answered')
    assert.equal(two.requests.length, 0)

    // The edit, while the server runs: a new default and a new endpoint. The padding changes the file's size, so
    // even a filesystem with a coarse modification time sees a different file.
    writeFileSync(
      file,
      `${JSON.stringify({ default: 'two', exclude: ['scripted'], endpoints: [endpoint('one', one), endpoint('two', two), endpoint('three', one)] })}\n\n`,
    )
    const listing = await call(server, 'GET', '/api/endpoints')
    assert.equal(listing.status, 200)
    assert.deepEqual(
      listing.body.endpoints.map((entry) => entry.name).sort(),
      ['one', 'three', 'two'],
      'the endpoint the edit added is listed without a restart',
    )
    assert.equal(listing.body.default, 'two', 'and the edited default is the default')

    const second = await call(server, 'POST', '/api/turn', { prompt: 'and now?' })
    assert.equal(second.status, 200, `the second turn ran\n${JSON.stringify(second.body).slice(0, 300)}`)
    assert.equal(two.requests.length, 1, 'a new turn goes to the edited default')
    assert.equal(one.requests.length, 1, 'and not to the old one')
  } finally {
    server?.kill()
    await one.close()
    await two.close()
    removeDir(home)
  }
})
