// A settings write is validated against the row's configuration schema before anything is written, as DSH's settings
// service "validates edits against the full plugin Config before delegating persistence" (issue #125). A wrongly typed
// or out-of-range value is refused with 422 settings-rejected naming the field, the profile patch is left as it was,
// and the server still starts again on the same home. A valid write is kept. Runs against whichever harness
// HEDDLE_BIN names, or the TypeScript build, on a scratch profile.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

/** The shipped tree with absolute row names, as the profile's own patch, so a write lands in this scratch file. */
function scratchProfile(home) {
  const profile = join(home, 'settings-validate-profile')
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
          resolvePromise({
            base: match[1],
            token: match[2],
            output: () => output,
            stop: () => new Promise((done) => {
              if (child.exitCode !== null || child.signalCode !== null) return done()
              child.once('exit', () => done())
              child.kill('SIGKILL')
            }),
          })
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

async function write(server, ns, update) {
  const response = await fetch(`${server.base}/api/settings/${ns}?token=${server.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update }),
  })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: response.status, body, text }
}

test('a wrongly typed or out-of-range settings write is refused before it is written, and the server still restarts', async () => {
  const home = isolatedHome('settings-validate')
  let server
  try {
    const profile = scratchProfile(home)
    const patch = join(profile, 'heddle.patch.yml')
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
    // No --sandbox-root: that overlay would make the sandbox entry not editable, and the check writes to it.
    const args = ['--profile', profile, '--session-root', join(home, 'sessions')]
    server = await startServer(args, env)
    const before = readFileSync(patch, 'utf8')

    for (const [ns, update, field] of [
      ['context', { contextWindow: 'huge' }, 'contextWindow'],
      ['jobs', { maxConcurrentJobsPerOwner: 0 }, 'maxConcurrentJobsPerOwner'],
      ['team', { maxMembers: 'eight' }, 'maxMembers'],
      // A value outside an enum the component's own schema does not spell, judged as the TS Config judges it (#125).
      ['sandbox', { mode: 'yolo' }, 'mode'],
      ['approvals', { unanswered: 'maybe' }, 'unanswered'],
      ['tools', { bashOutputLimit: 0 }, 'bashOutputLimit'],
    ]) {
      const refused = await write(server, ns, update)
      assert.equal(refused.status, 422, `${ns} ${JSON.stringify(update)} is refused\n${refused.text}`)
      assert.equal(refused.body.code, 'settings-rejected')
      assert.match(refused.body.error, new RegExp(field), `the refusal names the field\n${refused.text}`)
      assert.equal(readFileSync(patch, 'utf8'), before, `nothing is written for ${ns}`)
    }

    const kept = await write(server, 'context', { contextWindow: 200000 })
    assert.equal(kept.status, 200, `a valid value is written\n${kept.text}`)
    assert.equal(kept.body.value?.contextWindow, 200000)
    const after = readFileSync(patch, 'utf8')
    assert.ok(after !== before && after.includes('200000'), `into the profile patch\n${after.slice(-400)}`)

    await server.stop()
    server = await startServer(args, env)
    const health = await fetch(`${server.base}/healthz`)
    assert.equal(health.status, 200, `the server starts again on the same home\n${server.output().slice(-400)}`)
  } finally {
    await server?.stop()
    removeDir(home)
  }
})
