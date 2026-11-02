import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactKey, depsDirs, floorSweep, newestWrite, ownerOf, renderFloor, rosterOwners, sweepDeps, targetsFor } from '../../deps-sweep.mjs'

// Every test builds a fake target of its own; no real target/ is read or changed.
const RUN = join(import.meta.dirname, '..', '..', 'run')
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0)
const H = (n) => n.toString(16).padStart(16, '0')

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-sweep-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function file(dir, name, minutesAgo, now = NOW) {
  writeFileSync(join(dir, name), 'x')
  const at = new Date(now - minutesAgo * 60_000)
  utimesSync(join(dir, name), at, at)
  return join(dir, name)
}

test('artifactKey groups heddle artifacts by name and extension, and ignores everything else', () => {
  assert.equal(artifactKey(`libheddle_server-${H(1)}.rlib`), 'libheddle_server.rlib')
  assert.equal(artifactKey(`heddle_server-${H(2)}`), 'heddle_server')
  assert.equal(artifactKey(`heddle_server-${H(2)}.d`), 'heddle_server.d')
  assert.equal(artifactKey(`heddle-${H(3)}`), 'heddle')
  assert.equal(artifactKey(`libserde-${H(4)}.rlib`), null, 'third-party')
  assert.equal(artifactKey('heddle_server.d'), null, 'no hash')
})

test('a superseded artifact older than the age goes; the newest, young ones and third-party crates stay', (t) => {
  const deps = join(scratch(t), 'target', 'debug', 'deps')
  mkdirSync(deps, { recursive: true })
  const newest = file(deps, `libheddle_agent-${H(10)}.rlib`, 5)
  const old = file(deps, `libheddle_agent-${H(11)}.rlib`, 90)
  const young = file(deps, `libheddle_agent-${H(12)}.rlib`, 30)
  const binNew = file(deps, `heddle_agent-${H(13)}`, 1)
  const binOld = file(deps, `heddle_agent-${H(14)}`, 600)
  const serdeOld = file(deps, `libserde-${H(15)}.rlib`, 600)
  file(deps, `libserde-${H(16)}.rlib`, 1)
  const staleNewest = file(deps, `libheddle_idle-${H(17)}.rlib`, 600) // nobody built it since: still the newest
  const staleOlder = file(deps, `libheddle_idle-${H(18)}.rlib`, 900)
  const r = sweepDeps(deps, { now: NOW })
  assert.equal(r.removed, 3)
  for (const p of [old, binOld, staleOlder]) assert.equal(existsSync(p), false, p)
  for (const p of [newest, young, binNew, serdeOld, staleNewest]) assert.equal(existsSync(p), true, p)
})

test('a deps folder a running process names is left alone, and dry-run removes nothing', (t) => {
  const deps = join(scratch(t), 'deps')
  mkdirSync(deps)
  file(deps, `libheddle_x-${H(1)}.rlib`, 1)
  const old = file(deps, `libheddle_x-${H(2)}.rlib`, 600)
  assert.equal(sweepDeps(deps, { now: NOW, commands: `rustc --out-dir ${deps} --crate-name heddle_x` }).inUse, true)
  assert.equal(sweepDeps(deps, { now: NOW, dryRun: true }).removed, 1)
  assert.equal(existsSync(old), true)
})

test('the target comes from CARGO_TARGET_DIR, then --manifest-path, then ./Cargo.toml', (t) => {
  const dir = scratch(t)
  assert.deepEqual(targetsFor([], { CARGO_TARGET_DIR: '/x/t' }, dir), ['/x/t'])
  assert.deepEqual(targetsFor(['test', '--manifest-path', 'rust/Cargo.toml'], {}, dir), [join(dir, 'rust', 'target')])
  assert.deepEqual(targetsFor(['test', '--manifest-path=rust/Cargo.toml'], {}, dir), [join(dir, 'rust', 'target')])
  assert.deepEqual(targetsFor(['test'], {}, dir), [], 'no Cargo.toml here: nothing to sweep')
  writeFileSync(join(dir, 'Cargo.toml'), '')
  assert.deepEqual(targetsFor(['test'], {}, dir), [join(dir, 'target')])
  mkdirSync(join(dir, 'target', 'debug', 'deps'), { recursive: true })
  mkdirSync(join(dir, 'target', 'aarch64-apple-darwin', 'release', 'deps'), { recursive: true })
  assert.equal(depsDirs(join(dir, 'target')).length, 2)
})

