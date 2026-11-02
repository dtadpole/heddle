import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

import { SessionStore } from '../src/session/store.ts'
import { decodeTranscript } from '../src/session/transcript.ts'

/**
 * One writer per session log, across processes.
 *
 * The defect this pins (R-developer-eight-27): a `heddle web` server held a session while the command line's
 * `--resume <id> --turn` appended to the same log. Each process kept its own fold and its own seq counter, so the
 * log received seqs 14-19 twice and each process saw a different history. DSH prevents it with a write lock
 * beside the log (`session.lock`, taken at write-open; a second writer is refused with
 * `session "<id>" is already owned by an active write handle`). These checks use a **real second process**,
 * because a lock that only excludes writers inside one process is not the lock the defect needed.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-lock-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * What the #202 checks need to know about this system, read **here** from the sources the protocol names rather than
 * through `src/session/writer-lock.ts`, so a check cannot agree with the code it judges by construction: this boot's
 * id, and a process's start and command name. The lock file then is `<pid> boot=<boot> start=<start>\n`.
 */
const identityReadable = process.platform === 'darwin' || process.platform === 'linux'

/** The modification time a lock with identity carries, 2037-12-31T00:00:00Z: young to a build from before #202. */
const IDENTIFIED_MTIME_S = 2_145_830_400

function bootId(): string | undefined {
  if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (process.platform === 'darwin') return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim()
  return undefined
}

/** A process's start: field 22 of `/proc/<pid>/stat` on Linux; on macOS its `lstart`, UTC, as seconds since 1970. */
function processStart(pid: number): string | undefined {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
  }
  if (process.platform === 'darwin') {
    const env = { LC_ALL: 'C', TZ: 'UTC0' }
    const lstart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env }).trim().replace(/\s+/g, ' ')
    return execFileSync('/bin/date', ['-j', '-u', '-f', '%a %b %e %T %Y', lstart, '+%s'], { encoding: 'utf8', env }).trim()
  }
  return undefined
}

/** A process's command name: `/proc/<pid>/comm` on Linux, `ucomm` on macOS. */
function commandName(pid: number): string | undefined {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  if (process.platform === 'darwin') return execFileSync('/bin/ps', ['-o', 'ucomm=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C' } }).trim()
  return undefined
}

/** A lock file's bytes for a pid, a boot and a start. */
function lockBytes(pid: number, boot: string | undefined, start: string | undefined): string {
  return `${pid}${boot !== undefined ? ` boot=${boot}` : ''}${start !== undefined ? ` start=${start}` : ''}\n`
}

/** The lock this process writes. */
function ownLockBytes(): string {
  return lockBytes(process.pid, bootId(), processStart(process.pid))
}

/** The refusal, word for word (#202): DSH's sentence, the process, the lock file, and how to clear it. */
function refusal(id: string, pid: number, name: string | undefined, lock: string): string {
  return (
    `session "${id}" is already owned by an active write handle (process ${pid}${name !== undefined ? `, ${name}` : ''}). ` +
    `Its lock file is ${lock}, beside the session's log; if process ${pid} is not heddle, delete that file and try again.`
  )
}

/** A live process that is not heddle, standing in for one the system gave a dead holder's pid to (J178's `sleep`). */
async function unrelatedProcess(): Promise<ChildProcess & { pid: number }> {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  assert.ok(child.pid !== undefined)
  return child as ChildProcess & { pid: number }
}

/** Stop such a process and wait until it is reaped. */
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

/** A session this process created and let go of, so its lock file can be written as another process left it. */
function releasedSession(name: string): { root: string; id: string; lock: string } {
  const root = join(scratch, name)
  const store = new SessionStore(root)
  const handle = store.create({ cwd: scratch })
  store.release(handle)
  return { root, id: handle.id, lock: join(handle.dir, `${handle.id}.lock`) }
}

/** Append once from a fresh store, as the next server would after a restart: the event, or the refusal. */
function appendFresh(root: string, id: string): { seq: number; lock: string } | Error {
  const store = new SessionStore(root)
  const handle = store.open(id)
  assert.ok(handle !== null)
  try {
    const event = store.append(handle, { type: 'test/after-a-crash' })
    const lock = readFileSync(join(handle.dir, `${handle.id}.lock`), 'utf8')
    store.release(handle)
    return { seq: event.seq, lock }
  } catch (error) {
    return error as Error
  }
}

