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
  for (const file of ['rehearse.sh', 'install.sh', 'guard.sh', 'heddle-web.plist.template', 'heddle-web.service.template', 'supervisor.mjs']) {
    copyFileSync(join(daemon, file), join(tools, file))
  }
  // A built checkout, so the installer can render a definition for the scratch service.
  mkdirSync(join(base, 'repo', 'dist'), { recursive: true })
  writeFileSync(join(base, 'repo', 'dist', 'cli.js'), '// built\n')
  writeFileSync(join(base, 'repo', 'cordis.yml'), '[]\n')
  const calls = join(base, 'calls.log')
  const record = (command, body) => {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  record('curl', portAnswers ? 'exit 0' : 'exit 7')
  // `print` answers "not loaded", so the installer never waits out a bootout that a stand-in cannot complete.
  record('launchctl', 'case "$1" in print) exit 113 ;; esac\nexit 0')
  record('systemctl', 'exit 0')
  record('lsof', 'exit 0')
  return { base, home, tmp, calls, script: join(tools, 'rehearse.sh') }
}

function run(f, args = [], env = {}) {
  const result = spawnSync('sh', [f.script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(f.base, 'bin')}:${process.env.PATH}`,
      HOME: f.home,
      TMPDIR: f.tmp,
      HEDDLE_WEB_PLATFORM: 'darwin',
      HEDDLE_NODE: process.execPath,
      ...env,
    },
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

test('a service that never answers fails "started", leaves the rest unjudged with the reason, and removes what it installed', () => {
  // Measured 2026-10-23 with the Rust binary, whose `web` exits 2: the rehearsal must answer in seconds, say why, and
  // not spend a minute failing claims that were never in question.
  const f = fixture()
  const result = run(f, [], { HEDDLE_REHEARSE_START_MS: '1500' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /started\s+failed\s+no answer within 1 s/)
  for (const claim of ['kill', 'guard', 'reinstall', 'agent gone', '95-web-daemon']) {
    assert.match(result.stdout, new RegExp(`${claim}\\s+unjudged\\s+no server to judge`), claim)
  }
  assert.match(result.stdout, /verdict: 0 held, 1 failed, 5 unjudged/)
  const verbs = actions(f).filter((line) => line.startsWith('launchctl ')).map((line) => line.split(' ')[1])
  assert.ok(verbs.includes('bootstrap') && verbs.includes('kickstart'), 'the scratch agent was installed')
  assert.ok(actions(f).every((line) => !line.endsWith('/com.dtadpole.heddle-web')), 'no call named the deployment label')
  assert.ok(!existsSync(join(f.home, 'Library', 'LaunchAgents', 'com.dtadpole.heddle-web.rehearsal.plist')), 'and the scratch agent file was removed')
  assert.ok(!existsSync(join(f.tmp, `heddle-rehearsal.${process.getuid()}.home`)), 'with its state record')
})
