import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assert.throws(
      () => store.append(handle, { type: 'test/intruder' }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`^session "${id}" is already owned by an active write handle`))
        assert.match(error.message, new RegExp(`\\(process ${String(ready.pid)}\\)$`), 'and it names the process holding it')
        return true
      },
      'a second writer is refused while the holder is alive',
    )
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
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`, 'the lock names the holding process and nothing else')
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
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`, 'the stale lock was replaced by this process')
  next.release(handle)
})
