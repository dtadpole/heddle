import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { UNIT, describeCommand, parseUnit, splitCommandLine, unitValue } from '../../service.mjs'

/**
 * install.sh, run for real, in throwaway checkouts.
 *
 * Each fixture is a git repository holding a copy of the installer and both templates at
 * `_tools_/web-daemon/`, so the script resolves that repository as its checkout exactly as it resolves the real
 * one. launchctl, systemctl and loginctl are stand-ins on PATH that record their arguments, which lets both
 * platform branches run on one machine without touching its real services.
 */

const daemon = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-web-daemon-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const gitEnv = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
}
let counter = 0

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv, HOME: scratch } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A committed checkout on main with the installer in it, a built CLI, a home and stand-in supervisors. */
function fixture({ name = 'repo' } = {}) {
  counter += 1
  const base = join(scratch, `case-${counter}`)
  const repo = join(base, name)
  const tools = join(repo, '_tools_', 'web-daemon')
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  for (const dir of [tools, join(repo, 'dist'), home, bin]) mkdirSync(dir, { recursive: true })
  for (const file of ['install.sh', 'heddle-web.plist.template', 'heddle-web.service.template']) copyFileSync(join(daemon, file), join(tools, file))
  chmodSync(join(tools, 'install.sh'), 0o755)
  writeFileSync(join(repo, 'cordis.yml'), '[]\n')
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  writeFileSync(join(repo, 'dist', 'cli.js'), '// built\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'fixture')

  const calls = join(base, 'calls.log')
  const record = (command, body = '') => {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> "${calls}"\n${body}exit 0\n`)
    chmodSync(join(bin, command), 0o755)
  }
  // Not running, so an install never takes the replace path by accident; `print` fails as for an absent job.
  record('systemctl', 'case "$*" in *is-active*) exit 3;; esac\n')
  record('launchctl', 'case "$1" in print) exit 113;; esac\n')
  record('loginctl', 'echo "${FAKE_LINGER:-yes}"\n')
  // The account's crontab, kept in a file so the --guard edits can be read back like a real one.
  record(
    'crontab',
    'if [ "$1" = "-l" ]; then [ -f "$CRONTAB_FILE" ] && cat "$CRONTAB_FILE"; exit 0; fi\ncat > "$CRONTAB_FILE"\n',
  )

  const heddleBin = join(base, 'heddle')
  writeFileSync(heddleBin, '#!/bin/sh\nexit 0\n')
  chmodSync(heddleBin, 0o755)
  return { base, repo, home, bin, calls, heddleBin, installer: join(tools, 'install.sh') }
}

function install(f, args, env = {}) {
  const result = spawnSync('sh', [f.installer, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.home,
      HEDDLE_NODE: process.execPath,
      ...gitEnv,
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const calls = (f) => (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n') : [])

test('Linux renders a unit whose ExecStart runs node on the checkout\'s CLI, read back by the same reader the verifiers use', () => {
  const f = fixture()
  const { status, stdout, stderr } = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(status, 0, stderr)
  assert.doesNotMatch(stdout, /@[A-Z_]+@/, 'no placeholder is left unfilled')
  const sections = parseUnit(stdout)
  const exec = unitValue(sections, 'Service', 'ExecStart')
  assert.equal(exec, `${process.execPath} ${f.repo}/dist/cli.js web --host 127.0.0.1 --port 8082 --config ${f.repo}/cordis.yml`, 'Linux defaults to 8082')
  const described = describeCommand(splitCommandLine(exec), unitValue(sections, 'Service', 'WorkingDirectory'))
  assert.equal(described.root, f.repo)
  assert.equal(described.entry, `${f.repo}/dist/cli.js`)
  assert.equal(described.port, 8082)
  assert.equal(unitValue(sections, 'Service', 'Restart'), 'always', 'a kill is restarted like any exit')
  assert.equal(unitValue(sections, 'Unit', 'StartLimitIntervalSec'), '0', 'and the supervisor never gives up')
  assert.equal(unitValue(sections, 'Service', 'StandardOutput'), `append:${f.home}/.heddle/web.log`)
  assert.deepEqual(sections.Service.Environment.slice(0, 2), [`HEDDLE_HOME=${f.home}/.heddle`, `HOME=${f.home}`])
  assert.equal(unitValue(sections, 'Install', 'WantedBy'), 'default.target', 'enabled units start with the user manager')
  assert.deepEqual(calls(f), [], '--print changes nothing and calls no supervisor')
})

test('HEDDLE_BIN makes the binary the program on both platforms, and HEDDLE_WEB_PORT the port', () => {
  const f = fixture()
  const linux = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux', HEDDLE_BIN: f.heddleBin, HEDDLE_WEB_PORT: '9911' })
  assert.equal(linux.status, 0, linux.stderr)
  const exec = unitValue(parseUnit(linux.stdout), 'Service', 'ExecStart')
  assert.equal(exec, `${f.heddleBin} web --host 127.0.0.1 --port 9911 --config ${f.repo}/cordis.yml`)
  assert.doesNotMatch(linux.stdout, /dist\/cli\.js/, 'no node, no CLI')

  const darwin = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'darwin', HEDDLE_BIN: f.heddleBin, HEDDLE_WEB_SUPERVISOR: '0' })
  assert.equal(darwin.status, 0, darwin.stderr)
  assert.doesNotMatch(darwin.stdout, /@[A-Z_]+@/)
  const args = [...darwin.stdout.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(args, [f.heddleBin, 'web', '--host', '127.0.0.1', '--port', '3082', '--config', `${f.repo}/cordis.yml`], 'the CLI line is dropped, not left empty, and macOS keeps 3082')
})

test('macOS renders the supervisor in front of the server, and asks not to only when told', () => {
  const f = fixture()
  const { status, stdout, stderr } = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'darwin' })
  assert.equal(status, 0, stderr)
  const args = [...stdout.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  const supervisor = join(f.repo, '_tools_', 'web-daemon', 'supervisor.mjs')
  assert.deepEqual(args, [process.execPath, supervisor, '--', process.execPath, `${f.repo}/dist/cli.js`, 'web', '--host', '127.0.0.1', '--port', '3082', '--config', `${f.repo}/cordis.yml`], 'launchd runs the supervisor, which runs the server')

  const bare = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'darwin', HEDDLE_WEB_SUPERVISOR: '0' })
  assert.equal(bare.status, 0, bare.stderr)
  const direct = [...bare.stdout.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(direct.slice(0, 3), [process.execPath, `${f.repo}/dist/cli.js`, 'web'], 'the platform alone, for a host whose launchd restarts jobs')

  const linux = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.doesNotMatch(unitValue(parseUnit(linux.stdout), 'Service', 'ExecStart'), /supervisor\.mjs/, 'systemd already restarts the process, so Linux gets no extra layer')
})

test('a bad program is refused before anything is written', () => {
  const f = fixture()
  const relative = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux', HEDDLE_BIN: 'rust/target/release/heddle' })
  assert.equal(relative.status, 2)
  assert.match(relative.stderr, /absolute path/)
  const missing = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux', HEDDLE_BIN: join(f.base, 'absent') })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /not an executable file/)
  rmSync(join(f.repo, 'dist'), { recursive: true })
  const unbuilt = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(unbuilt.status, 2)
  assert.match(unbuilt.stderr, /npm run build/)
})

test('Linux refuses a path systemd would split on whitespace; macOS does not need to', () => {
  const f = fixture({ name: 'with space' })
  const linux = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(linux.status, 2)
  assert.match(linux.stderr, /whitespace/)
  assert.equal(install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'darwin' }).status, 0, 'a plist carries one argument per element')
})

test('only committed main is installable: main at its tip, or detached exactly at origin/main', () => {
  const f = fixture()
  const linux = { HEDDLE_WEB_PLATFORM: 'linux' }
  assert.equal(install(f, ['--print'], linux).status, 0, 'a clean main')

  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(f.repo, 'checkout', '-q', '--detach')
  assert.equal(install(f, ['--print'], linux).status, 0, 'detached at origin/main is the deployment worktree shape')

  writeFileSync(join(f.repo, 'later.txt'), 'x\n')
  git(f.repo, 'add', 'later.txt')
  git(f.repo, 'commit', '-q', '-m', 'local commit')
  const ahead = install(f, ['--print'], linux)
  assert.equal(ahead.status, 2, 'detached anywhere else is not main')
  assert.match(ahead.stderr, /not origin\/main/)

  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main')
  const unfetched = install(f, ['--print'], linux)
  assert.equal(unfetched.status, 2)
  assert.match(unfetched.stderr, /no such ref/, 'a detached checkout with nothing to be held to is refused')

  git(f.repo, 'checkout', '-q', '-b', 'feature')
  const branch = install(f, ['--print'], linux)
  assert.equal(branch.status, 2)
  assert.match(branch.stderr, /on 'feature', not main/)

  git(f.repo, 'checkout', '-q', 'main')
  writeFileSync(join(f.repo, 'cordis.yml'), '[] # edited\n')
  const dirty = install(f, ['--print'], linux)
  assert.equal(dirty.status, 2)
  assert.match(dirty.stderr, /uncommitted changes/)
  assert.equal(install(f, ['--print'], { ...linux, HEDDLE_ALLOW_DIRTY_INSTALL: '1' }).status, 0, 'the development override still exists')
})

test('Linux install writes the unit, reloads, enables and restarts it, and a second run changes nothing else', () => {
  const f = fixture()
  const first = install(f, [], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(first.status, 0, first.stderr)
  const target = join(f.home, '.config', 'systemd', 'user', UNIT)
  assert.ok(existsSync(target), 'the unit is in the user manager\'s directory')
  assert.ok(existsSync(join(f.home, '.heddle')), 'and the log directory exists before systemd appends to it')
  const written = readFileSync(target, 'utf8')
  assert.deepEqual(calls(f), [
    'loginctl show-user ' + spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim() + ' -p Linger --value',
    'systemctl --user daemon-reload',
    `systemctl --user enable --quiet ${UNIT}`,
    `systemctl --user restart ${UNIT}`,
  ], 'restart, not start, so a running service picks up the new definition')
  assert.match(first.stdout, /grep -o 'token=/, 'and it says where the launch token is')

  const second = install(f, [], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(readFileSync(target, 'utf8'), written, 'idempotent: the same file, not a second one')
})

test('Linux install honours XDG_CONFIG_HOME and refuses an account that does not linger', () => {
  const f = fixture()
  const xdg = join(f.base, 'xdg')
  assert.equal(install(f, [], { HEDDLE_WEB_PLATFORM: 'linux', XDG_CONFIG_HOME: xdg }).status, 0)
  assert.ok(existsSync(join(xdg, 'systemd', 'user', UNIT)))

  const g = fixture()
  const refused = install(g, [], { HEDDLE_WEB_PLATFORM: 'linux', FAKE_LINGER: 'no' })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /enable-linger/)
  assert.ok(!existsSync(join(g.home, '.config', 'systemd', 'user', UNIT)), 'nothing is written')
  assert.ok(calls(g).every((line) => !line.startsWith('systemctl')), 'and systemd is not touched')
  assert.equal(install(g, [], { HEDDLE_WEB_PLATFORM: 'linux', FAKE_LINGER: 'no', HEDDLE_ALLOW_NO_LINGER: '1' }).status, 0, 'unless overridden')
})

test('a refused reinstall leaves the installed unit as it was', () => {
  const f = fixture()
  assert.equal(install(f, [], { HEDDLE_WEB_PLATFORM: 'linux' }).status, 0)
  const target = join(f.home, '.config', 'systemd', 'user', UNIT)
  const before = readFileSync(target, 'utf8')
  writeFileSync(join(f.repo, 'cordis.yml'), '[] # edited\n')
  assert.equal(install(f, ['--restart'], { HEDDLE_WEB_PLATFORM: 'linux' }).status, 2)
  assert.equal(readFileSync(target, 'utf8'), before, 'rendered first, written only when the render succeeded')
})

test('Linux uninstall disables and stops the unit, removes it and reloads', () => {
  const f = fixture()
  assert.equal(install(f, [], { HEDDLE_WEB_PLATFORM: 'linux' }).status, 0)
  rmSync(f.calls)
  const removed = install(f, ['--uninstall'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(removed.status, 0, removed.stderr)
  assert.ok(!existsSync(join(f.home, '.config', 'systemd', 'user', UNIT)))
  assert.deepEqual(calls(f), [`systemctl --user disable --now ${UNIT}`, 'systemctl --user daemon-reload'])
})

test('macOS install writes the agent, bootstraps it and starts it on demand', () => {
  const f = fixture()
  const result = install(f, [], { HEDDLE_WEB_PLATFORM: 'darwin' })
  assert.equal(result.status, 0, result.stderr)
  const target = join(f.home, 'Library', 'LaunchAgents', 'com.dtadpole.heddle-web.plist')
  assert.ok(existsSync(target))
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()
  assert.deepEqual(calls(f), [
    `launchctl print gui/${uid}/com.dtadpole.heddle-web`,
    `launchctl bootstrap gui/${uid} ${target}`,
    `launchctl kickstart -k gui/${uid}/com.dtadpole.heddle-web`,
  ], 'bootstrap registers the job; kickstart is what starts it on a host whose launchd leaves a nondemand spawn pending')
})

test('a template names its placeholders only where they are filled, never in a comment', () => {
  // sed fills every occurrence, so a placeholder named in a comment becomes a path in the explanation — measured:
  // the unit's header comment named the program placeholder and rendered a HEDDLE_BIN unit that mentioned dist/cli.js.
  const unitTemplate = readFileSync(join(daemon, 'heddle-web.service.template'), 'utf8')
  const commented = unitTemplate.split('\n').filter((line) => line.trimStart().startsWith('#') && /@[A-Z_]+@/.test(line))
  assert.deepEqual(commented, [], 'no comment line in the unit template carries a placeholder')
  const plistTemplate = readFileSync(join(daemon, 'heddle-web.plist.template'), 'utf8')
  const comments = [...plistTemplate.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).filter((text) => /@[A-Z_]+@/.test(text))
  assert.deepEqual(comments, [], 'nor any comment in the plist template')
})

test('the guard is one cron line, added once, removed by itself, and never a surprise', () => {
  const f = fixture()
  const file = join(f.base, 'crontab')
  const env = { HEDDLE_WEB_PLATFORM: 'darwin', CRONTAB_FILE: file }
  const line = `* * * * * /bin/sh ${f.repo}/_tools_/web-daemon/guard.sh >/dev/null 2>&1`

  assert.equal(install(f, [], env).status, 0, 'installing the service does not edit the crontab')
  assert.ok(!existsSync(file), 'no cron entry is written without --guard')

  const first = install(f, ['--guard'], env)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(readFileSync(file, 'utf8').trim(), line, 'one line, naming this checkout\'s guard')

  assert.equal(install(f, ['--guard'], env).status, 0)
  assert.equal(readFileSync(file, 'utf8').trim(), line, 'running it twice leaves one line, not two')

  writeFileSync(file, `0 3 * * * /bin/true\n${line}\n`)
  assert.equal(install(f, ['--guard-uninstall'], env).status, 0)
  assert.equal(readFileSync(file, 'utf8').trim(), '0 3 * * * /bin/true', 'uninstalling removes that line and nothing else')
})

test('an unknown platform and an unknown option are refused', () => {
  const f = fixture()
  const platform = install(f, ['--print'], { HEDDLE_WEB_PLATFORM: 'Plan9' })
  assert.equal(platform.status, 2)
  assert.match(platform.stderr, /no supervisor for platform 'Plan9'/)
  const option = install(f, ['--frobnicate'], { HEDDLE_WEB_PLATFORM: 'linux' })
  assert.equal(option.status, 2)
  assert.match(option.stderr, /unknown option --frobnicate/)
})
