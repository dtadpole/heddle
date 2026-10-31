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
  parseMemory,
  readSlots,
  splitLoad,
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
  thresholds: { diskStopGb: 20, diskWarnGb: 26, loadWarnPerCore: 1.5, loadStopPerCore: 2, teamWarnPerCore: 1, teamStopPerCore: 1.3, memWarnPct: 30, memStopPct: 25, swapFreeWarnMb: 1280, swapFreeStopMb: 1024, slots: 3 },
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

  // The system load average is context now: the desktop's Spotlight or Chrome must not
  // make the team's verdict warn. The team's own cpu share decides.
  const systemBusy = assess({ ...base, load: [22, 18, 12] })
  assert.equal(systemBusy.loadVerdict, OK, 'system 2.2/core with no team processes is not a team problem')
  assert.equal(systemBusy.systemLoadPerCore, 2.2)

  const teamWarn = assess({ ...base, processes: [{ pid: 7, cpu: 1100, command: '/x/rustc' }] })
  assert.equal(teamWarn.teamPerCore, 1.1)
  assert.equal(teamWarn.loadVerdict, WARN)
  const teamStop = assess({ ...base, processes: [{ pid: 7, cpu: 1400, command: '/x/rustc' }] })
  assert.equal(teamStop.loadVerdict, STOP)

  // D-063: the backstop is swap free (total minus used), so it follows macOS growing swap
  const swapAt = (usedMb, totalMb = 10240) => assess({ ...base, swap: { totalMb, usedMb, freeMb: totalMb - usedMb } })
  assert.equal(swapAt(8900).swapVerdict, OK, '1340M free')
  assert.equal(swapAt(8961).swapVerdict, WARN, '1279M free: under the warn line')
  const edge = swapAt(9216)
  assert.equal(edge.swapVerdict, WARN, 'exactly 1024M free: a start is allowed, one at a time')
  assert.match(edge.findings.join(','), /swap: 1024M free, at least 1024M: one start at a time \(D-063\)/)
  const tight = swapAt(9217)
  assert.equal(tight.swapVerdict, STOP)
  assert.match(tight.findings.join(','), /swap: 1023M free < 1024M, nothing new starts \(D-063\)/)
  assert.equal(swapAt(9500, 12288).swapVerdict, OK, 'grown swap: the same use is fine against a larger total')

  // D-061: memory_pressure free is the gate
  const memAt = (freePct) => assess({ ...base, memory: { freePct } })
  assert.equal(memAt(30).memVerdict, OK)
  assert.equal(memAt(29).memVerdict, WARN)
  assert.equal(memAt(25).memVerdict, WARN, '25% free is at the line, not under it')
  const short = memAt(24)
  assert.equal(short.memVerdict, STOP)
  assert.equal(short.verdict, STOP)
  assert.match(short.findings.join(','), /memory: 24% free < 25%, nothing new starts \(D-061\)/)
  assert.equal(assess(base).memVerdict, OK, 'no reading, no memory finding')

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
  for (const line of ['load-check 2026-10-22T20:30:00-0700 (10 cores)', 'disk ', 'load ', 'team ', 'other ', 'swap ', 'slots ', 'worktrees ', 'builds ', 'verdict  ok']) {
    assert.ok(text.includes(line), `missing ${JSON.stringify(line)} in:\n${text}`)
  }
})

test('the team share and the desktop share are split from one process list, deterministically', () => {
  const worktreeProcs = [
    { pid: 10, cpu: 300, command: '/Users/x/.rustup/toolchains/1.99.1/bin/rustc', cwd: '/Users/x/heddle--one/rust' },
    { pid: 11, cpu: 100, command: 'node', cwd: '/Users/x/heddle--one' },
    { pid: 19, cpu: 50, command: 'Google Chrome', cwd: '/Applications/Google Chrome.app' },
  ]
  const allProcesses = [
    { pid: 10, cpu: 300, command: '/Users/x/.rustup/toolchains/1.99.1/bin/rustc' },
    { pid: 11, cpu: 100, command: 'node' },
    { pid: 12, cpu: 120, command: '/usr/libexec/mds_stores' },
    { pid: 13, cpu: 123, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: 14, cpu: 40, command: '/System/Library/WindowServer' },
    { pid: 15, cpu: 12, command: '/usr/libexec/mobileassetd' },
    { pid: 16, cpu: 8, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 17, cpu: 1, command: '/usr/bin/tail' },
    { pid: 18, cpu: 900, command: '/x/rustc' }, // a build whose cwd is not visible
  ]
  const split = splitLoad({ processes: worktreeProcs, allProcesses, ncpu: 10, home: '/Users/x' })
  assert.equal(split.teamCpu, 1300, 'worktree processes plus any cargo/rustc process')
  assert.equal(split.teamPerCore, 1.3)
  assert.equal(split.teamCount, 3)
  assert.ok(!split.other.some((proc) => proc.pid === 19), 'a desktop process is not team work')
  assert.deepEqual(split.other.map((proc) => proc.pid), [13, 12, 14, 15, 16], 'top five non-team by cpu, named in order')

  const sources = { ...base, processes: worktreeProcs, allProcesses, home: '/Users/x', load: [22, 18, 12], at: '2026-10-23T03:50:00-0700' }
  const assessment = assess(sources)
  assert.equal(assessment.teamPerCore, 1.3)
  assert.equal(assessment.loadVerdict, STOP)
  assert.match(assessment.findings.join(','), /load: team 1\.30\/core, system 2\.20\/core \(Google Chrome\)/)
  const text = format({ ...sources, assessment })
  assert.match(text, /team     13\.0 core\(s\) = 1\.30\/core \[stop\]/)
  assert.match(text, /other    Google Chrome 123%, mds_stores 120%, WindowServer 40%, mobileassetd 12%, ChatGPT 8%/)
  assert.match(text, /verdict  stop: load: team 1\.30\/core, system 2\.20\/core \(Google Chrome\)/)
})

test('thresholds come from the environment when they are set', () => {
  const t = thresholdsFrom({ LOAD_CHECK_DISK_WARN_GB: '40', LOAD_CHECK_SWAP_FREE_STOP_MB: '2048', LOAD_CHECK_SLOTS: '5' })
  assert.equal(t.diskWarnGb, 40)
  assert.equal(t.swapFreeStopMb, 2048)
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
    LOAD_CHECK_MEM_WARN_PCT: '0',
    LOAD_CHECK_MEM_STOP_PCT: '0',
    LOAD_CHECK_SWAP_FREE_WARN_MB: '0',
    LOAD_CHECK_SWAP_FREE_STOP_MB: '0',
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

test('memory_pressure is read and printed against the D-061 line', () => {
  assert.deepEqual(parseMemory('The system has 17179869184 (4194304 pages with a page size of 4096).\nSystem-wide memory free percentage: 41%\n'), { freePct: 41 })
  assert.throws(() => parseMemory('nothing here'), /memory_pressure not understood/)
  const sources = { ...base, memory: { freePct: 41 } }
  const text = format({ ...sources, at: 'now', thresholds: base.thresholds, assessment: assess(sources) })
  assert.match(text, /^memory   41% free \[ok\] \(D-061: warn < 30%, stop < 25%\)$/m)
  assert.match(text, /^swap .*, \d+M free \[\w+\] \(D-063: warn < 1280M free, stop < 1024M free\)$/m)
})
