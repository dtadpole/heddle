import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * preview.sh, run for real against throwaway git repositories: a bare origin and a scratch checkout of it. The
 * checkout's build runner, the binary it builds and the installer are stand-ins that record their calls, so which steps
 * ran — and that a failed step leaves the served binary alone — is read from the calls and the files, not assumed.
 */

const script = resolve(fileURLToPath(new URL('../../preview.sh', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-preview-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const gitEnv = { GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_CONFIG_NOSYSTEM: '1' }
let counter = 0

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv, HOME: scratch } })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function fixture({ second = 'heddle' } = {}) {
  counter += 1
  const base = join(scratch, `case-${counter}`)
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  const checkout = join(base, 'checkout')
  const home = join(base, 'preview-home')
  const calls = join(base, 'calls.log')
  git(base === '' ? scratch : (mkdirSync(base, { recursive: true }), base), 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, work)
  const put = (path, body, mode = 0o644) => {
    mkdirSync(join(work, path, '..'), { recursive: true })
    writeFileSync(join(work, path), body)
    chmodSync(join(work, path), mode)
  }
  // The build runner writes the binary; the binary answers `web --dry-run`; the installer records itself and prints a
  // launch token into the log, as the real server does when the agent starts it.
  put('_tools_/local-build/run', `#!/bin/sh\necho "run $*" >> "${calls}"\n[ "\${FAKE_BUILD_EXIT:-0}" = 0 ] || exit 1\nmkdir -p rust/target/release\nprintf '#!/bin/sh\\necho "heddle $*" >> "${calls}"\\nexit \${FAKE_DRYRUN_EXIT:-0}\\n' > rust/target/release/heddle\nchmod 755 rust/target/release/heddle\n`, 0o755)
  put('_tools_/web-daemon/install.sh', `#!/bin/sh\necho "install $* port=$HEDDLE_WEB_PORT label=$HEDDLE_WEB_LABEL bin=$HEDDLE_BIN sessions=$HEDDLE_WEB_SESSION_ROOT" >> "${calls}"\necho "heddle web: http://127.0.0.1:$HEDDLE_WEB_PORT/?token=tok$$" >> "$HEDDLE_WEB_LOG"\n`, 0o755)
  put('rust/crates/heddle/src/main.rs', 'fn main() {}\n')
  put('cordis.yml', '[]\n')
  put('.gitignore', 'rust/target/\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'push', '-q', 'origin', 'main')
  const first = git(work, 'rev-parse', 'HEAD')
  if (second === 'heddle') put('rust/crates/heddle/src/web.rs', 'pub fn web() {}\n')
  else if (second === 'other-crate') put('rust/crates/heddle-config/src/compose.rs', 'pub fn compose() {}\n')
  else if (second === 'page') put('src/server/page.html', '<html></html>\n')
  else if (second === 'crate-docs') put('rust/crates/heddle/src/INDEX.md', 'docs\n')
  else put('docs/notes.md', 'notes\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'second')
  git(work, 'push', '-q', 'origin', 'main')
  const tip = git(work, 'rev-parse', 'HEAD')
  git(base, 'clone', '-q', origin, checkout)
  git(checkout, 'checkout', '-q', '--detach', first)
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin', 'heddle'), 'old binary\n')
  return { base, checkout, home, calls, first, tip }
}

function preview(f, args = [], env = {}) {
  const result = spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...gitEnv, HOME: scratch, PREVIEW_CHECKOUT: f.checkout, PREVIEW_HOME: f.home, ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const calls = (f) => (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean) : [])
const built = (f) => (existsSync(join(f.home, 'built-from-main')) ? readFileSync(join(f.home, 'built-from-main'), 'utf8').trim() : null)
const served = (f) => readFileSync(join(f.home, 'bin', 'heddle'), 'utf8')

test('with no recorded build it builds main, dry-runs it, swaps the binary, reinstalls the preview and prints the link', () => {
  const f = fixture()
  const result = preview(f)
  assert.equal(result.status, 0, result.stderr)
  const seen = calls(f)
  assert.equal(seen[0], 'run build --release --manifest-path rust/Cargo.toml -p heddle')
  assert.match(seen[1], /^heddle web --host 127\.0\.0\.1 --port 3097 --config .*\/cordis\.yml --dry-run$/)
  assert.match(seen[2], new RegExp(`^install --restart port=3097 label=com\\.dtadpole\\.heddle-web-rust-preview bin=${f.home}/bin/heddle sessions=${f.home}/sessions$`), 'and its own session store, not the deployment\'s')
  assert.equal(built(f), f.tip, 'the commit it was built from is recorded')
  assert.notEqual(served(f), 'old binary\n', 'the served binary is the new build')
  assert.match(result.stdout, /link: http:\/\/127\.0\.0\.1:3097\/\?token=tok\d+/)
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), f.tip)
})

