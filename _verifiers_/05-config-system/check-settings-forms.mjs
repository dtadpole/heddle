// GET /api/settings answers each built-in row's schema as DSH's form projection (issue #123): the normalized
// Schemastery serialization a settings page builds its forms from, with types, defaults and limits, and the same bytes
// on both builds. The reference is rust/crates/heddle-config/src/builtin_forms.json, which src/config/builtin-forms.ts
// generates from the TypeScript Configs (and test/builtin-forms.test.ts keeps current), with $HEDDLE_HOME resolved
// against this run's home. A row whose plugin declares no Config answers null. Runs against whichever harness
// HEDDLE_BIN names, or the TypeScript build, on a scratch profile; nothing is written.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

function scratchProfile(home) {
  const profile = join(home, 'settings-forms-profile')
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
function expectedForms(heddleHome) {
  const text = readFileSync(join(repoRoot, 'rust', 'crates', 'heddle-config', 'src', 'builtin_forms.json'), 'utf8')
  return JSON.parse(text, (key, value) => (typeof value === 'string' && value.startsWith('$HEDDLE_HOME') ? join(heddleHome, value.slice('$HEDDLE_HOME'.length)) : value))
}

test('every built-in row\'s schema is DSH\'s form projection, the same bytes on both builds', async () => {
  const home = isolatedHome('settings-forms')
  let server
  try {
    const heddleHome = join(home, '.heddle')
    const env = { HOME: home, HEDDLE_HOME: heddleHome, HEDDLE_CONFIG: join(home, 'heddle.json') }
    server = await startServer(['--profile', scratchProfile(home), '--sandbox-root', home], env)
    const response = await fetch(`${server.base}/api/settings?token=${server.token}`)
    assert.equal(response.status, 200)
    const view = await response.json()
    const forms = expectedForms(heddleHome)
    const checked = []
    for (const entry of view.namespaces) {
      const module = /\/src\/(.+)\.ts$/.exec(entry.component)?.[1]
      if (module === undefined) continue
      const expected = forms[module] ?? null
      assert.deepEqual(entry.schema, expected, `entry '${entry.ns}' (${module}) answers its form projection`)
      checked.push(entry.ns)
    }
    assert.ok(checked.length >= 15, `the shipped rows were checked (${checked.join(', ')})`)
    for (const ns of ['model', 'context', 'goal', 'subagent-tool', 'schedule', 'jobs', 'team']) {
      const entry = view.namespaces.find((candidate) => candidate.ns === ns)
      assert.ok(entry?.schema?.refs !== undefined, `'${ns}' has a projection, not a plain or null schema`)
    }
    const jobs = view.namespaces.find((entry) => entry.ns === 'jobs').schema
    const root = jobs.refs[String(jobs.uid)]
    assert.deepEqual(jobs.refs[String(root.dict.maxConcurrentJobsPerOwner)].meta, { step: 1, min: 1, default: 10 }, 'limits and defaults travel with it')
  } finally {
    server?.kill()
    removeDir(home)
  }
})