test('the slot runner sweeps after a successful cargo command, not after a failed one', (t) => {
  const dir = scratch(t)
  const deps = join(dir, 'target', 'debug', 'deps')
  mkdirSync(deps, { recursive: true })
  writeFileSync(join(dir, 'Cargo.toml'), '')
  const cargo = join(dir, 'fake-cargo')
  writeFileSync(cargo, '#!/bin/sh\nexit "${FAKE_RC:-0}"\n')
  chmodSync(cargo, 0o755)
  const now = Date.now()
  file(deps, `libheddle_y-${H(1)}.rlib`, 1, now)
  const old = file(deps, `libheddle_y-${H(2)}.rlib`, 600, now)
  const env = { ...process.env, CARGO: cargo, LOCAL_BUILD_SLOT_ROOT: join(dir, 'slots'), LOCAL_BUILD_DEPS_SWEEP: '1' }
  const failed = spawnSync(RUN, ['build', '--manifest-path', join(dir, 'Cargo.toml')], { env: { ...env, FAKE_RC: '3' }, encoding: 'utf8' })
  assert.equal(failed.status, 3, failed.stderr)
  assert.equal(existsSync(old), true, 'a failed build sweeps nothing')
  const ok = spawnSync(RUN, ['build', '--manifest-path', join(dir, 'Cargo.toml')], { env, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(existsSync(old), false)
  assert.match(ok.stderr, /deps-sweep: .*removed 1 superseded heddle artifact/)
})

// --floor: fake worktrees with fake rust/target/debug folders; the real clock, since mtimes are set from it.
const GIB = 1024 ** 3
const NO_HOLDS = { commands: '', paths: [] }
const ROSTER = `members:
  - key: integrator-one
    resource_identity_ref: 'Mac ~/heddle--integrator-one, ~/heddle--int-backend'
  - key: live-deploy
    resource_identity_ref: 'Mac ~/heddle--live-deploy, operates ~/heddle-live'
  - key: developer-two
    resource_identity_ref: 'Mac ~/heddle--developer-two'
  - key: developer-twelve
    resource_identity_ref: 'Mac ~/heddle--developer-twelve'
`

/** <wt>/rust/target/debug with deps/ and .fingerprint/ entries, every level `minutesAgo` old; returns the folder. */
function debugTarget(wt, minutesAgo) {
  const debug = join(wt, 'rust', 'target', 'debug')
  for (const sub of ['deps', '.fingerprint/heddle-abc', 'build']) mkdirSync(join(debug, sub), { recursive: true })
  writeFileSync(join(debug, 'deps', 'libheddle_x-0000000000000001.rlib'), Buffer.alloc(64 * 1024))
  writeFileSync(join(debug, '.fingerprint', 'heddle-abc', 'lib-heddle'), 'x')
  writeFileSync(join(debug, 'heddle'), 'binary')
  mkdirSync(join(wt, 'rust', 'target', 'release'), { recursive: true })
  const at = new Date(Date.now() - minutesAgo * 60_000)
  const age = (p) => {
    for (const name of readdirSync(p, { withFileTypes: true })) {
      if (name.isDirectory()) age(join(p, name.name))
      else utimesSync(join(p, name.name), at, at)
    }
    utimesSync(p, at, at)
  }
  age(debug)
  return debug
}

test('newestWrite reads the folder, its entries and theirs, and stops once one is new enough', (t) => {
  const dir = scratch(t)
  const debug = debugTarget(join(dir, 'wt'), 120)
  const old = Date.now() - 120 * 60_000
  assert.ok(Math.abs(newestWrite(debug) - old) < 2_000)
  const fresh = join(debug, 'deps', 'libheddle_y-0000000000000002.rlib')
  writeFileSync(fresh, 'x')
  utimesSync(join(debug, 'deps'), new Date(old), new Date(old)) // only the file itself is new
  assert.ok(Date.now() - newestWrite(debug) < 60_000, 'a fresh file two levels down counts')
  assert.ok(Date.now() - newestWrite(debug, old + 60_000) < 60_000)
})

test('the roster names each worktree\'s owner, a seat\'s extra and nested worktrees and tmp branches included', () => {
  const roster = rosterOwners(ROSTER)
  assert.equal(roster.get('heddle--int-backend'), 'integrator-one')
  assert.equal(roster.get('heddle-live'), 'live-deploy')
  const parent = '/Users/u'
  const owner = (p, branch) => ownerOf(p, { parent, branch, roster })
  assert.equal(owner('/Users/u/heddle--int-backend'), 'integrator-one')
  assert.equal(owner('/Users/u/heddle-live'), 'live-deploy')
  assert.equal(owner('/Users/u/heddle--developer-twelve-gate'), 'developer-twelve', 'an extra worktree is its seat\'s')
  assert.equal(owner('/Users/u/heddle--developer-twelve/.worktrees/preview-shell'), 'developer-twelve', 'nested')
  assert.equal(owner('/private/tmp/hd12-img', 'hd/developer-twelve-answer-images'), 'developer-twelve')
  assert.equal(owner('/private/tmp/d2-x', 'hd/developer-two'), 'developer-two')
  assert.equal(owner('/Users/u/heddle--developer-twox'), 'heddle--developer-twox', 'a longer name is not the seat\'s')
  assert.equal(owner('/private/tmp/d1-80s16', 'd1-local/locale-hover'), 'd1-80s16', 'no roster seat: the folder')
  assert.equal(ownerOf('/Users/u/heddle--int-backend', { parent }), 'heddle--int-backend', 'no roster: the folder')
})

/** Worktrees beside a main one: { name: minutes since the debug folder was written, or null for no target }. */
function worktrees(t, ages) {
  const dir = realpathSync(scratch(t))
  return Object.entries(ages).map(([name, minutes]) => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return { path, debug: minutes === null ? null : debugTarget(path, minutes) }
  })
}

test('under the floor it removes idle debug folders, oldest first, and keeps young, held and linked ones', (t) => {
  const wts = worktrees(t, {
    heddle: null,
    'heddle--int-backend': 45,
    'heddle--developer-twelve': 400,
    'heddle--developer-two': 10,
    'heddle--live-deploy': 300,
    'heddle--named': 300,
    'heddle--raced': 300,
    'heddle--linked': null,
  })
  const [, backend, twelve, two, live, named, raced, linked] = wts
  mkdirSync(join(linked.path, 'rust', 'target'), { recursive: true })
  symlinkSync(twelve.debug, join(linked.path, 'rust', 'target', 'debug'))
  const holds = { paths: [join(live.debug, 'deps', 'heddle_server-0000000000000009')], commands: `cargo test --target-dir x ${named.debug}\n` }
  const r = floorSweep({
    worktrees: wts.map(({ path }) => ({ path })),
    free: 10 * GIB,
    holds,
    refreshHolds: () => ({ ...holds, paths: [...holds.paths, join(raced.debug, '.cargo-lock')] }), // a build started meanwhile
    roster: rosterOwners(ROSTER),
  })
  assert.deepEqual(r.errors, [])
  assert.equal(r.under, true)
  assert.deepEqual(r.removed.map((d) => [d.owner, d.dir]), [
    ['developer-twelve', twelve.debug],
    ['integrator-one', backend.debug],
  ])
  assert.ok(r.removed.every((d) => d.kib > 0))
  assert.deepEqual(r.young, ['developer-two'])
  assert.deepEqual(r.held.sort(), ['heddle--named', 'heddle--raced', 'live-deploy'])
  for (const d of [twelve.debug, backend.debug]) assert.equal(existsSync(d), false, d)
  for (const d of [two.debug, live.debug, named.debug, raced.debug]) assert.equal(existsSync(d), true, d)
  assert.equal(existsSync(join(backend.path, 'rust', 'target', 'release')), true, 'only debug goes')
  const text = renderFloor(r, false)
  assert.match(text, /^deps-sweep --floor: disk 10\.0 GiB free, under the 18 GiB floor: removed 2 rust\/target\/debug folder\(s\) unwritten for 30\+ minutes, [\d.]+ GiB; disk [\d.]+ GiB free after\. Owners are not told: tell them\.$/m)
  assert.match(text, new RegExp(`^  removed ${twelve.debug} \\(owner developer-twelve, unwritten 6h4\\d, [\\d.]+ GiB\\)$`, 'm'))
  assert.match(text, /^  kept, written in the last 30 minutes: developer-two$/m)
})

test('at or above the floor, in a dry run, or without a process list or the free space, it removes nothing', (t) => {
  const wts = worktrees(t, { heddle: null, 'heddle--a': 300 })
  const list = wts.map(({ path }) => ({ path }))
  const above = floorSweep({ worktrees: list, free: 18 * GIB, holds: NO_HOLDS })
  assert.equal(above.under, false)
  assert.equal(renderFloor(above, false), 'deps-sweep --floor: disk 18.0 GiB free, at or above the 18 GiB floor: nothing removed')
  const dry = floorSweep({ worktrees: list, free: 17.9 * GIB, holds: NO_HOLDS, dryRun: true, refreshHolds: () => null })
  assert.deepEqual(dry.removed.map((d) => d.owner), ['heddle--a'])
  assert.match(renderFloor(dry, true), /would remove 1 rust\/target\/debug/)
  const blind = floorSweep({ worktrees: list, free: GIB, holds: null })
  assert.match(blind.errors[0], /process list .* could not be read/)
  const unsure = floorSweep({ worktrees: list, free: GIB, holds: NO_HOLDS, refreshHolds: () => null })
  assert.match(unsure.errors[0], /could not be read again/)
  assert.deepEqual(unsure.removed, [])
  assert.match(floorSweep({ worktrees: list, free: null, holds: NO_HOLDS }).errors[0], /free disk space could not be read/)
  assert.equal(floorSweep({ worktrees: list, free: GIB, holds: NO_HOLDS, ageMinutes: 600, refreshHolds: () => NO_HOLDS }).removed.length, 0, 'a longer age keeps it')
  const once = floorSweep({ worktrees: list, free: GIB, holds: { paths: [join(wts[1].debug, 'heddle')], commands: '' }, refreshHolds: () => NO_HOLDS })
  assert.deepEqual([once.removed.length, once.held], [0, ['heddle--a']], 'held at either read: kept')
  assert.equal(existsSync(wts[1].debug), true)
})

test('the command line: --floor sweeps the repository\'s worktrees with the roster\'s owners, and only under the floor', (t) => {
  const dir = realpathSync(scratch(t))
  const repo = join(dir, 'heddle')
  mkdirSync(repo)
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' }
  const git = (...args) => assert.equal(spawnSync('git', ['-C', repo, ...args], { env }).status, 0, args.join(' '))
  git('init', '-q')
  writeFileSync(join(repo, 'f'), 'x')
  git('add', 'f')
  git('commit', '-q', '-m', 'x')
  const wt = join(dir, 'heddle--int-backend')
  git('worktree', 'add', '-q', '--detach', wt)
  const debug = debugTarget(wt, 90)
  const roster = join(dir, 'TEAM.yaml')
  writeFileSync(roster, ROSTER)
  const script = join(import.meta.dirname, '..', '..', 'deps-sweep')
  const above = spawnSync(script, ['--floor', '--floor-gib', '0', '--repo', repo, '--roster', roster], { encoding: 'utf8' })
  assert.equal(above.status, 0, above.stderr)
  assert.match(above.stdout, /at or above the 0 GiB floor: nothing removed/)
  assert.equal(existsSync(debug), true)
  const under = spawnSync(script, ['--floor', '--floor-gib', '100000', '--repo', repo, '--roster', roster], { encoding: 'utf8' })
  assert.equal(under.status, 0, under.stderr)
  assert.match(under.stdout, new RegExp(`removed ${debug} \\(owner integrator-one, unwritten 1h3\\d, `))
  assert.equal(existsSync(debug), false)
  assert.equal(spawnSync(script, ['--floor', '--floor-gib', 'low'], { encoding: 'utf8' }).status, 64)
})
