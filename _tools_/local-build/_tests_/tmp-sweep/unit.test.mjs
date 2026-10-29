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

test('stale heddle-*, hd-*-browser-*, scoped_dir* and com.google.Chrome* entries go; others stay', (t) => {
  const dir = folder(t)
  const gone = [
    entry(dir, 'heddle-server-test-views-ab12', 3),
    entry(dir, 'hd-developer-five-browser-x1', 3),
    entry(dir, 'scoped_dir1234_567', 3),
    entry(dir, 'com.google.Chrome.abc', 3, { file: true }),
  ]
  const kept = [entry(dir, 'com.apple.launchd.x', 30), entry(dir, 'heddlefoo', 30), entry(dir, 'my-notes', 30, { file: true })]
  const r = sweep({ dir, now: NOW, commands: '' })
  assert.deepEqual(r.removed, { 'heddle-*': 1, 'hd-*-browser-*': 1, 'scoped_dir*': 1, 'com.google.Chrome*': 1 })
  for (const p of gone) assert.equal(existsSync(p), false, p)
  for (const p of kept) assert.equal(existsSync(p), true, p)
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
  const dry = spawnSync(SCRIPT, ['--dry-run', '--dir', dir], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /would remove 1 \(heddle-\* 1, hd-\*-browser-\* 0, scoped_dir\* 0, com\.google\.Chrome\* 0\)/)
  assert.equal(existsSync(p), true)
  const real = spawnSync(SCRIPT, ['--dir', dir], { encoding: 'utf8' })
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /removed 1 \(heddle-\* 1/)
  assert.equal(existsSync(p), false)
  assert.equal(spawnSync(SCRIPT, ['--age-minutes', 'soon'], { encoding: 'utf8' }).status, 64)
})