test('--check says behind when main changed rust/crates/heddle, and current when it changed only docs; nothing runs', () => {
  const behind = fixture({ second: 'heddle' })
  writeFileSync(join(behind.home, 'built-from-main'), `${behind.first}\n`)
  const answer = preview(behind, ['--check'])
  assert.equal(answer.status, 10)
  assert.match(answer.stdout, /behind: built from [0-9a-f]{7}, main [0-9a-f]{7}: rust\/crates\/heddle\/src\/web\.rs/)
  assert.deepEqual(calls(behind), [])

  const current = fixture({ second: 'docs' })
  writeFileSync(join(current.home, 'built-from-main'), `${current.first}\n`)
  assert.equal(preview(current, ['--check']).status, 0)
  const run = preview(current)
  assert.equal(run.status, 0)
  assert.match(run.stdout, /current: main [0-9a-f]{7} changed nothing it serves/)
  assert.deepEqual(calls(current), [], 'no build and no restart, so the owner keeps the same link')
  assert.equal(preview(current, ['--force']).status, 0, '--force rebuilds anyway')
  assert.ok(calls(current).some((line) => line.startsWith('install --restart')))
})

test('a failed build or a failed dry run leaves the served binary and the recorded commit alone', () => {
  const failing = fixture()
  const build = preview(failing, [], { FAKE_BUILD_EXIT: '1' })
  assert.equal(build.status, 1)
  assert.match(build.stderr, /the release build failed .* still serves the previous binary/)
  assert.equal(served(failing), 'old binary\n')
  assert.equal(built(failing), null)

  const refusing = fixture()
  const dry = preview(refusing, [], { FAKE_DRYRUN_EXIT: '2' })
  assert.equal(dry.status, 1)
  assert.match(dry.stderr, /web --dry-run failed/)
  assert.equal(served(refusing), 'old binary\n')
  assert.ok(calls(refusing).every((line) => !line.startsWith('install')), 'and the preview is not restarted')
})

test('a checkout with changes, the deployment\'s port or label, and an unknown option are refused', () => {
  const f = fixture()
  writeFileSync(join(f.checkout, 'cordis.yml'), 'edited\n')
  const dirty = preview(f)
  assert.equal(dirty.status, 2)
  assert.match(dirty.stderr, /has changes/)
  assert.equal(preview(f, [], { PREVIEW_PORT: '3082' }).status, 2)
  assert.equal(preview(f, [], { PREVIEW_PORT: '8082' }).status, 2)
  assert.equal(preview(f, [], { PREVIEW_LABEL: 'com.dtadpole.heddle-web' }).status, 2)
  assert.equal(preview(f, ['--frobnicate']).status, 2)
  assert.deepEqual(calls(f), [])
})

test('any crate the binary links, and the page it embeds, make the preview behind; Markdown inside a crate does not', () => {
  // Measured 2026-10-23: watching only rust/crates/heddle and heddle-server, the preview read "current" while main had
  // changed heddle-config's compose.rs, which the binary links.
  for (const [second, expected] of [['other-crate', 10], ['page', 10], ['crate-docs', 0]]) {
    const f = fixture({ second })
    writeFileSync(join(f.home, 'built-from-main'), `${f.first}\n`)
    const answer = preview(f, ['--check'])
    assert.equal(answer.status, expected, `${second}: ${answer.stdout}`)
    assert.deepEqual(calls(f), [])
  }
})
