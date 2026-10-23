import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_JOBS, EXCLUDES, bootstrapScript, branchOf, hostFrom, remoteDir, remoteScript, rsyncArgs, testCommand, verifyCommand, worktreeScript } from '../../build-host.mjs'

test('the build host comes from --host, then HEDDLE_BUILD_HOST, and there is no default', () => {
  assert.equal(hostFrom({ host: 'alpha' }, { HEDDLE_BUILD_HOST: 'beta' }), 'alpha', 'the flag wins over the environment')
  assert.equal(hostFrom({}, { HEDDLE_BUILD_HOST: ' beta ' }), 'beta', 'the environment is used, trimmed')
  assert.throws(() => hostFrom({}, {}), /HEDDLE_BUILD_HOST/, 'no host is an error that names the variable')
  assert.throws(() => hostFrom({}, { HEDDLE_BUILD_HOST: '  ' }), /no build host/, 'a blank host is no host')
})

test('a seat lands in ~/heddle--<seat> on branch hd/<seat>; integration and the deployment follow main', () => {
  assert.equal(remoteDir('llm'), 'heddle--llm')
  assert.equal(remoteDir('int'), 'heddle--int', 'integration is a seat-shaped worktree')
  assert.equal(remoteDir('live'), 'heddle-live', 'the deployment is the one exception to the pattern')
  assert.equal(branchOf('llm'), 'hd/llm')
  assert.equal(branchOf('int'), null)
  assert.equal(branchOf('int-ui'), null, 'an integration lane is detached at main too')
  assert.equal(branchOf('integrator-ui'), 'hd/integrator-ui', 'but the integrator\'s own seat has a branch')
  assert.equal(branchOf('live'), null)
  for (const bad of ['../etc', 'LLM', 'a b', '', '-x', 'a/b', undefined]) {
    assert.throws(() => remoteDir(bad), /kebab-case/, `rejects ${JSON.stringify(bad)}`)
  }
})

