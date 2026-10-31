// A settings write applies to the running server without a restart, as DSH's settings do (`applies: live`): the model
// row's default, written through POST /api/settings/model, is the endpoint the very next turn uses. The server is booted
// from a scratch profile so the write lands there; two local OpenAI-compatible doubles stand in for providers.
// Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

function scratchProfile(home) {
  const profile = join(home, 'settings-live-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', ...args]), {
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
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL'), output: () => output })
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
  const response = await fetch(`${server.base}${path}?token=${server.token}`, {
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

test('a settings write to the model row applies to the next turn without a restart', async () => {
  const home = isolatedHome('settings-live')
  const one = await chatDouble({ content: 'answered by one' })
  const two = await chatDouble({ content: 'answered by two' })
  let server
  try {
    const config = join(home, 'heddle.json')
    const endpoint = (name, double) => ({ name, kind: 'openai-chat', baseUrl: double.baseUrl, model: 'double', stream: true })
    writeFileSync(config, JSON.stringify({ default: 'one', exclude: ['scripted'], endpoints: [endpoint('one', one), endpoint('two', two)] }))
    const profile = scratchProfile(home)
    server = await startServer(['--profile', profile, '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config })

    const before = await call(server, 'GET', '/api/settings/model')
    assert.equal(before.status, 200, `the model row is a settings entry\n${JSON.stringify(before.body).slice(0, 300)}`)
    assert.equal(before.body.applies, 'live', 'DSH applies a settings write to the running tree')

    const written = await call(server, 'POST', '/api/settings/model', { update: { default: 'two' }, expectedRevision: before.body.revision })
    assert.equal(written.status, 200, `the write is accepted\n${JSON.stringify(written.body).slice(0, 300)}`)
    assert.equal(written.body.applyError, undefined, 'and the running tree took it')

    const listing = await call(server, 'GET', '/api/endpoints')
    assert.equal(listing.body.default, 'two', 'the endpoint listing reports the written default at once')
    const turn = await call(server, 'POST', '/api/turn', { prompt: 'which endpoint answers?' })
    assert.equal(turn.status, 200, `the turn ran\n${JSON.stringify(turn.body).slice(0, 300)}`)
    assert.equal(two.requests.length, 1, 'the next turn goes to the written default')
    assert.equal(one.requests.length, 0, 'and not to the one the server started with')
  } finally {
    server?.kill()
    await one.close()
    await two.close()
    removeDir(home)
  }
})

test('a settings write of the default model and effort is the next new session\'s, without a restart (A104)', async () => {
  const home = isolatedHome('settings-live-default')
  const double = await chatDouble({ content: 'ok' })
  let server
  try {
    const config = join(home, 'heddle.json')
    const levels = { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] }
    writeFileSync(config, JSON.stringify({
      default: 'gateway',
      exclude: ['scripted'],
      endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'flash', stream: true, models: [{ id: 'flash', name: 'Flash', reasoning: levels }, { id: 'pro', name: 'Pro', reasoning: levels }] }],
    }))
    const profile = scratchProfile(home)
    server = await startServer(['--profile', profile, '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config })

    const before = await call(server, 'GET', '/api/settings/model')
    const written = await call(server, 'POST', '/api/settings/model', { update: { defaultModel: 'pro', defaultEffort: 'high' }, expectedRevision: before.body.revision })
    assert.equal(written.status, 200, `the write is accepted\n${JSON.stringify(written.body).slice(0, 300)}`)
    assert.equal(written.body.applyError, undefined, 'and the running tree took it')

    const listing = await call(server, 'GET', '/api/endpoints')
    assert.deepEqual([listing.body.defaultModel, listing.body.defaultEffort], ['pro', 'high'], 'the endpoint listing names the written default selection at once')
    // A fresh composer sends the listing's default selection, as the page does (A104's 0005).
    const turn = await call(server, 'POST', '/api/turn', { prompt: 'which model answers?', model: listing.body.defaultModel, reasoningEffort: listing.body.defaultEffort })
    assert.equal(turn.status, 200, `the turn ran\n${JSON.stringify(turn.body).slice(0, 300)}`)
    const first = JSON.parse(double.requests[0]?.body ?? '{}')
    assert.equal(first.model, 'pro', 'the new session runs on the written default model')
    assert.equal(first.reasoning_effort, 'high', 'and the written default effort')
  } finally {
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
