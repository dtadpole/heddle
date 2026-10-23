#!/usr/bin/env node
/**
 * Build and judge a worktree on a Linux build host over SSH.
 *
 * The Rust port cannot run what it builds on a machine whose binary-authorization policy kills unknown
 * binaries, so it is developed, tested and judged on build hosts (rust/INDEX.md). The working model is one git
 * worktree per team member on its host, `~/heddle--<seat>` on branch `hd/<seat>`, an integration worktree
 * `~/heddle--int` where branches are merged and judged together, and `~/heddle-live` for the deployment. Every
 * command runs with the host's compiler cache and a job cap — the hosts are shared, and sixteen uncapped
 * builds would starve them.
 *
 * The host is machine configuration, like an endpoint: `--host` or `HEDDLE_BUILD_HOST`, never a default.
 * Every SSH call rides the host's existing multiplexed connection, because rsync and ssh read ~/.ssh/config.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** What never crosses to the host: history, installed or built output, scratch, machine-local state. */
export const EXCLUDES = ['.git', 'node_modules/', 'dist/', 'rust/target/', '.heddle-tmp/', '_sessions_/']

/** The compiler-cache release used when the release API cannot be asked. */
export const SCCACHE_PINNED = 'v0.10.0'

/** Default parallel compile jobs per build — a quarter of a 16-vCPU shared host. */
export const DEFAULT_JOBS = 4

/** The host named by `--host`, else by `HEDDLE_BUILD_HOST`; there is deliberately no default. */
export function hostFrom(options, env = process.env) {
  const host = options.host ?? env.HEDDLE_BUILD_HOST
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('build-host: no build host — pass --host or set HEDDLE_BUILD_HOST to an SSH alias')
  }
  return host.trim()
}

/**
 * A worktree's folder in the host's home: `heddle--<seat>` for a member (and `heddle--int` for integration),
 * `heddle-live` for the deployment. The name is a seat key, so kebab-case only.
 */
export function remoteDir(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`build-host: worktree name must be kebab-case, got ${JSON.stringify(name)}`)
  }
  return name === 'live' ? 'heddle-live' : `heddle--${name}`
}

/** The branch a seat works on; integration and the deployment follow main instead of a branch of their own. */
export function branchOf(name) {
  remoteDir(name)
  return name === 'live' || name === 'int' ? null : `hd/${name}`
}

/**
 * The script that creates a seat's worktree once, from the base clone `~/heddle`: on its own branch, resumed from
 * `origin/hd/<seat>` when that was pushed before and started from `origin/main` otherwise; integration and the
 * deployment are detached at `origin/main`. Packages are installed per worktree, so no symlink can be committed.
 */
export function worktreeScript(name) {
  const dir = `$HOME/${remoteDir(name)}`
  const branch = branchOf(name)
  const add = branch === null
    ? `git worktree add -q --detach "${dir}" origin/main`
    : `if git rev-parse -q --verify "origin/${branch}" >/dev/null; then git worktree add -q -B "${branch}" "${dir}" "origin/${branch}"; else git worktree add -q -B "${branch}" "${dir}" origin/main; fi`
  return [
    'set -e',
    'cd "$HOME/heddle" && git fetch -q origin',
    `if [ ! -e "${dir}/.git" ]; then ${add}; fi`,
    `cd "${dir}"`,
    'if [ ! -d node_modules ]; then npm ci --no-audit --no-fund >/dev/null; fi',
    'if [ ! -d dist ]; then npm run build >/dev/null; fi',
    'echo "worktree ready: $(hostname -s):$PWD on $(git rev-parse --abbrev-ref HEAD) at $(git log --oneline -1)"',
    '',
  ].join('\n')
}

/** rsync arguments that mirror `from` onto the host, deleting what the worktree no longer has. */
export function rsyncArgs({ from, host, name }) {
  const source = `${resolve(from)}/`
  return ['-a', '--delete', ...EXCLUDES.map((pattern) => `--exclude=${pattern}`), source, `${host}:${remoteDir(name)}/`]
}

/** The script run on the host for one command, sent on stdin so the command needs no extra quoting. */
export function remoteScript({ name, command, jobs = DEFAULT_JOBS }) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`build-host: jobs must be a positive integer, got ${jobs}`)
  return [
    'set -e',
    `cd "$HOME/${remoteDir(name)}"`,
    '. "$HOME/.cargo/env"',
    'export PATH="$HOME/.local/bin:$PATH"',
    'if command -v sccache >/dev/null 2>&1; then export RUSTC_WRAPPER=sccache; fi',
    `export CARGO_BUILD_JOBS=${jobs}`,
    command,
    '',
  ].join('\n')
}

/** The command that builds the release binary and judges it with each named verifier through HEDDLE_BIN. */
export function verifyCommand(verifiers) {
  if (verifiers.length === 0) throw new Error('build-host: name at least one verifier folder, e.g. 05-config-system')
  for (const verifier of verifiers) {
    if (!/^[0-9]{2}-[a-z0-9-]+$/.test(verifier)) throw new Error(`build-host: not a verifier folder name: ${verifier}`)
  }
  const runs = verifiers.map((v) => `HEDDLE_BIN="$PWD/rust/target/release/heddle" sh _verifiers_/${v}/verify.sh; echo "verdict ${v}: $?"`)
  return ['cargo build --release --manifest-path rust/Cargo.toml', ...runs].join('\n')
}