test('a worktree is created once, resumed from its pushed branch, and gets packages of its own', () => {
  const seat = worktreeScript('sessions')
  assert.match(seat, /cd "\$HOME\/heddle" && git fetch -q origin/, 'starts from the base clone, freshly fetched')
  assert.match(seat, /if \[ ! -e "\$HOME\/heddle--sessions\/\.git" \]; then/, 'never re-created over work in progress')
  assert.match(seat, /git rev-parse -q --verify "origin\/hd\/sessions".*git worktree add -q -B "hd\/sessions" "\$HOME\/heddle--sessions" "origin\/hd\/sessions"/, 'resumes pushed work')
  assert.match(seat, /else git worktree add -q -B "hd\/sessions" "\$HOME\/heddle--sessions" origin\/main; fi/, 'otherwise starts from main')
  assert.match(seat, /if \[ ! -d node_modules \]; then npm ci/, 'its own packages, so no symlink can be committed')
  const live = worktreeScript('live')
  assert.match(live, /git worktree add -q --detach "\$HOME\/heddle-live" origin\/main/, 'the deployment is detached at main')
  assert.doesNotMatch(live, /hd\//, 'and has no branch of its own')
})

test('rsync mirrors the worktree with a trailing slash and keeps history, packages and builds behind', () => {
  const args = rsyncArgs({ from: '/tmp/wt/', host: 'alpha', name: 'sessions' })
  assert.deepEqual(args.slice(0, 2), ['-a', '--delete'], 'an exact mirror, so a deleted file does not linger on the host')
  for (const pattern of ['.git', 'node_modules/', 'dist/', 'rust/target/', '.heddle-tmp/']) {
    assert.ok(args.includes(`--exclude=${pattern}`), `excludes ${pattern}`)
  }
  assert.equal(args.at(-2), '/tmp/wt/', 'the source has exactly one trailing slash, so its contents are copied')
  assert.equal(args.at(-1), 'alpha:heddle--sessions/', 'the target is the seat worktree on the host')
  assert.equal(EXCLUDES.length, args.length - 4, 'every exclude is passed and nothing else is added')
})

test('a remote run enters the seat worktree, caps jobs, uses the cache and then runs the command', () => {
  const script = remoteScript({ name: 'server', command: 'cargo test --manifest-path rust/Cargo.toml' })
  const lines = script.split('\n')
  assert.equal(lines[0], 'set -e', 'a failing step stops the run')
  assert.equal(lines[1], 'cd "$HOME/heddle--server"')
  assert.ok(!script.includes('ln -s'), 'no symlinks: each worktree has its own packages')
  assert.ok(lines.includes(`export CARGO_BUILD_JOBS=${DEFAULT_JOBS}`), 'the default cap is applied')
  assert.ok(script.includes('RUSTC_WRAPPER=sccache'), 'the compiler cache is used when the host has it')
  assert.equal(lines.at(-2), 'cargo test --manifest-path rust/Cargo.toml', 'the command runs last')
  assert.match(remoteScript({ name: 'server', command: 'true', jobs: 2 }), /CARGO_BUILD_JOBS=2/)
  assert.throws(() => remoteScript({ name: 'server', command: 'true', jobs: 0 }), /positive integer/)
})

test('verify builds the release binary once and judges every named verifier through HEDDLE_BIN', () => {
  const command = verifyCommand(['05-config-system', '20-streaming'])
  const lines = command.split('\n')
  assert.equal(lines[0], 'cargo build --release --manifest-path rust/Cargo.toml')
  assert.equal(lines.length, 3, 'one build, then one line per verifier')
  assert.match(lines[1], /^HEDDLE_BIN="\$PWD\/rust\/target\/release\/heddle" sh _verifiers_\/05-config-system\/verify\.sh; echo "verdict 05-config-system: \$\?"$/)
  assert.throws(() => verifyCommand([]), /at least one verifier/)
  assert.throws(() => verifyCommand(['../x']), /not a verifier folder/, 'a path is not a verifier name')
})

test('bootstrap is idempotent: each install is guarded, and the shared checkout is cloned only once', () => {
  const script = bootstrapScript('https://example.invalid/repo.git')
  assert.match(script, /if \[ ! -x "\$HOME\/\.cargo\/bin\/cargo" \]; then/, 'rustup only when cargo is missing')
  assert.match(script, /if \[ ! -x "\$HOME\/\.local\/bin\/sccache" \]; then/, 'the cache only when it is missing')
  assert.match(script, /if \[ ! -d "\$HOME\/heddle\/\.git" \]; then git clone -q https:\/\/example\.invalid\/repo\.git/, 'clone only once')
  assert.match(script, /git pull -q --ff-only/, 'and fast-forward afterwards, never a merge')
  assert.match(script, /\) \|\| echo "sccache: not installed, continuing without the compiler cache"; fi/, 'a failed cache install never aborts the bootstrap')
  assert.match(script, /releases\/download\/v[0-9.]+\/sccache-v[0-9.]+-\$arch-unknown-linux-musl\.tar\.gz/, 'a pinned release is the fallback when the API is refused')
})

test('an owner tests exactly its own crates, and a name that is not a workspace crate is refused', () => {
  assert.equal(testCommand(['heddle-llm']), 'cargo test --manifest-path rust/Cargo.toml -p heddle-llm')
  assert.equal(testCommand(['heddle-session', 'heddle-workspace']), 'cargo test --manifest-path rust/Cargo.toml -p heddle-session -p heddle-workspace')
  assert.equal(testCommand(['heddle']), 'cargo test --manifest-path rust/Cargo.toml -p heddle', 'the binary crate is a crate too')
  assert.throws(() => testCommand([]), /at least one crate/)
  assert.throws(() => testCommand(['serde; rm -rf ~']), /not a crate of this workspace/, 'nothing but a crate name reaches the shell')
})