/** Whether a fresh store's reader sees the session held (it shows an unfinished turn as still running only then). */
function heldForReaders(root: string, id: string): boolean {
  const store = new SessionStore(root)
  const handle = store.open(id)
  assert.ok(handle !== null)
  return store.writerHeld(handle)
}

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'session', 'store.ts')).href

/**
 * A second process that creates (or opens) a session, appends to it, and then waits for orders on stdin:
 * `append` writes one more event, anything else is ignored. It reports each step on stdout as a JSON line.
 */
function writerProcess(root: string, id: string, cwd: string): { child: ChildProcessWithoutNullStreams; next: () => Promise<Record<string, unknown>> } {
  const script = join(scratch, `writer-${id}.mjs`)
  writeFileSync(
    script,
    [
      `import { SessionStore } from ${JSON.stringify(storeUrl)}`,
      `import { createInterface } from 'node:readline'`,
      `const store = new SessionStore(${JSON.stringify(root)})`,
      `const handle = store.open(${JSON.stringify(id)}) ?? store.create({ id: ${JSON.stringify(id)}, cwd: ${JSON.stringify(cwd)} })`,
      `store.append(handle, { type: 'test/writer', step: 'first' })`,
      `process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, count: store.count(handle) }) + '\\n')`,
      `for await (const line of createInterface({ input: process.stdin })) {`,
      `  if (line.trim() !== 'append') continue`,
      `  store.append(handle, { type: 'test/writer', step: 'second' })`,
      `  process.stdout.write(JSON.stringify({ appended: true, count: store.count(handle) }) + '\\n')`,
      `}`,
    ].join('\n'),
  )
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let stderr = ''
  const waiting: ((value: Record<string, unknown>) => void)[] = []
  const lines: Record<string, unknown>[] = []
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const parsed = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>
      buffer = buffer.slice(at + 1)
      const resolve = waiting.shift()
      if (resolve === undefined) lines.push(parsed)
      else resolve(parsed)
    }
  })
  const next = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const ready = lines.shift()
      if (ready !== undefined) return resolve(ready)
      const timer = setTimeout(() => reject(new Error(`the writer process said nothing within 10s\n${stderr}`)), 10_000)
      waiting.push((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  return { child, next }
}

/** Kill a process and wait until it is gone (and reaped), so its pid is dead when the next line runs. */
async function killed(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

/** The seqs a log holds, read from the bytes on disk rather than from any process's memory. */
function seqsOnDisk(path: string): number[] {
  return decodeTranscript(readFileSync(path)).lines.map((line) => (JSON.parse(line) as { seq: number }).seq)
}

test('a second process cannot append to a session another live process is writing, and takes over once it is gone', async () => {
  const root = join(scratch, 'store-live')
  const id = 'session-lock-live'
  const writer = writerProcess(root, id, scratch)
  try {
    const ready = await writer.next()
    assert.equal(ready.ready, true, `the writer process created the session\n${JSON.stringify(ready)}`)

    const store = new SessionStore(root)
    const handle = store.open(id)
    assert.ok(handle !== null, 'the session the other process wrote is found')
    /** Reading is never refused, and it loads this process's fold before the other process writes again. */
    assert.equal(store.read(handle).length, 2, 'session/created and the writer event are read')

    writer.child.stdin.write('append\n')
    const appended = await writer.next()
    assert.equal(appended.appended, true, 'the holder keeps writing')
    const before = readFileSync(handle.transcript)

    /** The defect: this append used to succeed with seq 2 — a seq the holder had already written. */
    const pid = Number(ready.pid)
    assert.throws(
      () => store.append(handle, { type: 'test/intruder' }),
      (error: Error) => {
        assert.equal(
          error.message,
          refusal(id, pid, commandName(pid), `${id}.lock`),
          'it names the process holding it, the lock file, and what to do when that process is not heddle (#202)',
        )
        return true
      },
      'a second writer is refused while the holder is alive',
    )
    assert.equal(store.writerHeld(handle), true, 'and a reader sees the session held')
    assert.ok(readFileSync(handle.transcript).equals(before), 'and the refusal wrote nothing to the log')

    /** A holder that dies without letting go (SIGKILL runs no cleanup) leaves a lock naming a dead process. */
    await killed(writer.child)
    const taken = store.append(handle, { type: 'test/successor' })
    assert.equal(taken.seq, 3, 'the successor continues after the holder\'s last event rather than from its own stale count')
    const seqs = seqsOnDisk(handle.transcript)
    assert.deepEqual(seqs, [0, 1, 2, 3], 'no seq is written twice')
    assert.deepEqual(
      store.read(handle).map((event) => event.type),
      ['session/created', 'test/writer', 'test/writer', 'test/successor'],
      'and this process now sees the history the file holds',
    )
  } finally {
    await killed(writer.child)
  }
})

test('the lock is a file beside the log naming its holder, and letting go removes it', () => {
  const root = join(scratch, 'store-file')
  const store = new SessionStore(root)
  const handle = store.create({ cwd: scratch })
  const lock = join(handle.dir, `${handle.id}.lock`)
  assert.ok(existsSync(lock), `the writer holds ${lock}`)
  assert.equal(readFileSync(lock, 'utf8'), ownLockBytes(), 'the lock names the holding process, its boot and its start (#202)')
  if (identityReadable) {
    assert.equal(statSync(lock).mtimeMs, IDENTIFIED_MTIME_S * 1000, 'and a lock with identity carries the time a build from before #202 reads as young')
  }
  store.release(handle)
  assert.equal(existsSync(lock), false, 'letting go removes the lock')
  /** The log itself is untouched by any of it, and still reads. */
  assert.deepEqual(new SessionStore(root).read(handle).map((event) => event.type), ['session/created'])
})

test('a lock left by a process that no longer exists does not block the next writer', async () => {
  const root = join(scratch, 'store-stale')
  const store = new SessionStore(root)
  const handle = store.create({ cwd: scratch })
  store.release(handle)
  /** A pid that was alive a moment ago and is not now. */
  const gone = spawn(process.execPath, ['-e', ''])
  const pid = gone.pid
  await new Promise<void>((resolve) => gone.once('exit', () => resolve()))
  assert.ok(pid !== undefined)
  const lock = join(handle.dir, `${handle.id}.lock`)
  writeFileSync(lock, `${pid}\n`)

  const next = new SessionStore(root)
  const event = next.append(next.open(handle.id)!, { type: 'test/after-a-crash' })
  assert.equal(event.seq, 1)
  assert.equal(readFileSync(lock, 'utf8'), ownLockBytes(), 'the stale lock was replaced by this process')
  next.release(handle)
})

/**
 * Issue #202 (J178): after a crash every lock the server held names its dead pid, and when the system gives that pid to
 * another live process — or the lock names pid 1, which this user may not signal — every later turn was refused with
 * `already owned by an active write handle (process N)` for as long as that process lived, with nothing saying what to
 * do. DSH's flock dies with its holder (dsh-session-persistence-jsonl lib/index.js:692-716). Each check below writes
 * the lock as the crashed holder left it, then appends from a fresh store, as the next server does.
 */

test('a pid-only lock whose pid now names a live process that started after the lock was written is taken over (#202)', async () => {
  const { root, id, lock } = releasedSession('reuse-pid-only')
  const other = await unrelatedProcess()
  try {
    /** The lock a build before #202 left an hour ago; its pid is now the unrelated process's. */
    writeFileSync(lock, `${other.pid}\n`)
    const anHourAgo = Date.now() / 1000 - 3600
    utimesSync(lock, anHourAgo, anHourAgo)
    assert.equal(heldForReaders(root, id), false, 'a reader does not take the unrelated process for the writer')
    const taken = appendFresh(root, id)
    assert.ok(!(taken instanceof Error), `the next writer takes the lock\n${taken instanceof Error ? taken.message : ''}`)
    assert.equal(taken.seq, 1)
    assert.equal(taken.lock, ownLockBytes(), 'and the lock now names this process')
  } finally {
    await stopped(other)
  }
})

test('a lock that records another start than its pid now has is taken over (#202)', async (context) => {
  if (!identityReadable) return context.skip('no process start on this system')
  const { root, id, lock } = releasedSession('reuse-start')
  const other = await unrelatedProcess()
  try {
    writeFileSync(lock, lockBytes(other.pid, bootId(), '1'))
    assert.equal(heldForReaders(root, id), false, 'a reader does not take the unrelated process for the writer')
    const taken = appendFresh(root, id)
    assert.ok(!(taken instanceof Error), `the next writer takes the lock\n${taken instanceof Error ? taken.message : ''}`)
    assert.equal(taken.lock, ownLockBytes())
  } finally {
    await stopped(other)
  }
})

test('a lock written in another boot is taken over, even when its pid and start match a live process (#202)', async (context) => {
  if (!identityReadable) return context.skip('no boot id on this system')
  const { root, id, lock } = releasedSession('other-boot')
  const other = await unrelatedProcess()
  try {
    writeFileSync(lock, lockBytes(other.pid, '00000000-0000-4000-8000-000000000000', processStart(other.pid)))
    assert.equal(heldForReaders(root, id), false)
    const taken = appendFresh(root, id)
    assert.ok(!(taken instanceof Error), `the next writer takes the lock\n${taken instanceof Error ? taken.message : ''}`)
    assert.equal(taken.lock, ownLockBytes())
  } finally {
    await stopped(other)
  }
})

test('a pid-only lock naming pid 1, a process this user may not signal, is taken over (#202)', (context) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return context.skip('pid 1 is this user\'s here')
  const { root, id, lock } = releasedSession('pid-one')
  /** Written just now, so pid 1 started long before it: the rule that decides is the user, not the start. */
  writeFileSync(lock, '1\n')
  assert.equal(heldForReaders(root, id), false, 'a reader does not take pid 1 for the writer')
  const taken = appendFresh(root, id)
  assert.ok(!(taken instanceof Error), `the next writer takes the lock\n${taken instanceof Error ? taken.message : ''}`)
  assert.equal(taken.lock, ownLockBytes())
})

test('a lock whose holder is alive and is the process it records is refused, naming the process and the file (#202)', async (context) => {
  if (!identityReadable) return context.skip('no process start on this system')
  const { root, id, lock } = releasedSession('live-holder')
  const holder = await unrelatedProcess()
  try {
    const written = lockBytes(holder.pid, bootId(), processStart(holder.pid))
    writeFileSync(lock, written)
    assert.equal(heldForReaders(root, id), true, 'a reader sees the session held')
    const refused = appendFresh(root, id)
    assert.ok(refused instanceof Error, 'a live holder is never expropriated')
    assert.equal(refused.message, refusal(id, holder.pid, commandName(holder.pid), `${id}.lock`))
    assert.equal(readFileSync(lock, 'utf8'), written, 'and its lock is left as it was')
    /** A pid-only lock written after its process started is that process's too. */
    writeFileSync(lock, `${holder.pid}\n`)
    const again = appendFresh(root, id)
    assert.ok(again instanceof Error, 'a pid-only lock naming a live process that started before it is still held')
    assert.equal(again.message, refusal(id, holder.pid, commandName(holder.pid), `${id}.lock`))
  } finally {
    await stopped(holder)
  }
  /** Once it is gone, the lock is taken. */
  const taken = appendFresh(root, id)
  assert.ok(!(taken instanceof Error), `the next writer takes the lock\n${taken instanceof Error ? taken.message : ''}`)
})

/**
 * Issue #248: the Rust build never removed its lock files (the release was in a destructor that no exit ran), so every
 * session a process wrote kept a lock naming its dead pid. This build lets go in its exit handler, on a clean exit and on
 * a failing one alike; these pin that, and the Rust build's binary is judged the same way in
 * `rust/crates/heddle/tests/writer_locks_at_exit.rs` and in verifier 70.
 */
test('a process that wrote sessions leaves no lock behind when it exits, cleanly or with a failure (#248)', async () => {
  for (const ending of ['return', 'throw', 'exit 3']) {
    const root = join(scratch, `exit-${ending.replace(' ', '-')}`)
    const script = join(scratch, `exit-${ending.replace(' ', '-')}.mjs`)
    writeFileSync(
      script,
      [
        `import { SessionStore } from ${JSON.stringify(storeUrl)}`,
        `const store = new SessionStore(${JSON.stringify(root)})`,
        `for (let n = 0; n < 3; n += 1) store.append(store.create({ cwd: ${JSON.stringify(scratch)} }), { type: 'test/writer' })`,
        ending === 'throw' ? `throw new Error('the run failed')` : ending === 'exit 3' ? 'process.exit(3)' : '',
      ].join('\n'),
    )
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] })
    const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)))
    assert.equal(code === 0, ending === 'return', `the writer ended as asked (${ending}): exit ${code}`)
    const store = new SessionStore(root)
    const sessions = store.list()
    assert.equal(sessions.length, 3, `${ending}: the three sessions were written`)
    for (const meta of sessions) {
      const handle = store.open(meta.id)
      assert.ok(handle !== null)
      assert.equal(existsSync(join(handle.dir, `${handle.id}.lock`)), false, `${ending}: no lock is left for ${meta.id}`)
    }
  }
})
