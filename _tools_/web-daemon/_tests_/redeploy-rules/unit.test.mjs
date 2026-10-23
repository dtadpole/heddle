import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * redeploy.sh, run for real against throwaway git repositories.
 *
 * Each fixture is an origin (bare), and a deployment clone detached one commit behind it. The deployment's own
 * `install.sh` and `96-deployment` are stand-ins that record their calls, as are `npm` and `curl`, so the order of the
 * steps — the thing the script exists to fix — is read from the calls, not assumed. The second commit also changes
 * redeploy.sh itself, which is what a `git checkout` does to a script that is still being read.
 */

const script = resolve(fileURLToPath(new URL('../../redeploy.sh', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-redeploy-'))
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

function fixture({ change = 'tooling' } = {}) {
  counter += 1
  const base = join(scratch, `case-${counter}`)
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  const deploy = join(base, 'deploy')
  const bin = join(base, 'bin')
  const calls = join(base, 'calls.log')
  mkdirSync(bin, { recursive: true })
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, work)

  const tools = join(work, '_tools_', 'web-daemon')
  const verifier = join(work, '_verifiers_', '96-deployment')
  mkdirSync(tools, { recursive: true })
  mkdirSync(verifier, { recursive: true })
  copyFileSync(script, join(tools, 'redeploy.sh'))
  writeFileSync(join(tools, 'install.sh'), `#!/bin/sh\necho "install $*" >> "${calls}"\nexit "\${FAKE_INSTALL_EXIT:-0}"\n`)
  writeFileSync(
    join(verifier, 'verify.sh'),
    `#!/bin/sh\necho "verify $*" >> "${calls}"\necho '{"check":"x","verdict":'"\${FAKE_96:-0}"',"tests":3,"pass":3,"fail":0}'\n`,
  )
  writeFileSync(join(work, '.gitignore'), 'dist/\nnode_modules/\n')
  writeFileSync(join(work, 'README'), 'first\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'push', '-q', 'origin', 'main')
  const first = git(work, 'rev-parse', 'HEAD')

  // What the second commit on main changes decides whether the running server is stale.
  if (change === 'tooling') {
    writeFileSync(join(work, 'README'), 'second\n')
    writeFileSync(join(tools, 'redeploy.sh'), `${readFileSync(join(tools, 'redeploy.sh'), 'utf8')}\n# changed on main\n`)
  } else if (change === 'inert') {
    // The Rust port, a verifier, another tool and a document: nothing the server loads at start.
    for (const [path, body] of [['rust/notes.rs', '// rust\n'], ['_verifiers_/96-deployment/notes.md', 'notes\n'], ['_tools_/other/run.sh', 'echo\n'], ['GUIDE.md', 'guide\n']]) {
      mkdirSync(join(work, path, '..'), { recursive: true })
      writeFileSync(join(work, path), body)
    }
  } else if (change === 'src') {
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'server.ts'), 'export {}\n')
  }
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'second')
  git(work, 'push', '-q', 'origin', 'main')
  const second = git(work, 'rev-parse', 'HEAD')

  git(base, 'clone', '-q', origin, deploy)
  git(deploy, 'checkout', '-q', '--detach', first)

  const record = (command, body) => {
    writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> "${calls}"\n${body}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  record('npm', 'exit "${FAKE_NPM_EXIT:-0}"')
  record('curl', 'exit 0')
  return { base, work, deploy, calls, first, second }
}

function redeploy(f, args = [], env = {}, from = null) {
  const result = spawnSync('sh', [from ?? join(f.deploy, '_tools_', 'web-daemon', 'redeploy.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...gitEnv, PATH: `${join(f.base, 'bin')}:${process.env.PATH}`, HOME: scratch, TMPDIR: f.base, ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const calls = (f) => (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean) : [])
const head = (f) => git(f.deploy, 'rev-parse', 'HEAD')

test('a deployment behind origin/main is moved, built, installed with its own new installer, then judged — in that order', () => {
  const f = fixture()
  const result = redeploy(f)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(head(f), f.second, 'the checkout is at the fetched tip')
  assert.deepEqual(calls(f), [
    'npm ci --no-audit --no-fund --silent',
    'npm run --silent build',
    'install --restart',
    'curl -fsS -m 1 http://127.0.0.1:3082/healthz',
    'verify --json',
  ], 'the port is probed after the install and before the verdict')
  assert.match(result.stdout, /moving [0-9a-f]{7} -> [0-9a-f]{7}/)
  assert.match(result.stdout, /96-deployment 3\/3 held/)
  assert.equal(git(f.deploy, 'status', '--porcelain'), '', 'and it is still clean')
  assert.ok(readdirTmp(f).length === 0, 'the private copy of the script is removed')
})

test('--check says the deployment is behind and changes nothing', () => {
  const f = fixture()
  const result = redeploy(f, ['--check'])
  assert.equal(result.status, 10)
  assert.match(result.stdout, /behind: deployment [0-9a-f]{7}, origin\/main [0-9a-f]{7} \(1 commits\)/)
  assert.equal(head(f), f.first)
  assert.deepEqual(calls(f), [])
})

test('a current deployment is judged and not rebuilt or restarted', () => {
  const f = fixture()
  git(f.deploy, 'checkout', '-q', '--detach', f.second)
  const result = redeploy(f)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls(f), ['curl -fsS -m 1 http://127.0.0.1:3082/healthz', 'verify --json'], 'no build and no restart: the live service is left alone')
  assert.match(result.stdout, /already at origin\/main/)
  assert.equal(redeploy(f, ['--check']).status, 0)
})

test('an edited deployment is refused before anything happens', () => {
  const f = fixture()
  writeFileSync(join(f.deploy, 'README'), 'edited by hand\n')
  const result = redeploy(f)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /uncommitted changes; a deployment checkout is never edited/)
  assert.equal(head(f), f.first)
  assert.deepEqual(calls(f), [])
  assert.equal(readFileSync(join(f.deploy, 'README'), 'utf8'), 'edited by hand\n', 'and the edit is not discarded')
})

test('a failed build stops before the installer, so the service keeps its previous build', () => {
  const f = fixture()
  const result = redeploy(f, [], { FAKE_NPM_EXIT: '1' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /the build failed .* the service still runs the previous build/)
  assert.ok(calls(f).every((line) => !line.startsWith('install')), 'install.sh was not run')
})

test('a refused install and a failing 96 both exit 1', () => {
  const refused = fixture()
  const install = redeploy(refused, [], { FAKE_INSTALL_EXIT: '2' })
  assert.equal(install.status, 1)
  assert.match(install.stderr, /install\.sh refused or failed/)
  assert.ok(calls(refused).every((line) => !line.startsWith('verify')), 'nothing is judged after a failed install')

  const failing = fixture()
  const judged = redeploy(failing, [], { FAKE_96: '1' })
  assert.equal(judged.status, 1)
  assert.match(judged.stdout, /96-deployment verdict 1/)
})

test('with HEDDLE_BIN there is no npm build, and --repo acts on another checkout with that checkout\'s installer', () => {
  const f = fixture()
  const fromWork = join(f.work, '_tools_', 'web-daemon', 'redeploy.sh')
  const result = redeploy(f, ['--repo', f.deploy], { HEDDLE_BIN: '/opt/heddle/bin/heddle' }, fromWork)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(head(f), f.second, 'the deployment named by --repo moved, not the checkout the script came from')
  assert.deepEqual(calls(f), ['install --restart', 'curl -fsS -m 1 http://127.0.0.1:3082/healthz', 'verify --json'])
})

test('an unknown option is refused', () => {
  const f = fixture()
  const result = redeploy(f, ['--frobnicate'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option --frobnicate/)
  assert.deepEqual(calls(f), [])
})

/** Temporary copies the script made of itself, which it must remove on exit. */
function readdirTmp(f) {
  const listing = spawnSync('ls', [f.base], { encoding: 'utf8' }).stdout.split('\n')
  return listing.filter((name) => name.startsWith('heddle-redeploy.'))
}

const probe = 'curl -fsS -m 1 http://127.0.0.1:3082/healthz'
const full = ['npm ci --no-audit --no-fund --silent', 'npm run --silent build', 'install --restart', probe, 'verify --json']
const built = (f) => {
  mkdirSync(join(f.deploy, 'dist'), { recursive: true })
  writeFileSync(join(f.deploy, 'dist', 'cli.js'), '// built\n')
}

test('a move that changes nothing the server loads at start moves the checkout and judges it, without a rebuild or a restart', () => {
  const f = fixture({ change: 'inert' })
  built(f)
  const result = redeploy(f)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(head(f), f.second, 'the checkout is at the tip, so 96 can hold')
  assert.deepEqual(calls(f), [probe, 'verify --json'], 'no npm and no install: the live server and its launch token are left alone')
  assert.match(result.stdout, /nothing the server loads at start changed, so no rebuild or restart/)
})

test('the same inert move rebuilds and restarts when there is no build, with --force, or for a binary', () => {
  const unbuilt = fixture({ change: 'inert' })
  assert.equal(redeploy(unbuilt).status, 0)
  assert.deepEqual(calls(unbuilt), full, 'no dist/cli.js: nothing to keep serving, so the full path')

  const forced = fixture({ change: 'inert' })
  built(forced)
  assert.equal(redeploy(forced, ['--force']).status, 0)
  assert.deepEqual(calls(forced), full)

  const binary = fixture({ change: 'inert' })
  built(binary)
  assert.equal(redeploy(binary, [], { HEDDLE_BIN: '/opt/heddle/bin/heddle' }).status, 0)
  assert.deepEqual(calls(binary), ['install --restart', probe, 'verify --json'], 'a rust/ change can matter to a binary deployment, so it always restarts')
})

test('a change under src/ always rebuilds and restarts, even with a build present', () => {
  const f = fixture({ change: 'src' })
  built(f)
  assert.equal(redeploy(f).status, 0)
  assert.deepEqual(calls(f), full)
})
