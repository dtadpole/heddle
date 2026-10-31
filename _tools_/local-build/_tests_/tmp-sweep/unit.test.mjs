import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sweep } from '../../tmp-sweep.mjs'

// Every test sweeps a folder of its own, never the real TMPDIR.
const SCRIPT = join(import.meta.dirname, '..', '..', 'tmp-sweep')
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0)
const hoursAgo = (h) => new Date(NOW - h * 3_600_000)

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-sweep-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** An entry aged `h` hours: a folder with one file, or a file. Children are aged too. */
function entry(dir, name, h, { file = false } = {}) {
  const p = join(dir, name)
  if (file) writeFileSync(p, 'x')
  else {
    mkdirSync(p)
    writeFileSync(join(p, 'inner'), 'x')
    utimesSync(join(p, 'inner'), hoursAgo(h), hoursAgo(h))
  }
  utimesSync(p, hoursAgo(h), hoursAgo(h))
  return p
}

test('stale entries of every kind go, testers\' Chrome profiles and hidden Chrome files included; others stay', (t) => {
  const dir = folder(t)
  const gone = [
    entry(dir, 'heddle-server-test-views-ab12', 3),
    entry(dir, 'hd-developer-five-browser-x1', 3),
    entry(dir, 'hd5-live-profile-1730361600-a', 3),
    entry(dir, 'hd-live-profile-b', 3),
    entry(dir, 'round104-chrome-profile-q9', 3),
    entry(dir, 'scoped_dir1234_567', 3),
    entry(dir, 'com.google.Chrome.abc', 3, { file: true }),
    entry(dir, '.com.google.Chrome.002LhB', 3, { file: true }),
  ]
  const kept = [
    entry(dir, 'com.apple.launchd.x', 30),
    entry(dir, 'heddlefoo', 30),
    entry(dir, 'my-notes', 30, { file: true }),
    entry(dir, 'hd5-live-notes', 30), // no -live-profile
    entry(dir, 'chrome-profile', 30), // no hyphen before chrome-profile
    entry(dir, '.com.apple.x', 30, { file: true }),
  ]
  const r = sweep({ dir, now: NOW, commands: '' })
  assert.deepEqual(r.removed, {
    'heddle-*': 1,
    'hd-*-browser-*': 1,
    'hd*-live-profile*': 2,
    '*-chrome-profile*': 1,
    'scoped_dir*': 1,
    'com.google.Chrome*': 1,
    '.com.google.Chrome*': 1,
  })
  for (const p of gone) assert.equal(existsSync(p), false, p)
  for (const p of kept) assert.equal(existsSync(p), true, p)
})

test('a young or live tester profile stays: age and the process list judge every kind', (t) => {
  const dir = folder(t)
  const young = entry(dir, 'hd5-live-profile-young', 1)
  const live = entry(dir, 'hd5-live-profile-live', 5)
  const r = sweep({ dir, now: NOW, commands: `/Applications/Chrome --user-data-dir=${live} --headless\n` })
  assert.deepEqual(r.removed, {})
  assert.equal(r.tooNew, 1)
  assert.equal(r.inUse, 1)
  assert.equal(existsSync(young), true)
  assert.equal(existsSync(live), true)
})

test('after the sweep it prints the folder\'s total, entry count and five largest entries, files and folders alike', (t) => {
  const dir = folder(t)
  const big = (name, mib) => {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'blob'), Buffer.alloc(mib * 1024 * 1024))
  }
  big('a-folder', 4)
  writeFileSync(join(dir, 'b-file'), Buffer.alloc(3 * 1024 * 1024)) // a top-level file: du -d 1 lists none
  big('c-folder', 2)
  writeFileSync(join(dir, '.d-hidden'), Buffer.alloc(1024 * 1024))
  for (const name of ['e', 'f', 'g']) writeFileSync(join(dir, name), 'x')
  const r = spawnSync(SCRIPT, ['--dry-run', '--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find((l) => l.includes(' holds '))
  assert.match(line, /^tmp-sweep: .+ holds 10 MiB in 7 entries; largest: 4 MiB a-folder, 3 MiB b-file, 2 MiB c-folder, 1 MiB \.d-hidden, \d+ KiB e$/)
  assert.equal(spawnSync(SCRIPT, ['--dir', join(dir, 'missing'), '--no-caches'], { encoding: 'utf8' }).stdout.includes('sizes unknown (du failed)'), true)
})

