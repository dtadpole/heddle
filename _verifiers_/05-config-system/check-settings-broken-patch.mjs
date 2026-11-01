// A hand edit that breaks the profile patch (#165) leaves the settings readable from the running configuration, as
// DSH's settings read projects configEditor.configuration() without parsing the file, and refuses only a write. Both the
// view's note and the refusal name the file, line and reason and quote none of the file, where a credential may sit.
// Runs against whichever harness HEDDLE_BIN names, or the TypeScript build, on a scratch profile under an isolated home.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

function scratchProfile(home) {
  const profile = join(home, 'settings-broken-profile')
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

/** The committed projections, with the home placeholder resolved as each build resolves it. */
async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}?token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: response.status, text, body: parsed }
}

const SECRET = 'sk-live-ABCDEF0123456789'

test('a broken profile patch keeps the settings readable and refuses only a write, quoting none of the file', async () => {
  const home = isolatedHome('settings-broken')
  const profile = scratchProfile(home)
  const server = await startServer(['--profile', profile, '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle') })
  try {
    const first = await call(server, 'POST', '/api/settings/tools', { update: { bashTimeoutMs: 45000 } })
    assert.equal(first.status, 200, `a first write makes the block (${first.text.slice(0, 200)})`)
    const patchFile = join(profile, 'heddle.patch.yml')
    const broken = `${readFileSync(patchFile, 'utf8')}proxyKey: ${SECRET}\nbroken: [unclosed\n`
    writeFileSync(patchFile, broken)

    const view = await call(server, 'GET', '/api/settings')
    assert.equal(view.status, 200, `the settings still answer (${view.text.slice(0, 300)})`)
    assert.ok(Array.isArray(view.body?.namespaces) && view.body.namespaces.length > 0, 'with every entry\'s form')
    const tools = view.body.namespaces.find((entry) => entry.ns === 'tools')
    assert.equal(tools?.value?.bashTimeoutMs, 45000, 'from the running configuration')
    assert.equal(typeof view.body.documentError, 'string', 'and says why the patch could not be read')
    assert.match(view.body.documentError, /is not valid YAML/)
    assert.match(view.body.documentError, /line \d+/, 'naming the line')
    assert.ok(!view.text.includes(SECRET), 'no line of the file crosses to the browser')
    const one = await call(server, 'GET', '/api/settings/tools')
    assert.equal(one.status, 200, 'one entry answers too')

    const write = await call(server, 'POST', '/api/settings/tools', { update: { bashTimeoutMs: 50000 } })
    assert.equal(write.status, 422, 'a write is refused')
    assert.match(write.body?.error ?? '', /is not valid YAML/, 'with the same reason')
    assert.ok(!write.text.includes(SECRET), 'quoting none of the file')
    assert.equal(readFileSync(patchFile, 'utf8'), broken, 'and the file stays as the person left it')
  } finally {
    server.kill()
    removeDir(home)
  }
})
