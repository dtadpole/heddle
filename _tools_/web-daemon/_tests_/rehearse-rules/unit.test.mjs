import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * rehearse.sh's refusals: what keeps a rehearsal from becoming an experiment on the deployment.
 *
 * The rehearsal itself needs a real launchd and is judged by running it on the host (the measurements are in the
 * deployment record). What can be judged anywhere is the part that must never fail open: a rehearsal pointed at the
 * deployment's label or ports, or at a port something already answers on, refuses **before it calls anything**.
 * The platform commands here are stand-ins that record every call, so "touched nothing" is read, not assumed.
 */

const daemon = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-rehearse-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0

function fixture({ portAnswers = false } = {}) {
  counter += 1
  const base = join(scratch, `case-${counter}`)
  const tools = join(base, 'repo', '_tools_', 'web-daemon')
  const bin = join(base, 'bin')
  const home = join(base, 'home')
  const tmp = join(base, 'tmp')
  for (const dir of [tools, bin, home, tmp]) mkdirSync(dir, { recursive: true })
  for (const file of ['rehearse.sh', 'install.sh', 'guard.sh']) copyFileSync(join(daemon, file), join(tools, file))
  const calls = join(base, 'calls.log')
  const record = (command, body) => {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  record('curl', portAnswers ? 'exit 0' : 'exit 7')
  record('launchctl', 'exit 0')
  record('systemctl', 'exit 0')
  record('lsof', 'exit 0')
  return { base, home, tmp, calls, script: join(tools, 'rehearse.sh') }
}

function run(f, args = [], env = {}) {
  const result = spawnSync('sh', [f.script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${join(f.base, 'bin')}:${process.env.PATH}`, HOME: f.home, TMPDIR: f.tmp, HEDDLE_WEB_PLATFORM: 'darwin', ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Every recorded call except the port probe, which is a read. */
const actions = (f) =>
  (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean) : []).filter((line) => !line.startsWith('curl '))

test('the deployment label and unit are refused, and nothing is called', () => {
  const f = fixture()
  const label = run(f, [], { HEDDLE_REHEARSE_LABEL: 'com.dtadpole.heddle-web' })
  assert.equal(label.status, 2)
  assert.match(label.stderr, /the label com\.dtadpole\.heddle-web is the deployment's/)
  const unit = run(f, [], { HEDDLE_REHEARSE_UNIT: 'heddle-web.service' })
  assert.equal(unit.status, 2)
  assert.match(unit.stderr, /the unit heddle-web\.service is the deployment's/)
  assert.deepEqual(actions(f), [])
})

test('the deployment ports and a port that is not a number are refused, and nothing is called', () => {
  const f = fixture()
  for (const port of ['3082', '8082']) {
    const result = run(f, [], { HEDDLE_REHEARSE_PORT: port })
    assert.equal(result.status, 2, port)
    assert.match(result.stderr, new RegExp(`port ${port} belongs to the deployment`))
  }
  const word = run(f, [], { HEDDLE_REHEARSE_PORT: 'eighty' })
  assert.equal(word.status, 2)
  assert.match(word.stderr, /must be a number/)
  assert.deepEqual(actions(f), [])
})

test('a port something already answers on is refused before anything is installed', () => {
  const f = fixture({ portAnswers: true })
  const result = run(f)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /something already answers on port 3096/)
  assert.deepEqual(actions(f), [], 'no launchctl call: the rehearsal never reached the installer')
  assert.ok(!existsSync(join(f.home, 'Library', 'LaunchAgents')), 'and no agent file was written')
})

test('--cleanup with nothing to clean says so, and an unknown option is refused', () => {
  const f = fixture()
  const clean = run(f, ['--cleanup'])
  assert.equal(clean.status, 0)
  assert.match(clean.stdout, /no rehearsal to clean up/)
  const unknown = run(f, ['--frobnicate'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown option --frobnicate/)
  assert.deepEqual(actions(f), [])
})

test('a host with no supervisor command cannot be judged, and says so with exit 3', () => {
  const f = fixture()
  const result = run(f, [], { HEDDLE_WEB_PLATFORM: 'Plan9' })
  assert.equal(result.status, 3)
  assert.match(result.stderr, /no supervisor for platform 'Plan9'/)
})
