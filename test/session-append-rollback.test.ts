import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { boot, settle } from '../src/boot.ts'
import { startWebServer, type WebServer } from '../src/server/web.ts'
import { appendWhole, NODE_APPEND_IO, NOTHING_WRITTEN, SessionUnsavedError, unsavedReason, type AppendIo } from '../src/session/append.ts'
import { SessionStore, type SessionEvent, type SessionHandle } from '../src/session/store.ts'
import { decodeTranscript, encodeFrame, FRAME_MAGIC, recoverTranscript } from '../src/session/transcript.ts'

/**
 * A failed append never leaves a partial frame that later appends sit behind, and the failure reaches the person in
 * words (#221, journey J183).
 *
 * Measured before, on both builds, with the session root on a 24 MB disk image: an append that met ENOSPC left its
 * partial frame mid-file; the turns answered after the filler was removed were appended after it; and the next start's
 * repair, right for a crash-torn tail (J155), cut the log at the tear and dropped them (`droppedBytes` 1243-2150). The
 * turn route said nothing in words: the error frame carried `ENOSPC: no space left on device, write` (TS) or the log's
 * absolute path and `(os error 28)` (Rust). DSH truncates a failed append back to the size it had
 * (dsh-session-persistence-jsonl lib/index.js:3299-3335). The disk here is an `AppendIo` that takes `room` bytes and
 * then refuses; the 70 check replays J183 on a real disk image. The Rust build is judged by `heddle-session`'s
 * `append::store_tests` and `transcript::recover_tests`, and heddle-server's
 * `a_turn_whose_prompt_cannot_be_saved_fails_in_words_on_the_stream_and_in_its_verdict`.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-append-rollback-')))
after(() => rmSync(scratch, { recursive: true, force: true }))

const WORDS = 'the session could not be saved: no space left on device'

/** A disk with `room` bytes left: a write takes what fits, then ENOSPC; a truncate fails with EIO when `cutFails`. */
function fullDisk(room: number, options: { readonly cutFails?: boolean } = {}): AppendIo & { room: number } {
  const disk = {
    ...NODE_APPEND_IO,
    room,
    write(fd: number, bytes: Uint8Array, offset: number, length: number): number {
      if (disk.room <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      const taken = NODE_APPEND_IO.write(fd, bytes, offset, Math.min(length, disk.room))
      disk.room -= taken
      return taken
    },
    truncate(fd: number, length: number): void {
      if (options.cutFails === true) throw Object.assign(new Error('EIO: i/o error, ftruncate'), { code: 'EIO' })
      NODE_APPEND_IO.truncate(fd, length)
    },
  }
  return disk
}

let counter = 0
function freshDir(label: string): string {
  counter += 1
  const dir = join(scratch, `${label}-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Text that compresses poorly, so its frame is far larger than the room the disk has left. */
function long(label: string): string {
  return `${label} ${randomBytes(3000).toString('base64')}`
}

function note(store: SessionStore, handle: SessionHandle, text: string): SessionEvent {
  return store.append(handle, { type: 'note', text })
}

function texts(events: readonly SessionEvent[]): string[] {
  return events.filter((event) => event.type === 'note').map((event) => String(event.text))
}

function seqsOf(events: readonly SessionEvent[]): number[] {
  return events.map((event) => event.seq)
}

/** A second store over the same root, after the first let go: the open the next process would make. */
function reopened(root: string, first: SessionStore, handle: SessionHandle): SessionStore {
  first.release(handle)
  const second = new SessionStore(root, { warn: () => {} })
  second.claim(handle)
  return second
}

test('an append in short writes lands whole', () => {
  const path = join(freshDir('short'), 'log')
  writeFileSync(path, 'whole')
  appendWhole(path, Buffer.from(' and more'), { ...NODE_APPEND_IO, write: (fd, bytes, offset, length) => NODE_APPEND_IO.write(fd, bytes, offset, Math.min(length, 3)) })
  assert.equal(readFileSync(path, 'utf8'), 'whole and more')
})

test('a write the disk refuses part-way is cut back, and the error says why in words', () => {
  const path = join(freshDir('refused'), 'log')
  writeFileSync(path, 'whole')
  const error = (() => {
    try {
      appendWhole(path, Buffer.from(' and twenty more bytes'), fullDisk(9))
    } catch (failure) {
      return failure
    }
    return assert.fail('the append should fail')
  })()
  assert.ok(error instanceof SessionUnsavedError)
  assert.equal(error.message, WORDS)
  assert.equal(error.poisoned, false)
  assert.equal(readFileSync(path, 'utf8'), 'whole', 'the partial bytes are gone: the file ends where it ended')
})

test('a cut that fails too is poisoned and keeps the write\'s reason', () => {
  const path = join(freshDir('poisoned'), 'log')
  writeFileSync(path, 'whole')
  assert.throws(
    () => appendWhole(path, Buffer.from(' and twenty more bytes'), fullDisk(9, { cutFails: true })),
    (error: unknown) => error instanceof SessionUnsavedError && error.poisoned && error.message === WORDS,
  )
  assert.equal(readFileSync(path).length, 5 + 9, 'the partial bytes stay: this is why the writer must refuse')
})

test('a write that takes nothing is a failure and is cut back', () => {
  const path = join(freshDir('zero'), 'log')
  writeFileSync(path, 'whole')
  assert.throws(
    () => appendWhole(path, Buffer.from('more'), { ...NODE_APPEND_IO, write: () => 0 }),
    (error: unknown) => error instanceof SessionUnsavedError && error.reason === NOTHING_WRITTEN,
  )
  assert.equal(readFileSync(path, 'utf8'), 'whole')
})

test('every known code has the Rust build\'s words, and an unknown one its own description without a path', () => {
  const words = (code: string) => unsavedReason(Object.assign(new Error(`${code}: whatever, write '/Users/someone/.heddle/x'`), { code }))
  assert.equal(words('ENOSPC'), 'no space left on device')
  assert.equal(words('EDQUOT'), 'disk quota exceeded')
  assert.equal(words('EROFS'), 'read-only file system')
  assert.equal(words('EACCES'), 'permission denied')
  assert.equal(words('EPERM'), 'operation not permitted')
  assert.equal(words('EIO'), 'input/output error')
  assert.equal(words('EFBIG'), 'file too large')
  assert.equal(words('ENOENT'), 'no such file or directory')
  assert.equal(unsavedReason(Object.assign(new Error("EXDEV: cross-device link not permitted, rename '/a' -> '/b'"), { code: 'EXDEV' })), 'cross-device link not permitted')
})

test('a store append the full disk refuses mid-frame is cut back, and the next lands right after the whole frames', () => {
  const root = freshDir('store')
  const store = new SessionStore(root)
  const handle = store.create({ cwd: root })
  note(store, handle, 't1')
  note(store, handle, 't2')
  const whole = readFileSync(handle.transcript)
  const count = store.count(handle)

  store.appendIo = fullDisk(100)
  assert.throws(() => note(store, handle, long('t4')), (error: unknown) => error instanceof SessionUnsavedError && error.message === WORDS)
  assert.ok(readFileSync(handle.transcript).equals(whole), 'the partial frame is gone: the log ends in the whole frames it had')
  assert.equal(store.count(handle), count, 'and the fold never took the event')

  store.appendIo = NODE_APPEND_IO
  const t6 = note(store, handle, 't6')
  assert.equal(t6.seq, count, 'the next append takes the failed one\'s seq')
  const afterwards = readFileSync(handle.transcript)
  assert.ok(afterwards.subarray(0, whole.length).equals(whole), 'and lands right after the whole frames')
  assert.equal(decodeTranscript(afterwards).torn, false)

  const next = reopened(root, store, handle)
  const events = next.read(handle)
  assert.deepEqual(texts(events), ['t1', 't2', 't6'], 'a reopen reads every whole event')
  assert.deepEqual(seqsOf(events), events.map((_, index) => index))
  assert.ok(!events.some((event) => event.type === 'transcript/repaired'), 'and has nothing to repair')
})

test('a cut that fails poisons the writer until the session is reopened, and the reopen cuts the torn tail', () => {
  const root = freshDir('poison')
  const store = new SessionStore(root, { warn: () => {} })
  const handle = store.create({ cwd: root })
  note(store, handle, 't1')
  const whole = readFileSync(handle.transcript).length

  store.appendIo = fullDisk(100, { cutFails: true })
  let first: unknown
  try {
    note(store, handle, long('t4'))
  } catch (error) {
    first = error
  }
  assert.ok(first instanceof SessionUnsavedError && first.poisoned && first.message === WORDS, String(first))
  const torn = readFileSync(handle.transcript)
  assert.equal(torn.length, whole + 100, 'the partial bytes stayed: the cut failed')

  store.appendIo = NODE_APPEND_IO
  assert.throws(() => note(store, handle, 't5'), (error: unknown) => error === first, 'a later append is refused with the same error, though the disk has room again')
  assert.ok(readFileSync(handle.transcript).equals(torn), 'and writes nothing after the torn bytes')

  const next = reopened(root, store, handle)
  note(next, handle, 't6')
  const events = next.read(handle)
  assert.deepEqual(texts(events), ['t1', 't6'], 'the reopen cut the torn tail and writes again')
  const repaired = events.filter((event) => event.type === 'transcript/repaired')
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0]?.droppedBytes, 100)
  assert.equal(decodeTranscript(readFileSync(handle.transcript)).torn, false)
})

test('a fork seed the disk refuses part-way leaves only whole frames', () => {
  const root = freshDir('seed')
  const store = new SessionStore(root)
  const source = store.create({ cwd: root })
  for (let index = 0; index < 6; index += 1) note(store, source, long(`source-${index}`))
  // Room for the child's session/created, then part of the seed batch.
  store.appendIo = fullDisk(2_000)
  assert.throws(() => store.fork(source.id), (error: unknown) => error instanceof SessionUnsavedError && error.message === WORDS)
  store.appendIo = NODE_APPEND_IO
  const childId = store.list().map((meta) => meta.id).find((id) => id !== source.id)
  assert.ok(childId !== undefined, 'the child was created before its seed failed')
  const child = store.open(childId)!
  const decoded = decodeTranscript(readFileSync(child.transcript))
  assert.equal(decoded.torn, false, 'the seed\'s partial batch is gone')
  assert.equal(decoded.lines.length, 1, 'the child holds its own session/created alone')
})

/** One event as the store frames it. */
function frame(seq: number, text: string): Buffer {
  return encodeFrame(`${JSON.stringify({ seq, at: '2026-11-01T00:00:00.000Z', type: 'note', text })}\n`)
}

function linesText(lines: readonly string[]): string[] {
  return lines.map((line) => String((JSON.parse(line) as { text: unknown }).text))
}

test('recover: a torn frame followed by whole frames is stepped over, and they are kept byte for byte', () => {
  const [e0, e1, torn, e2, e3] = [frame(0, 't1'), frame(1, 't2'), frame(2, 't4 never saved'), frame(2, 't6'), frame(3, 't6 answer')]
  const half = torn.subarray(0, Math.floor(torn.length / 2))
  const buffer = Buffer.concat([e0, e1, half, e2, e3])
  assert.equal(decodeTranscript(buffer).torn, true)
  const recovered = recoverTranscript(buffer)
  assert.ok(recovered !== undefined, 'whole frames follow the tear')
  assert.deepEqual(linesText(recovered.lines), ['t1', 't2', 't6', 't6 answer'])
  const at = e0.length + e1.length
  assert.deepEqual(recovered.dropped, [{ start: at, end: at + half.length }])
  const kept = Buffer.concat(recovered.kept.map((range) => buffer.subarray(range.start, range.end)))
  assert.ok(kept.equals(Buffer.concat([e0, e1, e2, e3])), 'every frame kept is copied as it was')
})

test('recover: a torn tail alone is left to the cut, and a whole log has nothing to step over', () => {
  const [e0, e1] = [frame(0, 't1'), frame(1, 't2')]
  assert.equal(recoverTranscript(Buffer.concat([e0, e1.subarray(0, e1.length - 3)])), undefined, 'J155: the store cuts it')
  assert.equal(recoverTranscript(Buffer.concat([e0, e1])), undefined)
})

test('recover: the whole frames a failed batch left before its tear are dropped with it', () => {
  const [e0, e1, orphan, torn, e2, e3] = [frame(0, 't1'), frame(1, 't2'), frame(2, 'closer one'), frame(3, 'closer two'), frame(2, 't6'), frame(3, 't6 answer')]
  const half = torn.subarray(0, Math.floor(torn.length / 2))
  const recovered = recoverTranscript(Buffer.concat([e0, e1, orphan, half, e2, e3]))
  assert.ok(recovered !== undefined)
  assert.deepEqual(linesText(recovered.lines), ['t1', 't2', 't6', 't6 answer'])
  const at = e0.length + e1.length
  assert.deepEqual(recovered.dropped, [{ start: at, end: at + orphan.length + half.length }])
})

test('recover: frames whose seqs do not join are not stepped onto', () => {
  const [e0, e1, torn, stray] = [frame(0, 't1'), frame(1, 't2'), frame(2, 'lost'), frame(7, 'from elsewhere')]
  assert.equal(recoverTranscript(Buffer.concat([e0, e1, torn.subarray(0, Math.floor(torn.length / 2)), stray])), undefined, 'the tear stays a tail, cut as before')
})

test('recover: a frame magic inside the torn bytes is not taken for a frame', () => {
  const [e0, torn, e1] = [frame(0, 't1'), frame(1, 'lost'), frame(1, 't6')]
  const garbage = Buffer.concat([torn.subarray(0, Math.floor(torn.length / 2)), FRAME_MAGIC, Buffer.from('\x24\x00\x00\x01not a frame at all', 'latin1')])
  const recovered = recoverTranscript(Buffer.concat([e0, garbage, e1]))
  assert.ok(recovered !== undefined)
  assert.deepEqual(linesText(recovered.lines), ['t1', 't6'])
  assert.equal((recovered.dropped[0]?.end ?? 0) - (recovered.dropped[0]?.start ?? 0), garbage.length)
})

test('recover: a tear after the last run is dropped as a tail', () => {
  const [e0, torn, e1, tail] = [frame(0, 't1'), frame(1, 'lost'), frame(1, 't6'), frame(2, 'cut')]
  const buffer = Buffer.concat([e0, torn.subarray(0, 10), e1, tail.subarray(0, tail.length - 2)])
  const recovered = recoverTranscript(buffer)
  assert.ok(recovered !== undefined)
  assert.deepEqual(linesText(recovered.lines), ['t1', 't6'])
  assert.equal(recovered.dropped.length, 2)
  assert.equal(recovered.dropped[1]?.end, buffer.length)
})

test('a log an older build tore in the middle keeps the turns after the tear on reopen, and the repair names what it took out', () => {
  const root = freshDir('mid-tear')
  const first = new SessionStore(root)
  const handle = first.create({ cwd: root })
  note(first, handle, 't1')
  const next = first.count(handle)
  first.release(handle)
  const torn = frame(next, long('t4'))
  const whole = readFileSync(handle.transcript)
  const cut = Math.floor(torn.length / 3)
  writeFileSync(handle.transcript, Buffer.concat([whole, torn.subarray(0, cut), frame(next, 't6'), frame(next + 1, 't6 answered')]))

  const store = new SessionStore(root)
  store.claim(handle)
  const events = store.read(handle)
  assert.deepEqual(texts(events), ['t1', 't6', 't6 answered'], 'the turns after the tear are kept')
  assert.deepEqual(seqsOf(events), events.map((_, index) => index))
  const repaired = events.at(-1)
  assert.equal(repaired?.type, 'transcript/repaired')
  assert.equal(repaired?.droppedBytes, cut)
  assert.deepEqual(repaired?.droppedRanges, [{ offset: whole.length, length: cut }], 'and the repair names the bytes it took out')
  const onDisk = decodeTranscript(readFileSync(handle.transcript))
  assert.equal(onDisk.torn, false, 'the log is written again whole')
  assert.equal(onDisk.lines.length, events.length)
  store.release(handle)
  assert.deepEqual(texts(new SessionStore(root).read(handle)), ['t1', 't6', 't6 answered'], 'and a later open reads the same')
})

/**
 * The turn route, in process: the shipped profile booted with a scripted endpoint, and the session store's disk filled
 * while a turn's prompt is written.
 */
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const routeHome = join(scratch, 'route')
let app: Awaited<ReturnType<typeof boot>> | undefined
let server: WebServer | undefined
let cookie = ''

before(async () => {
  mkdirSync(join(routeHome, 'work'), { recursive: true })
  process.env.HOME = routeHome
  process.env.HEDDLE_HOME = join(routeHome, 'heddle')
  process.env.HEDDLE_CONFIG = join(routeHome, 'heddle.json')
  writeFileSync(join(routeHome, 'script.json'), JSON.stringify({ steps: [{ text: 'answered' }] }))
  writeFileSync(
    process.env.HEDDLE_CONFIG,
    JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(routeHome, 'script.json'), model: 'scripted' }] }),
  )
  app = await boot({
    base: join(repoRoot, 'cordis.yml'),
    includeProjectPatch: true,
    configDir: routeHome,
    logLevel: 0,
    overrides: [{ patch: [{ id: 'session', config: { root: join(routeHome, 'sessions') } }] }],
  })
  await settle(app.ctx)
  server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'append-rollback-token', secretPath: join(routeHome, 'secret') })
  cookie = (((await fetch(server.url, { redirect: 'manual' })).headers.get('set-cookie')) ?? '').split(';')[0] ?? ''
})

after(async () => {
  await server?.close()
  await app?.dispose()
})

/** The `event:`/`data:` frames of a streamed answer. */
function framesOf(text: string): { name: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => ({ name: /^event: (.+)$/m.exec(block)?.[1], data: /^data: (.+)$/m.exec(block)?.[1] }))
    .filter((frame): frame is { name: string; data: string } => frame.name !== undefined && frame.data !== undefined)
    .map((frame) => ({ name: frame.name, data: JSON.parse(frame.data) as Record<string, unknown> }))
}

async function turn(body: Record<string, unknown>): Promise<Response> {
  assert.ok(server !== undefined, 'the server is up')
  return fetch(new URL('/api/turn', server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Standard error, collected while `run` runs. */
async function capturingStderr<T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr)
  let stderr = ''
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  try {
    return { value: await run(), stderr }
  } finally {
    process.stderr.write = original
  }
}

test('a turn whose prompt cannot be saved fails in words on its stream and in its detached verdict, and the next turn lands after the whole frames', { timeout: 60_000 }, async () => {
  assert.ok(app !== undefined && server !== undefined)
  const store = app.ctx.session.store
  const first = await turn({ prompt: 't1 remember the word loom', folder: join(routeHome, 'work') })
  const firstFrames = framesOf(await first.text())
  assert.ok(firstFrames.some((frame) => frame.name === 'done'), JSON.stringify(firstFrames))
  const id = String(firstFrames.find((frame) => frame.name === 'done')?.data.session)
  const handle = store.open(id)!
  const whole = readFileSync(handle.transcript)

  /** Streamed: the prompt's frame is cut part-way by the disk, and every later write fails too. */
  store.appendIo = fullDisk(64)
  const { value: streamed, stderr } = await capturingStderr(async () => (await turn({ session: id, prompt: long('t4') })).text())
  const failed = framesOf(streamed)
  const error = failed.find((frame) => frame.name === 'error')
  assert.ok(error !== undefined, `the stream ends in an error frame the page draws\n${streamed.slice(0, 2000)}`)
  assert.equal(error.data.message, WORDS, 'in words')
  assert.equal(error.data.session, id)
  assert.ok(!failed.some((frame) => frame.name === 'done'), 'and not as done')
  assert.ok(!failed.some((frame) => frame.name === 'session'), 'no event that failed to persist is sent as if it were saved')
  assert.ok(
    stderr.includes(`heddle web: the failed turn could not be recorded: ${WORDS}\n`),
    `the server says so on standard error, in the Rust build's words\n${stderr}`,
  )
  assert.ok(readFileSync(handle.transcript).equals(whole), 'and the log holds only the whole frames it had')

  /** Detached: the 202, then the verdict on the stream carries the same sentence. */
  const events = await fetch(new URL('/api/events', server.url), { headers: { cookie } })
  const reader = events.body!.getReader()
  const accepted = await turn({ session: id, prompt: long('t5'), detach: true })
  assert.equal(accepted.status, 202)
  const { turn: turnId } = (await accepted.json()) as { turn: string }
  let buffer = ''
  let verdict: Record<string, unknown> | undefined
  const deadline = Date.now() + 10_000
  while (verdict === undefined && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += Buffer.from(value).toString('utf8')
    verdict = framesOf(buffer).find((frame) => frame.name === 'turn' && frame.data.turn === turnId)?.data
  }
  await reader.cancel()
  assert.equal(verdict?.outcome, 'error', `the detached verdict says the turn failed\n${buffer.slice(-2000)}`)
  assert.equal(verdict?.message, WORDS)
  assert.ok(readFileSync(handle.transcript).equals(whole), 'the log is still whole')

  /** Space comes back: the next turn answers, after the whole frames, and a fresh store reads every event. */
  store.appendIo = NODE_APPEND_IO
  const sixth = framesOf(await (await turn({ session: id, prompt: 't6 after the space came back' })).text())
  assert.ok(sixth.some((frame) => frame.name === 'done') && !sixth.some((frame) => frame.name === 'error'), JSON.stringify(sixth))
  const afterwards = readFileSync(handle.transcript)
  assert.ok(afterwards.subarray(0, whole.length).equals(whole), 't6 lands right after the whole frames')
  const decoded = decodeTranscript(afterwards)
  assert.equal(decoded.torn, false)
  const said = decoded.lines
    .map((line) => JSON.parse(line) as SessionEvent)
    .filter((event) => event.type === 'message' && (event.message as { role?: string }).role === 'user')
    .map((event) => String(((event.message as { content: { text?: string }[] }).content[0]?.text ?? '').slice(0, 2)))
  assert.deepEqual(said, ['t1', 't6'], 'and a reader of the file sees t1 and t6, nothing torn between them')
})
