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

test('a settings write of the presets default is the next new session\'s, and an existing session keeps its own (A96)', async () => {
  const home = isolatedHome('settings-live-presets')
  const double = await chatDouble({ content: 'ok' })
  let server
  try {
    const config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({ default: 'gateway', exclude: ['scripted'], endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'm', stream: true }] }))
    const profile = scratchProfile(home)
    // The shipped tree has no presets row; this profile adds one, so the settings write lands in the profile's patch.
    const patch = join(profile, 'heddle.patch.yml')
    writeFileSync(
      patch,
      readFileSync(patch, 'utf8') +
        `\n- insert:\n    - id: presets\n      name: ${repoRoot}/src/plugins/presets.ts\n      config:\n        default: standard\n        presets:\n          - id: standard\n            name: Standard\n          - id: reader\n            name: Reader\n`,
    )
    server = await startServer(['--profile', profile, '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config })
    const sessionIds = async () => ((await call(server, 'GET', '/api/sessions')).body ?? []).map((session) => session.id)
    const startTurn = async (body) => {
      const before = await sessionIds()
      const turn = await call(server, 'POST', '/api/turn', body)
      assert.equal(turn.status, 200, `the turn ran\n${JSON.stringify(turn.body).slice(0, 300)}`)
      return (await sessionIds()).find((id) => !before.includes(id))
    }
    const presetOf = async (id) => (await call(server, 'GET', `/api/sessions/${id}`)).body?.preset

    const existing = await startTurn({ prompt: 'first' })
    assert.equal(await presetOf(existing), 'standard', 'a session made before the write runs the booted default')

    const before = await call(server, 'GET', '/api/settings/presets')
    assert.equal(before.status, 200, `the presets row is a settings entry\n${JSON.stringify(before.body).slice(0, 300)}`)
    assert.equal(before.body.applies, 'live', 'a presets write applies to the running server')
    const written = await call(server, 'POST', '/api/settings/presets', { update: { default: 'reader' }, expectedRevision: before.body.revision })
    assert.equal(written.status, 200, `the write is accepted\n${JSON.stringify(written.body).slice(0, 300)}`)
    assert.equal(written.body.applyError, undefined, 'and the running tree took it')

    assert.equal((await call(server, 'GET', '/api/presets')).body.default, 'reader', 'the roster answers the written default at once')
    const fresh = await startTurn({ prompt: 'second' })
    assert.equal(await presetOf(fresh), 'reader', 'a new session starts under the written default')
    const again = await call(server, 'POST', '/api/turn', { prompt: 'again', session: existing })
    assert.equal(again.status, 200, `the existing session runs on\n${JSON.stringify(again.body).slice(0, 300)}`)
    assert.equal(await presetOf(existing), 'standard', 'and keeps the preset it recorded')
  } finally {
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
