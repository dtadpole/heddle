import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  formatLock,
  judgeLock,
  type LockProbe,
  ownedSentence,
  parseLock,
  parseProcStat,
  parsePsLine,
  type ProcessFacts,
} from '../src/session/writer-lock.ts'

/**
 * The writer lock's protocol as data (#202): the lock files either build writes or meets, and the rules that judge a
 * lock whose holder may be gone. `session-lock.fixtures.json` is read by the Rust build's suite as well
 * (`rust/crates/heddle-session/tests/writer_lock.rs`), so a lock one build writes is the lock the other reads. The
 * rules are judged over a made-up system here; `session-lock.test.ts` judges them over real processes.
 */

interface Fixtures {
  readonly locks: readonly { name: string; bytes: string; pid: number | null; boot: string | null; start: string | null; written: boolean }[]
  readonly ps: readonly { name: string; line: string; uid: number; start: string; command: string }[]
  readonly procStat: readonly { name: string; line: string; start: string; command: string }[]
}

const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, 'session-lock.fixtures.json'), 'utf8')) as Fixtures

test('every shared lock file reads as the pid, boot and start it holds, and a written one is the bytes this build writes', () => {
  for (const lock of fixtures.locks) {
    const parsed = parseLock(lock.bytes)
    if (lock.pid === null) {
      assert.equal(parsed, undefined, `${lock.name}: names no process`)
      continue
    }
    assert.deepEqual(
      parsed,
      { pid: lock.pid, ...(lock.boot !== null ? { boot: lock.boot } : {}), ...(lock.start !== null ? { start: lock.start } : {}) },
      lock.name,
    )
    if (lock.written) assert.equal(formatLock(parsed!), lock.bytes, `${lock.name}: written byte for byte`)
  }
})

test('a ps line and a /proc stat line read as the start and the command name they hold', () => {
  for (const line of fixtures.ps) {
    const facts = parsePsLine(line.line)
    assert.deepEqual(facts, { start: line.start, startedAt: Number(line.start), uid: line.uid, name: line.command }, line.name)
  }
  for (const line of fixtures.procStat) {
    assert.deepEqual(parseProcStat(line.line), { start: line.start, name: line.command }, line.name)
  }
})

/** A made-up system: one boot, and the processes it is told about. */
function probe(boot: string | undefined, processes: Record<number, ProcessFacts>): LockProbe {
  return { boot: () => boot, facts: (pid) => processes[pid] ?? null }
}

const NOW = 1_793_563_380_000
const BOOT = 'A16D6C9D-EDEC-4146-9050-6215AF208215'
const ME = 501

test('a lock is stale when its pid is gone, its boot is another, or its pid names a process with another start', () => {
  const system = probe(BOOT, { 700: { start: '1793560000', startedAt: 1_793_560_000, uid: ME, name: 'heddle' } })
  const file = (text: string) => ({ text, mtimeMs: NOW - 60_000, uid: ME })
  assert.deepEqual(judgeLock(file(`700 boot=${BOOT} start=1793560000\n`), system, NOW), { kind: 'held', pid: 700, name: 'heddle' })
  assert.equal(judgeLock(file(`701 boot=${BOOT} start=1793560000\n`), system, NOW).kind, 'stale', 'its pid is gone')
  assert.equal(judgeLock(file(`700 boot=B start=1793560000\n`), system, NOW).kind, 'stale', 'another boot')
  assert.equal(judgeLock(file(`700 boot=${BOOT} start=1793559999\n`), system, NOW).kind, 'stale', 'another start')
  assert.equal(
    judgeLock(file(`700 boot=${BOOT}\n`), system, NOW).kind,
    'held',
    'a lock with no start and a mtime after its process started belongs to it',
  )
  assert.equal(
    judgeLock(file(`700 boot=B start=1793560000\n`), probe(undefined, { 700: { start: '1793560000', uid: ME } }), NOW).kind,
    'held',
    'a boot the system cannot say decides nothing',
  )
})

test('a pid-only lock is stale when its pid names a process that started after the lock was written', () => {
  const started = (startedAt: number) => probe(BOOT, { 700: { start: String(startedAt), startedAt, uid: ME } })
  const written = NOW - 3_600_000
  const file = { text: '700\n', mtimeMs: written, uid: ME }
  assert.equal(judgeLock(file, started(written / 1000 + 600), NOW).kind, 'stale', 'started ten minutes after the lock')
  assert.equal(judgeLock(file, started(written / 1000 - 600), NOW).kind, 'held', 'started before the lock: its holder')
  assert.equal(judgeLock(file, started(written / 1000 + 4), NOW).kind, 'held', 'within the margin a corrected clock may need')
  assert.equal(judgeLock(file, probe(BOOT, { 700: { uid: ME } }), NOW).kind, 'held', 'a start the system cannot say decides nothing')
})

test('a lock whose pid names a process of another user is stale: the file belongs to its writer\'s user (EPERM, pid 1)', () => {
  const system = probe(BOOT, { 1: { start: '1791095069', startedAt: 1_791_095_069, uid: 0, name: 'launchd' } })
  assert.equal(judgeLock({ text: '1\n', mtimeMs: NOW, uid: ME }, system, NOW).kind, 'stale', 'pid 1, root\'s, in this user\'s lock')
  assert.equal(judgeLock({ text: '1\n', mtimeMs: NOW, uid: 0 }, system, NOW).kind, 'held', 'root\'s lock naming root\'s process')
  assert.equal(judgeLock({ text: '1\n', mtimeMs: NOW }, system, NOW).kind, 'held', 'an owner the system cannot say decides nothing')
})

test('a lock that names no process is being written for five seconds, and debris after; a future time is young', () => {
  const system = probe(BOOT, {})
  assert.deepEqual(judgeLock({ text: '', mtimeMs: NOW - 1_000 }, system, NOW), { kind: 'held' })
  assert.equal(judgeLock({ text: '', mtimeMs: NOW - 6_000 }, system, NOW).kind, 'stale')
  assert.deepEqual(judgeLock({ text: 'x', mtimeMs: 2_145_830_400_000 }, system, NOW), { kind: 'held' })
})

test('the refusal names the process and the lock file, and says how to clear it, in the Rust build\'s words', () => {
  assert.equal(
    ownedSentence('session-a', 46183, 'sleep', 'session-a.lock'),
    'session "session-a" is already owned by an active write handle (process 46183, sleep). Its lock file is session-a.lock, beside the session\'s log; if process 46183 is not heddle, delete that file and try again.',
  )
  assert.equal(
    ownedSentence('session-a', 46183, undefined, 'session-a.lock'),
    'session "session-a" is already owned by an active write handle (process 46183). Its lock file is session-a.lock, beside the session\'s log; if process 46183 is not heddle, delete that file and try again.',
  )
  assert.equal(
    ownedSentence('session-a', undefined, undefined, 'session.lock'),
    'session "session-a" is already owned by an active write handle. Its lock file is session.lock, beside the session\'s log; if no heddle is writing this session, delete that file and try again.',
  )
  assert.equal(ownedSentence('session-a'), 'session "session-a" is already owned by an active write handle', 'DSH\'s sentence alone')
})
