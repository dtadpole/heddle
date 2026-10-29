import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactKey, depsDirs, sweepDeps, targetsFor } from '../../deps-sweep.mjs'

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
