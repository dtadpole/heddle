import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * guard.sh, run for real, with the platform's commands replaced by stand-ins.
 *
 * The claim it keeps is narrow and easy to get wrong: **act only when nothing is running the service**. A guard
 * that acted on "the port did not answer" would kick a supervisor that is already restarting the server, which is
 * the race that made three restores 75 s and 15 s apart on 2026-10-22. So the cases here are the ones that tell a
 * guard from a restart loop: port answering, port silent but the job running, port silent and the job gone, and a
 * second run inside the cooldown.
 */

const guard = resolve(fileURLToPath(new URL('../../guard.sh', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-guard-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0

/** A home, a fake checkout, and stand-in curl/launchctl/systemctl that record what they were asked to do. */
function fixture({ job = 'absent', answers = false, kickAnswers = true } = {}) {
  counter += 1
  const base = join(scratch, `case-${counter}`)
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const tools = join(base, 'repo', '_tools_', 'web-daemon')
  for (const dir of [home, bin, tools, join(home, 'Library', 'LaunchAgents'), join(home, '.heddle')]) {
    mkdirSync(dir, { recursive: true })
  }
  copyFileSync(guard, join(tools, 'guard.sh'))
  chmodSync(join(tools, 'guard.sh'), 0o755)
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.dtadpole.heddle-web.plist'), '<plist/>\n')

  const calls = join(base, 'calls.log')
  const answer = join(base, 'answers')
  const jobFile = join(base, 'job')
  if (answers) writeFileSync(answer, '')
  if (job !== 'absent') writeFileSync(jobFile, job)

  const record = (command, body) => {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  // curl: answering when the flag file exists, otherwise a connection failure (exit 7, like curl).
  record('curl', `[ -f "${answer}" ] && exit 0\nexit 7`)
  record(
    'launchctl',
    `case "$1" in
  print)
    if [ ! -f "${jobFile}" ]; then exit 113; fi
    printf '\\tstate = %s\\n' "$(cat "${jobFile}")"
    exit 0
    ;;
  bootstrap) printf 'stopped\\n' > "${jobFile}"; exit 0 ;;
  kickstart) ${kickAnswers ? `touch "${answer}"` : ':'}; exit 0 ;;
esac
exit 0`,
  )
  record(
    'systemctl',
    `case "$*" in
  *is-active*) if [ -f "${jobFile}" ]; then echo active; else echo inactive; exit 3; fi ;;
  *is-enabled*) if [ -f "${jobFile}" ]; then exit 0; else exit 1; fi ;;
  *" start "*) ${kickAnswers ? `touch "${answer}"` : ':'} ;;
esac
exit 0`,
  )
  return { base, home, calls, guard: join(tools, 'guard.sh'), jobFile, answer }
}

function run(f, { platform = 'darwin', args = [], env = {} } = {}) {
  const result = spawnSync('sh', [f.guard, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(f.base, 'bin')}:${process.env.PATH}`,
      HOME: f.home,
      HEDDLE_WEB_PLATFORM: platform,
      // The wait loop sleeps a second between probes; a test does not need ten of them.
      HEDDLE_GUARD_WAIT: '1',
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The commands that *do* something: reads (`curl`, `launchctl print`) are recorded too, and are not actions. */
const calls = (f) =>
  (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean) : []).filter(
    (line) =>
      !line.startsWith('curl ') &&
      !line.startsWith('launchctl print ') &&
      !line.includes('is-active') &&
      !line.includes('is-enabled'),
  )
const log = (f) => {
  const path = join(f.home, '.heddle', 'guard.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('an answering port is left alone: no command is called and nothing is logged', () => {
  const f = fixture({ job: 'running', answers: true })
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(f), [])
  assert.equal(log(f), '')
})

test('a silent port with the job running is left alone: the supervisor is restarting the server, not gone', () => {
  // This is the race fix. Measured 2026-10-22: a port-only guard kicked a supervisor mid-restart, killing the fresh
  // server; three such restores appear in guard.log 75 s and 15 s apart.
  const f = fixture({ job: 'running', answers: false })
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(f), [], 'no kickstart, so the restart in flight is not interrupted')
  assert.equal(log(f), '', 'and the log stays quiet, because there is nothing to report')
})

test('a silent port with the job loaded but not running is kickstarted, and the log says which reading caused it', () => {
  const f = fixture({ job: 'stopped', answers: false })
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(f), ['launchctl kickstart -k gui/' + process.getuid() + '/com.dtadpole.heddle-web'])
  assert.match(log(f), /silent and the agent is loaded but not running; kickstarting it/)
  assert.match(log(f), /answering again/)
})

test('a job that is not loaded is bootstrapped from the plist first, then started', () => {
  const f = fixture({ job: 'absent', answers: false })
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  const recorded = calls(f).map((line) => line.split(' ').slice(0, 2).join(' '))
  assert.deepEqual(recorded, ['launchctl bootstrap', 'launchctl kickstart'], 'bootstrap registers the job, kickstart starts it')
  assert.match(log(f), /the agent is not loaded; bootstrapping/)
})

test('a second run inside the cooldown does not act again, even when it still reads silent', () => {
  const f = fixture({ job: 'stopped', answers: false, kickAnswers: false })
  const first = run(f)
  assert.equal(first.status, 1, 'the first run says plainly that the port did not come back')
  assert.match(log(f), /still silent/)
  const before = calls(f).length
  const second = run(f)
  assert.equal(second.status, 0)
  assert.equal(calls(f).length, before, 'the cooldown stamped the first action, so the second run only reads')
})

test('Linux acts on the unit, not on the port: an active unit is left alone, an inactive one is started', () => {
  const active = fixture({ job: 'active', answers: false })
  assert.equal(run(active, { platform: 'linux' }).status, 0)
  assert.deepEqual(calls(active), [], 'systemd owns the restart; a silent port there is a process starting')

  const inactive = fixture({ job: 'absent', answers: false })
  const result = run(inactive, { platform: 'linux' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(inactive).map((line) => line.split(' ').slice(0, 2).join(' ')), ['systemctl --user'])
  assert.match(log(inactive), /heddle-web\.service is not active; starting it/)
})

test('a platform with no supervisor, and --status, are answered rather than guessed', () => {
  const f = fixture({ job: 'running', answers: true })
  assert.equal(run(f, { platform: 'Plan9' }).status, 2)
  const status = run(f, { args: ['--status'] })
  assert.equal(status.status, 0)
  assert.match(status.stdout, /port 3082: answering/)
  assert.match(status.stdout, /service: running/)
  assert.deepEqual(calls(f).filter((line) => !line.startsWith('launchctl print')), [])
})

test('an answering port with the agent loaded but not running is an unsupervised server, and gets its supervisor back', () => {
  // Measured 2026-10-22 on a scratch agent: with AbandonProcessGroup a SIGKILLed supervisor leaves its server
  // answering while launchd reads the job "not running" and never restarts it, so nothing would restart that server
  // after its next crash. Starting the job lets a new supervisor reclaim it.
  const f = fixture({ job: 'not running', answers: true })
  const result = run(f)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(f), ['launchctl kickstart gui/' + process.getuid() + '/com.dtadpole.heddle-web'])
  assert.match(log(f), /answering but the agent is not running \(an unsupervised server\)/)
  const again = run(f)
  assert.equal(again.status, 0)
  assert.equal(calls(f).length, 1, 'inside the cooldown it does not act twice')
})

test('an answering port is left alone while the agent runs, and while it is not loaded at all (an install in progress)', () => {
  const running = fixture({ job: 'running', answers: true })
  run(running)
  assert.deepEqual(calls(running), [])
  const absent = fixture({ job: 'absent', answers: true })
  run(absent)
  assert.deepEqual(calls(absent), [], 'not loaded is the installer between bootout and bootstrap: leave it')
  assert.equal(log(absent), '')
})
