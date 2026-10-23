import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  OK,
  STOP,
  WARN,
  assess,
  countBuilds,
  format,
  groupWorktrees,
  parseDf,
  parseLoadavg,
  parseLsof,
  parseOwner,
  parsePs,
  parseSwap,
  readSlots,
  thresholdsFrom,
} from '../../load-check.mjs'

const SCRIPT = join(import.meta.dirname, '..', '..', 'load-check.mjs')

const DF = `Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s5     239362496 130710900  63206936    68% 1583234 632069360    0%   /System/Volumes/Data
`

const base = {
  disk: { filesystem: '/dev/disk3s5', totalKb: 239362496, usedKb: 130710900, availKb: 63206936, mount: '/System/Volumes/Data' },
  load: [10, 9, 6],
  ncpu: 10,
  swap: { totalMb: 6144, usedMb: 1000, freeMb: 5144 },
  slots: [
    { index: 0, state: 'busy', pid: 100, cargo: 101, age: 30, cwd: '/Users/x/heddle--one' },
    { index: 1, state: 'free' },
    { index: 2, state: 'free' },
  ],
  processes: [],
  thresholds: { diskStopGb: 20, diskWarnGb: 26, loadWarnPerCore: 1.5, loadStopPerCore: 2, swapWarnPct: 75, swapStopPct: 95, slots: 3 },
}

test('the machine sources are parsed from the commands a Mac answers with', () => {
  assert.deepEqual(parseDf(DF), base.disk)
  assert.deepEqual(parseLoadavg('{ 10.77 9.34 6.85 }'), [10.77, 9.34, 6.85])
  assert.deepEqual(parseSwap('total = 6144.00M  used = 4891.44M  free = 1252.56M  (encrypted)'), {
    totalMb: 6144,
    usedMb: 4891.44,
    freeMb: 1252.56,
  })
})

test('an owner file is read in both formats, and a directory with a space stays whole', () => {
  assert.deepEqual(parseOwner('100 1792725000 101 /Users/x/heddle--one\n'), {
    pid: 100,
    stamp: 1792725000,
    cargo: 101,
    cwd: '/Users/x/heddle--one',
  })
  assert.deepEqual(parseOwner('100 1792725000 /Users/x/heddle--one\n'), {
    pid: 100,
    stamp: 1792725000,
    cargo: 0,
    cwd: '/Users/x/heddle--one',
  })
  assert.equal(parseOwner('100 1792725000 101 /Users/x/my worktree\n').cwd, '/Users/x/my worktree')
})

test('readSlots names free, busy, stale and unclaimed slots, and recomputes age', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'load-check-slots-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'slot-0'))
  writeFileSync(join(root, 'slot-0', 'owner'), '100 100 200 /tmp/a\n')
  mkdirSync(join(root, 'slot-1'))
  writeFileSync(join(root, 'slot-1', 'owner'), '300 100 0 /tmp/b\n')
  mkdirSync(join(root, 'slot-2'))
  const now = 100_000_000 // milliseconds; the stamp is seconds
  const alive = (pid) => pid === 100 || pid === 200
  const slots = readSlots({ root, slots: 3, now, alive })
  assert.equal(slots[0].state, 'busy')
  assert.equal(slots[0].age, 99_900)
  assert.equal(slots[1].state, 'stale')
  assert.equal(slots[2].state, 'unclaimed')
})

test('lsof and ps output become processes with a working directory and a cpu share', () => {
  const lsof = 'p100\ncnode\nfcwd\nn/Users/x/heddle--one/rust\np200\nccargo\nfcwd\nn/Users/x/heddle\np300\ncnode\nn/tmp\n'
  const parsed = parseLsof(lsof)
  assert.deepEqual(parsed[0], { pid: 100, command: 'node', cwd: '/Users/x/heddle--one/rust' })
  assert.equal(parsed.length, 3)
  const ps = parsePs('  100   12.5   1.2  03:10 node --test\n  200  0.0  0.1  01:00 cargo check\n')
  assert.equal(ps.get(100).cpu, 12.5)
  assert.equal(ps.get(200).elapsed, '01:00')
})

test('worktrees are grouped by seat, sorted by cpu, and ignore everything outside ~/heddle--*', () => {
  const groups = groupWorktrees(
    [
      { pid: 1, cwd: '/Users/x/heddle--one/rust', cpu: 50, command: 'rustc' },
      { pid: 2, cwd: '/Users/x/heddle--one', cpu: 5, command: 'node' },
      { pid: 3, cwd: '/Users/x/heddle--two', cpu: 70, command: 'cargo' },
      { pid: 4, cwd: '/Users/x/heddle', cpu: 90, command: 'node' },
      { pid: 5, cwd: '/tmp', cpu: 90, command: 'node' },
    ],
    '/Users/x',
  )
  assert.deepEqual(groups.map((g) => g.worktree), ['heddle--two', 'heddle--one'])
  assert.equal(groups[1].processes.length, 2)
  assert.equal(groups[1].cpu, 55)
})