/**
 * The command that runs one owner's unit tests: each feature owner owns the tests of its crates and runs them in
 * its own worktree, so a run judges exactly those crates and nobody else's half-finished work.
 */
export function testCommand(crates) {
  if (crates.length === 0) throw new Error('build-host: name at least one crate, e.g. --crates=heddle-llm')
  for (const crate of crates) {
    if (!/^heddle(-[a-z0-9]+)*$/.test(crate)) throw new Error(`build-host: not a crate of this workspace: ${crate}`)
  }
  return `cargo test --manifest-path rust/Cargo.toml ${crates.map((crate) => `-p ${crate}`).join(' ')}`
}

/** The script that prepares a host once: rustup, the compiler cache, and the shared checkout's packages. */
export function bootstrapScript(repository = 'https://github.com/dtadpole/heddle.git') {
  return [
    'set -e',
    'if [ ! -x "$HOME/.cargo/bin/cargo" ]; then curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile default; fi',
    'mkdir -p "$HOME/.local/bin"',
    // The compiler cache only speeds builds up, so failing to install it never stops a bootstrap. The release
    // API is tried first and a pinned release is the fallback: a shared egress address is easily rate-limited.
    'if [ ! -x "$HOME/.local/bin/sccache" ]; then (',
    '  set -e; arch=$(uname -m)',
    '  url=$(curl -fsSL https://api.github.com/repos/mozilla/sccache/releases/latest 2>/dev/null | grep -oE "https://[^\\"]*-$arch-unknown-linux-musl\\.tar\\.gz" | head -1 || true)',
    `  [ -n "$url" ] || url="https://github.com/mozilla/sccache/releases/download/${SCCACHE_PINNED}/sccache-${SCCACHE_PINNED}-$arch-unknown-linux-musl.tar.gz"`,
    '  tmp=$(mktemp -d); curl -fsSL "$url" -o "$tmp/s.tgz"; tar -xzf "$tmp/s.tgz" -C "$tmp"; cp "$tmp"/sccache-*/sccache "$HOME/.local/bin/"; rm -rf "$tmp"',
    ') || echo "sccache: not installed, continuing without the compiler cache"; fi',
    `if [ ! -d "$HOME/heddle/.git" ]; then git clone -q ${repository} "$HOME/heddle"; fi`,
    'cd "$HOME/heddle" && git pull -q --ff-only',
    'npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null',
    '. "$HOME/.cargo/env"; echo "ready: $(hostname -s) $(cargo --version) sccache=$("$HOME/.local/bin/sccache" --version 2>/dev/null || echo none)"',
    '',
  ].join('\n')
}

function parse(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') { options.rest = argv.slice(index + 1); break }
    const match = /^--([a-z]+)=(.*)$/.exec(arg)
    if (match) options[match[1]] = match[2]
    else if (arg === '--sync') options.sync = true
    else if (/^--[a-z]+$/.test(arg)) options[arg.slice(2)] = argv[++index]
    else options._.push(arg)
  }
  return options
}

function ssh(host, script) {
  return spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'bash', '-s'], { input: script, stdio: ['pipe', 'inherit', 'inherit'] }).status ?? 1
}

function sync(options, host) {
  const name = options.name
  const made = spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'mkdir', '-p', remoteDir(name)], { stdio: 'inherit' })
  if (made.status !== 0) return made.status ?? 1
  return spawnSync('rsync', rsyncArgs({ from: options.from ?? process.cwd(), host, name }), { stdio: 'inherit' }).status ?? 1
}

const USAGE = `usage:
  build-host.mjs bootstrap [--host H]
  build-host.mjs worktree --name SEAT [--host H]
  build-host.mjs run      --name SEAT [--host H] [--jobs N] -- <shell command>
  build-host.mjs test     --name SEAT --crates=CRATE[,CRATE] [--host H] [--jobs N]
  build-host.mjs verify   --name SEAT [--host H] [--jobs N] <verifier folder>...
  build-host.mjs sync     --name SEAT [--from DIR] [--host H]
The host is --host or HEDDLE_BUILD_HOST. SEAT is a kebab-case seat key: ~/heddle--SEAT on branch hd/SEAT,
~/heddle--int for integration, ~/heddle-live (SEAT=live) for the deployment. run and verify work in that
worktree; sync first only for a tree edited elsewhere (--sync on run and verify).`

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv)
  const [verb, ...rest] = options._
  if (!verb || verb === 'help') { console.log(USAGE); return verb ? 0 : 2 }
  const host = hostFrom(options)
  const jobs = options.jobs === undefined ? DEFAULT_JOBS : Number(options.jobs)
  if (verb === 'bootstrap') return ssh(host, bootstrapScript())
  if (verb === 'worktree') return ssh(host, worktreeScript(options.name))
  if (verb === 'sync') return sync(options, host)
  if (verb === 'run' || verb === 'verify' || verb === 'test') {
    const command = verb === 'run' ? (options.rest ?? []).join(' ')
      : verb === 'test' ? testCommand((options.crates ?? '').split(',').filter(Boolean))
      : verifyCommand(rest)
    if (command.trim() === '') throw new Error('build-host: run needs a command after --')
    if (options.sync !== undefined) {
      const synced = sync(options, host)
      if (synced !== 0) return synced
    }
    return ssh(host, remoteScript({ name: options.name, command, jobs }))
  }
  console.error(USAGE)
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main() } catch (error) { console.error(error.message); process.exitCode = 2 }
}