test('an entry younger than the age stays, including a folder with a fresh file inside', (t) => {
  const dir = folder(t)
  const young = entry(dir, 'heddle-young', 1)
  const busy = entry(dir, 'heddle-busy', 5)
  writeFileSync(join(busy, 'just-written'), 'x') // a child written now: still in use
  utimesSync(join(busy, 'just-written'), hoursAgo(0.1), hoursAgo(0.1))
  utimesSync(busy, hoursAgo(5), hoursAgo(5))
  const r = sweep({ dir, now: NOW, commands: '' })
  assert.equal(r.tooNew, 2)
  assert.equal(existsSync(young), true)
  assert.equal(existsSync(busy), true)
  assert.equal(sweep({ dir, now: NOW, ageMinutes: 30, commands: '' }).removed['heddle-*'], 1, 'a shorter age takes the young one')
})

test('an entry a running process names (a live browser profile) stays', (t) => {
  const dir = folder(t)
  const profile = entry(dir, 'hd-developer-two-browser-live', 5)
  const r = sweep({ dir, now: NOW, commands: `/Applications/Chrome --user-data-dir=${profile} --headless\n` })
  assert.equal(r.inUse, 1)
  assert.equal(existsSync(profile), true)
})

test('--dry-run lists and removes nothing; the command reports by kind', (t) => {
  const dir = folder(t)
  const p = entry(dir, 'heddle-check-browser-q', 30 * 24) // a month old: well past any age
  const dry = spawnSync(SCRIPT, ['--dry-run', '--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(
    dry.stdout,
    /would remove 1 \(heddle-\* 1, hd-\*-browser-\* 0, hd\*-live-profile\* 0, \*-chrome-profile\* 0, scoped_dir\* 0, com\.google\.Chrome\* 0, \.com\.google\.Chrome\* 0\)/,
  )
  assert.equal(existsSync(p), true)
  const real = spawnSync(SCRIPT, ['--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /removed 1 \(heddle-\* 1/)
  assert.equal(existsSync(p), false)
  assert.equal(spawnSync(SCRIPT, ['--age-minutes', 'soon'], { encoding: 'utf8' }).status, 64)
})

test('it reports the npm and uv cache sizes from the settings npm and uv read, and removes nothing there', (t) => {
  const dir = folder(t)
  const npm = join(dir, 'npm-cache')
  const xdg = join(dir, 'xdg')
  mkdirSync(join(npm, '_cacache'), { recursive: true })
  writeFileSync(join(npm, '_cacache', 'blob'), Buffer.alloc(3 * 1024 * 1024))
  utimesSync(join(npm, '_cacache', 'blob'), hoursAgo(30 * 24), hoursAgo(30 * 24)) // a month old: stays anyway
  const env = { PATH: process.env.PATH, HOME: dir, npm_config_cache: npm, XDG_CACHE_HOME: xdg }
  const r = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find((l) => l.includes('caches'))
  assert.equal(line, `tmp-sweep: caches, sizes only, never removed: npm cache 3 MiB (${npm}), uv cache absent (${join(xdg, 'uv')})`)
  assert.equal(existsSync(join(npm, '_cacache', 'blob')), true)

  mkdirSync(join(dir, 'uv-explicit'))
  const uv = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env: { ...env, UV_CACHE_DIR: join(dir, 'uv-explicit') } })
  assert.match(uv.stdout, new RegExp(`uv cache 0 KiB \\(${join(dir, 'uv-explicit')}\\)`), 'UV_CACHE_DIR wins over XDG_CACHE_HOME')
  const plain = spawnSync(SCRIPT, ['--dir', folder(t), '--no-caches'], { encoding: 'utf8', env })
  assert.equal(plain.status, 0)
  assert.doesNotMatch(plain.stdout, /caches/)
  const home = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
  assert.match(home.stdout, new RegExp(`npm cache absent \\(${join(dir, '.npm')}\\), uv cache absent \\(${join(dir, '.cache', 'uv')}\\)`))
})