test('build processes are counted by name', () => {
  const counts = countBuilds([
    { command: '/Users/x/.rustup/toolchains/1.99.1/bin/cargo' },
    { command: '/Users/x/.rustup/toolchains/1.99.1/bin/rustc' },
    { command: 'rustc' },
    { command: '/usr/bin/cc' },
    { command: 'node' },
  ])
  assert.deepEqual(counts, { cargo: 1, rustc: 2, other: 1 })
})

test('the assessment warns and stops at the working model\'s lines', () => {
  const ok = assess(base)
  assert.equal(ok.verdict, OK)

  const diskWarn = assess({ ...base, disk: { ...base.disk, availKb: 25 * 1024 * 1024 } })
  assert.equal(diskWarn.diskVerdict, WARN)
  const diskStop = assess({ ...base, disk: { ...base.disk, availKb: 19 * 1024 * 1024 } })
  assert.equal(diskStop.diskVerdict, STOP)

  assert.equal(assess({ ...base, load: [15, 9, 6] }).loadVerdict, WARN)
  assert.equal(assess({ ...base, load: [20, 9, 6] }).loadVerdict, STOP)

  assert.equal(assess({ ...base, swap: { totalMb: 6144, usedMb: 4700, freeMb: 1444 } }).swapVerdict, WARN)
  assert.equal(assess({ ...base, swap: { totalMb: 6144, usedMb: 6000, freeMb: 144 } }).swapVerdict, STOP)

  const stale = assess({ ...base, slots: [...base.slots.slice(1), { index: 2, state: 'stale', pid: 9, cargo: 0, age: 5, cwd: '/x' }] })
  assert.equal(stale.slotVerdict, WARN)
  assert.match(stale.findings.join(','), /slots: 1 stale/)

  const tooMany = assess({ ...base, processes: Array.from({ length: 10 }, () => ({ command: 'rustc' })) })
  assert.equal(tooMany.buildVerdict, WARN, 'ten rustc from three slots of three jobs is a build outside the runner')
  assert.equal(tooMany.verdict, WARN)

  const worst = assess({ ...base, disk: { ...base.disk, availKb: 10 * 1024 * 1024 }, swap: { totalMb: 6144, usedMb: 6100, freeMb: 44 } })
  assert.equal(worst.verdict, STOP, 'the worst finding decides')
})

test('the report is plain lines with a verdict, the slots, the worktrees and the builds', () => {
  const sources = { ...base, at: '2026-10-22T20:30:00-0700' }
  const assessment = assess(sources)
  const text = format({ ...sources, assessment })
  for (const line of ['load-check 2026-10-22T20:30:00-0700 (10 cores)', 'disk ', 'load ', 'swap ', 'slots ', 'worktrees ', 'builds ', 'verdict  ok']) {
    assert.ok(text.includes(line), `missing ${JSON.stringify(line)} in:\n${text}`)
  }
})

test('thresholds come from the environment when they are set', () => {
  const t = thresholdsFrom({ LOAD_CHECK_DISK_WARN_GB: '40', LOAD_CHECK_SWAP_STOP_PCT: '99', LOAD_CHECK_SLOTS: '5' })
  assert.equal(t.diskWarnGb, 40)
  assert.equal(t.swapStopPct, 99)
  assert.equal(t.slots, 5)
  assert.equal(t.diskStopGb, 20, 'an unset threshold keeps its default')
})

test('the command exits 0 on a healthy machine and 1 on a stale slot', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'load-check-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const slots = join(home, '.hd-build-slots')
  mkdirSync(slots, { recursive: true })
  const relaxed = {
    PATH: process.env.PATH,
    HOME: home,
    LOAD_CHECK_DISK_WARN_GB: '0',
    LOAD_CHECK_DISK_STOP_GB: '0',
    LOAD_CHECK_LOAD_WARN_PER_CORE: '1000',
    LOAD_CHECK_LOAD_STOP_PER_CORE: '1001',
    LOAD_CHECK_SWAP_WARN_PCT: '1000',
    LOAD_CHECK_SWAP_STOP_PCT: '2000',
    LOAD_CHECK_SLOTS: '30',
  }
  const healthy = spawnSync(process.execPath, [SCRIPT, '--home', home, '--slots', slots], { encoding: 'utf8', env: relaxed })
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr)
  assert.match(healthy.stdout, /verdict  ok/)

  mkdirSync(join(slots, 'slot-0'))
  writeFileSync(join(slots, 'slot-0', 'owner'), '999999 1 0 /tmp/gone\n')
  const stale = spawnSync(process.execPath, [SCRIPT, '--home', home, '--slots', slots], { encoding: 'utf8', env: relaxed })
  assert.equal(stale.status, 1, stale.stdout + stale.stderr)
  assert.match(stale.stdout, /verdict  warn: slots: 1 stale/)
})
