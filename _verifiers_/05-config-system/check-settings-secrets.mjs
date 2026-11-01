// The settings view never returns what /api/endpoints hides (issue #118). An endpoint's key file path, its header
// values and a credential field with a compound name (clientSecret) are secret slots: GET /api/settings reports that
// they are set, never their values, and a write cannot set them. Runs against whichever harness HEDDLE_BIN names, or
// the TypeScript build, on a scratch profile whose model row declares such an endpoint.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

const HEADER_VALUE = 'Bearer sekrit-header-value'
const CLIENT_SECRET = 'sekrit-client-value'
const KEY_TEXT = 'sk-from-the-key-file'

/** The profile, and a real key file whose path is the secret (the model row reads it at boot). */
function scratchProfile(home, keyPath) {
  const profile = join(home, 'settings-secrets-profile')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(keyPath, '..'), { recursive: true })
  writeFileSync(keyPath, `${KEY_TEXT}\n`)
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  const guarded = [
    '- patch:',
    '    - id: model',
    '      config:',
    '        endpoints:',
    '          - name: guarded',
    '            kind: openai-chat',
    '            baseUrl: http://127.0.0.1:9/v1',
    '            model: m',
    `            apiKeyFile: ${keyPath}`,
    `            clientSecret: ${CLIENT_SECRET}`,
    '            headers:',
    `              Authorization: ${HEADER_VALUE}`,
    '',
  ].join('\n')
  writeFileSync(join(profile, 'heddle.patch.yml'), `${tree.trimEnd()}\n${guarded}`)
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

test('a key file path, header values and a compound credential name are never returned and cannot be written', async () => {
  const home = isolatedHome('settings-secrets')
  let server
  try {
    const KEY_PATH = join(home, 'sekrit-account', 'key-path.txt')
    const profile = scratchProfile(home, KEY_PATH)
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
    server = await startServer(['--profile', profile, '--sandbox-root', home], env)
    const call = (method, path, body) =>
      fetch(`${server.base}${path}${path.includes('?') ? '&' : '?'}token=${server.token}`, {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })

    const endpoints = await (await call('GET', '/api/endpoints')).text()
    for (const value of [KEY_PATH, HEADER_VALUE, CLIENT_SECRET, KEY_TEXT]) assert.ok(!endpoints.includes(value), `/api/endpoints hides ${value}`)

    const viewText = await (await call('GET', '/api/settings')).text()
    for (const value of [KEY_PATH, HEADER_VALUE, CLIENT_SECRET, KEY_TEXT]) {
      assert.ok(!viewText.includes(value), `GET /api/settings never returns '${value}'`)
    }
    const model = JSON.parse(viewText).namespaces.find((entry) => entry.ns === 'model')
    const slots = (model.secrets ?? []).map((slot) => `${slot.path.join('.')}:${slot.set}`)
    for (const path of ['endpoints.0.apiKeyFile', 'endpoints.0.clientSecret', 'endpoints.0.headers.Authorization']) {
      assert.ok(slots.includes(`${path}:true`), `'${path}' is reported as a set secret (${slots.join(', ')})`)
    }
    const entryText = await (await call('GET', '/api/settings/model')).text()
    for (const value of [KEY_PATH, HEADER_VALUE, CLIENT_SECRET, KEY_TEXT]) assert.ok(!entryText.includes(value), `GET /api/settings/model never returns '${value}'`)

    const patch = readFileSync(join(profile, 'heddle.patch.yml'), 'utf8')
    for (const [label, body] of [
      ['a header added under headers', { ops: [{ op: 'set', path: ['endpoints', '0', 'headers', 'X-Api-Key'], value: 'k' }] }],
      ['a key file named by a compound field', { update: { endpoints: [{ name: 'other', kind: 'openai-chat', apiKeyFile: '/srv/other/key.txt' }] } }],
      ['a credential field nested in a written value', { update: { endpoints: [{ name: 'other', kind: 'openai-chat', accessToken: 't' }] } }],
    ]) {
      const response = await call('POST', '/api/settings/model', body)
      const text = await response.text()
      assert.equal(response.status, 422, `${label} is refused\n${text}`)
      assert.match(text, /settings-rejected/)
    }
    assert.equal(readFileSync(join(profile, 'heddle.patch.yml'), 'utf8'), patch, 'nothing was written')
  } finally {
    server?.kill()
    removeDir(home)
  }
})
