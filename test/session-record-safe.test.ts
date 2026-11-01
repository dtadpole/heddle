import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, mock, test } from 'node:test'

import { projectLedger } from '../src/server/ledger.ts'
import { transcriptTurns } from '../src/server/web.ts'
import { existingSessionNames, writeSessionDefinition } from '../src/session/definition.ts'
import { inheritedByFork, lockPath, SessionStore, type SessionEvent, type SessionHandle, type SessionMeta } from '../src/session/store.ts'
import { titleFrom } from '../src/session/service.ts'

/**
 * Issue #195: a session whose `<id>.json` record is cut or missing while its log is intact.
 *
 * Measured before (developer-six, J175): the session vanished without a word — gone from the list, search, Rename and
 * Pin, no server line — while the TypeScript turn route still wrote turns into it. And the TypeScript store made that
 * state likely: it rewrote the record **in place** (`writeFileSync`, which truncates and then writes) on every prompt and
 * on every rename, pin, archive, preset and model switch, so a full disk or a process killed mid-write left it cut.
 *
 * The checks use the store's public surface only, so the file runs on a tree without the fix and fails there one check
 * at a time. A failing write is simulated by replacing `fs.writeFileSync` for this session's files with one that writes
 * half and throws `ENOSPC`, as a full disk does.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-record-safe-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function place(): { root: string; work: string } {
  counter += 1
  const root = join(scratch, `store-${counter}`)
  const work = join(scratch, `work-${counter}`)
  mkdirSync(work, { recursive: true })
  return { root, work: realpathSync(work) }
}

const user = (text: string, source?: unknown) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }], ...(source !== undefined ? { source } : {}) })
const assistant = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }] })
const record = (handle: SessionHandle): SessionMeta => JSON.parse(readFileSync(handle.meta, 'utf8')) as SessionMeta
const leftovers = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'))

/** Run `act` while every write to session `id`'s record writes half of its bytes and then fails with `ENOSPC`. */
function withFullDisk<T>(id: string, act: () => T): T {
  const real = fs.writeFileSync
  mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    /** The record or its temporary file; the log's append (which Node also writes through writeFileSync) goes through. */
    if (typeof path === 'string' && path.includes(id) && (path.endsWith('.json') || path.endsWith('.tmp'))) {
      const text = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
      real(path, text.slice(0, Math.floor(text.length / 2)))
      throw Object.assign(new Error(`ENOSPC: no space left on device, write`), { code: 'ENOSPC' })
    }
    return real(path, data, options)
  })
  syncBuiltinESMExports()
  try {
    return act()
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
}

test('a record write that fails part-way leaves the old record whole: rename, pin, archive, preset and model switch', () => {
  const { root, work } = place()
  const store = new SessionStore(root, { warn: () => {} })
  const handle = store.create({ cwd: work, title: 'before' })
  const before = record(handle)
  const writes: ReadonlyArray<readonly [string, () => unknown]> = [
    ['rename', () => store.rename(handle.id, 'after')],
    ['pin', () => store.flags(handle.id, { pinned: true })],
    ['archive', () => store.flags(handle.id, { archived: true })],
    ['preset', () => store.recordPreset(handle.id, 'reviewer')],
    ['model switch', () => store.setModel(handle.id, { endpoint: 'other', model: 'm' })],
  ]
  for (const [name, write] of writes) {
    assert.throws(() => withFullDisk(handle.id, write), /ENOSPC/, `the ${name} reports the failed write`)
    assert.deepEqual(record(handle), before, `after a failed ${name} the record holds what it held, whole`)
    assert.deepEqual(leftovers(handle.dir), [], `and the ${name} left no temporary file beside it`)
    assert.equal(store.list().find((meta) => meta.id === handle.id)?.title, 'before', `so the session is still listed with its title after the ${name}`)
  }
})

test("a prompt whose record write fails part-way keeps the turn and the old record whole", () => {
  const { root, work } = place()
  const store = new SessionStore(root, { warn: () => {} })
  const handle = store.create({ cwd: work })
  store.message(handle, user('first'))
  const before = record(handle)
  withFullDisk(handle.id, () => store.message(handle, user('second')))
  assert.deepEqual(record(handle), before, 'the record a prompt failed to update is the one before it, not a cut one')
  assert.deepEqual(leftovers(handle.dir), [], 'and nothing is left beside it')
  assert.deepEqual(
    store.read(handle).filter((event) => event.type === 'message').map((event) => (event.message as { content: { text: string }[] }).content[0]?.text),
    ['first', 'second'],
    'the turn itself is in the log',
  )
  assert.ok(store.list().some((meta) => meta.id === handle.id), 'and the session is listed')
})

test('the atomic writer: a write that throws mid-way leaves the target as it was and no temporary file', async () => {
  const fsio = await import('../src/session/fsio.ts').catch(() => null)
  assert.ok(fsio !== null, 'the store has a whole-file writer (src/session/fsio.ts)')
  const dir = join(scratch, `fsio-${counter++}`)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'session-x.json')
  writeFileSync(target, '{\n  "id": "old"\n}\n')
  assert.throws(() => withFullDisk('session-x', () => fsio.writeFileAtomic(target, '{\n  "id": "new and longer"\n}\n')), /ENOSPC/)
  assert.equal(readFileSync(target, 'utf8'), '{\n  "id": "old"\n}\n', 'the old bytes, whole')
  assert.deepEqual(leftovers(dir), [], 'and no temporary file')
  fsio.writeFileAtomic(target, '{\n  "id": "new"\n}\n')
  assert.equal(readFileSync(target, 'utf8'), '{\n  "id": "new"\n}\n', 'a write that succeeds replaces it whole')
  assert.deepEqual(readdirSync(dir), ['session-x.json'], 'and leaves only the target')
})

/** Three sessions in one folder: bravo named by a person (definition and record), echo by its first message, charlie pinned. */
function fixture() {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const bravo = writer.create({ cwd: work })
  writeSessionDefinition(bravo, work, { createdAt: new Date().toISOString(), taken: existingSessionNames(work), title: 'bravo note' })
  writer.rename(bravo.id, 'bravo note')
  writer.message(bravo, user('tell me about herons'))
  writer.message(bravo, assistant('herons wade'))
  const echo = writer.create({ cwd: work })
  writer.message(echo, user('echo: what do herons eat?'))
  writer.rename(echo.id, titleFrom('echo: what do herons eat?'))
  writer.message(echo, assistant('fish'))
  writer.message(echo, user('a goal round', { kind: 'goal', goalId: 'g', revision: 1, round: 1 }))
  const charlie = writer.create({ cwd: work })
  writer.flags(charlie.id, { pinned: true })
  for (const handle of [bravo, echo, charlie]) writer.release(handle)
  return { root, work, writer, bravo, echo, charlie }
}

function restarted(root: string): { store: SessionStore; lines: string[] } {
  const lines: string[] = []
  return { store: new SessionStore(root, { warn: (line: string) => lines.push(line) }), lines }
}

/** What the log says a rebuilt record must hold. */
function expected(writer: SessionStore, handle: SessionHandle, title: string): Partial<SessionMeta> {
  const events = writer.read(handle)
  const prompts = events.filter((event) => event.type === 'message' && (event.message as { role?: string; source?: unknown }).role === 'user')
  const person = prompts.filter((event) => (event.message as { source?: unknown }).source === undefined)
  return { id: handle.id, created: events[0]?.at, title, turns: prompts.length, updated: person.at(-1)?.at }
}

test('a cut record and a missing one, each with an intact log, are rebuilt from the log, listed, and named once', () => {
  const { root, work, writer, bravo, echo, charlie } = fixture()
  const charlieBefore = readFileSync(charlie.meta, 'utf8')
  const bravoText = readFileSync(bravo.meta, 'utf8')
  writeFileSync(bravo.meta, bravoText.slice(0, Math.floor(bravoText.length / 2)))
  rmSync(echo.meta)
  const { store, lines } = restarted(root)

  const listed = store.list()
  const byId = new Map(listed.map((meta) => [meta.id, meta]))
  for (const [handle, title] of [
    [bravo, 'bravo note'],
    [echo, 'echo: what do herons eat'],
  ] as const) {
    const meta = byId.get(handle.id)
    assert.ok(meta !== undefined, `${handle.id} is listed\n${JSON.stringify(listed, null, 2)}`)
    assert.equal(meta.cwd, work, 'with the folder its session/created names')
    const want = expected(writer, handle, title)
    assert.deepEqual(
      { id: meta.id, created: meta.created, title: meta.title, turns: meta.turns, updated: meta.updated },
      want,
      'with its creation time, its title, its turns and its last prompt, from the log',
    )
    assert.deepEqual(record(handle), meta, 'and its record is written back whole, holding what the list shows')
    assert.deepEqual(leftovers(handle.dir), [], 'with no temporary file left beside it')
  }
  assert.equal(byId.get(charlie.id)?.pinned, true, 'a healthy session keeps its own record')
  assert.equal(readFileSync(charlie.meta, 'utf8'), charlieBefore, 'untouched')

  assert.equal(lines.length, 2, `one line for each rebuilt record\n${lines.join('\n')}`)
  const bravoLine = lines.find((line) => line.includes(bravo.meta))
  const echoLine = lines.find((line) => line.includes(echo.meta))
  assert.ok(
    bravoLine?.startsWith(`heddle session: rebuilt the record ${bravo.meta} from its log ${bravo.transcript} (the record could not be read): `),
    `the cut record is named, with its log\n${lines.join('\n')}`,
  )
  assert.match(bravoLine ?? '', /title from its definition in the folder/, 'and where its title came from')
  assert.ok(
    echoLine?.startsWith(`heddle session: rebuilt the record ${echo.meta} from its log ${echo.transcript} (the record was missing): `),
    `the missing record is named, with its log\n${lines.join('\n')}`,
  )
  assert.match(echoLine ?? '', /title from its first message/, 'and where its title came from')
  for (const line of lines) {
    assert.match(line, /not in the log, so as a new session has them: endpoint, model, preset, pin, archive, parent session, team$/, 'saying what the log could not give')
  }

  store.list()
  assert.ok(store.open(bravo.id) !== null && store.open(echo.id) !== null, 'both open')
  assert.ok(store.meta(bravo.id) !== null && store.meta(echo.id) !== null, 'and both answer meta')
  assert.equal(lines.length, 2, 'however often they are listed or opened, each is named once')

  const again = restarted(root)
  assert.ok(again.store.list().some((meta) => meta.id === echo.id) && again.store.list().some((meta) => meta.id === bravo.id), 'after a restart both are still listed')
  assert.deepEqual(again.lines, [], 'from their records, with nothing to repair')
})

test('a session whose record is missing opens, and takes a turn, before anything lists it', () => {
  const { root, echo } = fixture()
  rmSync(echo.meta)
  const { store, lines } = restarted(root)
  const handle = store.open(echo.id)
  assert.ok(handle !== null, 'it opens: its record is rebuilt from its log')
  assert.equal(lines.length, 1, `and the repair is named\n${lines.join('\n')}`)
  store.message(handle, user('one more'))
  const meta = store.list().find((one) => one.id === echo.id)
  assert.equal(meta?.turns, 3, 'the turn is counted on the rebuilt record')
  assert.equal(lines.length, 1, 'with no second line')
})

test('a record cut while its session is open is rebuilt by the next prompt, which it counts', () => {
  const { root, work } = place()
  const lines: string[] = []
  const store = new SessionStore(root, { warn: (line: string) => lines.push(line) })
  const handle = store.create({ cwd: work })
  store.message(handle, user('first'))
  writeFileSync(handle.meta, '{\n  "id": "sess')
  store.message(handle, user('second'))
  const meta = record(handle)
  assert.equal(meta.id, handle.id, 'the record reads again')
  assert.equal(meta.turns, 2, 'and counts both prompts')
  assert.equal(meta.updated, store.read(handle).at(-1)?.at, 'and is dated by the latest one')
  assert.equal(lines.length, 1, `one line names the repair\n${lines.join('\n')}`)
})

test('a record its log cannot rebuild leaves the session out, opens as no session, and is named once', () => {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const empty = writer.create({ cwd: work })
  const loose = writer.create({ cwd: work })
  const healthy = writer.create({ cwd: work })
  for (const handle of [empty, loose, healthy]) writer.release(handle)
  writeFileSync(empty.meta, '{"id": "ses')
  writeFileSync(empty.transcript, '')
  writeFileSync(loose.meta, '')
  rmSync(loose.transcript)
  const { store, lines } = restarted(root)

  const ids = store.list().map((meta) => meta.id)
  assert.ok(ids.includes(healthy.id), 'a healthy session is listed')
  assert.ok(!ids.includes(empty.id) && !ids.includes(loose.id), 'the two that cannot be rebuilt are not')
  assert.equal(store.open(empty.id), null, 'and they open as no session, as the list answers')
  assert.equal(store.open(loose.id), null)
  store.list()
  assert.deepEqual(
    lines.sort(),
    [
      `heddle session: skipped session ${empty.id}: its record ${empty.meta} cannot be read, and its log ${empty.transcript} holds no session/created to rebuild it from`,
      `heddle session: skipped session ${loose.id}: its record ${loose.meta} cannot be read, and it has no log to rebuild it from`,
    ].sort(),
    'each is named once',
  )
  assert.equal(readFileSync(empty.meta, 'utf8'), '{"id": "ses', 'and its record is left as it was')
  assert.ok(!readdirSync(dirname(empty.meta)).some((name) => name.endsWith('.tmp')))
})

/**
 * The follow-up on #195 (developer-six): a rebuilt record lost the pin and the archive, so an archived session whose
 * record was cut came back as an ordinary row. DSH keeps both outside the session's header (registry sets), so a damaged
 * header never loses them. Here a change of either appends `session/flags` to the session's own log, the whole state after
 * the change, and the rebuild folds the last one.
 */
const flagEvents = (store: SessionStore, handle: SessionHandle): SessionEvent[] => store.read(handle).filter((event) => event.type === 'session/flags')

test('a pin or archive appends one session/flags event, the whole state after it, and a change of nothing writes none', () => {
  const { root, work } = place()
  const store = new SessionStore(root, { warn: () => {} })
  const handle = store.create({ cwd: work })
  store.flags(handle.id, { pinned: true })
  const pinned = flagEvents(store, handle)
  assert.equal(pinned.length, 1, 'a pin is one event')
  assert.deepEqual(Object.keys(pinned[0] ?? {}), ['seq', 'at', 'type', 'pinned', 'archived', 'pinnedAt'], 'in the order both builds write it')
  assert.deepEqual({ pinned: pinned[0]?.pinned, archived: pinned[0]?.archived, pinnedAt: pinned[0]?.pinnedAt }, { pinned: true, archived: false, pinnedAt: record(handle).pinnedAt })
  store.flags(handle.id, { pinned: false })
  store.flags(handle.id, { pinned: false })
  store.flags(handle.id, { archived: false })
  const after = flagEvents(store, handle)
  assert.equal(after.length, 2, 'an unpin is one more, and asking for what already holds writes nothing')
  assert.deepEqual(Object.keys(after[1] ?? {}), ['seq', 'at', 'type', 'pinned', 'archived'], 'an unpinned state carries no pin time')
  store.flags(handle.id, { archived: true })
  assert.deepEqual(flagEvents(store, handle).map((event) => [event.pinned, event.archived]), [[true, false], [false, false], [false, true]])
})

test('archive, then cut: the rebuilt record is archived, and its line says the pin and archive came from the log', () => {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const handle = writer.create({ cwd: work })
  writer.message(handle, user('file this away'))
  writer.flags(handle.id, { archived: true })
  writer.release(handle)
  const text = readFileSync(handle.meta, 'utf8')
  writeFileSync(handle.meta, text.slice(0, Math.floor(text.length / 2)))
  const { store, lines } = restarted(root)
  const meta = store.list().find((one) => one.id === handle.id)
  assert.equal(meta?.archived, true, 'the session comes back archived, not as an ordinary row')
  assert.equal(meta?.pinned, undefined, 'and unpinned, as it was')
  assert.equal(record(handle).archived, true, 'its record says so on disk')
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /cwd, created, turns, last prompt, pin and archive from the log, /, `the line names the flags among what the log gave\n${lines[0]}`)
  assert.match(lines[0] ?? '', /not in the log, so as a new session has them: endpoint, model, preset, parent session, team$/, 'and not among the defaults')
})

test('pin, then remove the record: the rebuilt record is pinned, from when it was pinned', () => {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const handle = writer.create({ cwd: work })
  const pinnedAt = writer.flags(handle.id, { pinned: true })?.pinnedAt
  assert.ok(pinnedAt !== undefined)
  writer.release(handle)
  rmSync(handle.meta)
  const { store } = restarted(root)
  const meta = store.list().find((one) => one.id === handle.id)
  assert.equal(meta?.pinned, true, 'pinned again')
  assert.equal(meta?.pinnedAt, pinnedAt, 'with the time of the pin, so pinned rows keep their order')
  assert.equal(meta?.archived, undefined)
})

test('a newer session/flags event supersedes an older one', () => {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const archivedAfterPin = writer.create({ cwd: work })
  writer.flags(archivedAfterPin.id, { pinned: true })
  writer.flags(archivedAfterPin.id, { archived: true })
  const unpinned = writer.create({ cwd: work })
  writer.flags(unpinned.id, { pinned: true })
  writer.flags(unpinned.id, { pinned: false })
  const unarchived = writer.create({ cwd: work })
  writer.flags(unarchived.id, { archived: true })
  writer.flags(unarchived.id, { archived: false })
  for (const handle of [archivedAfterPin, unpinned, unarchived]) {
    writer.release(handle)
    rmSync(handle.meta)
  }
  const { store, lines } = restarted(root)
  const byId = new Map(store.list().map((meta) => [meta.id, meta]))
  assert.deepEqual([byId.get(archivedAfterPin.id)?.pinned, byId.get(archivedAfterPin.id)?.archived], [undefined, true], 'a pin then an archive: archived, the pin dropped as the archive dropped it')
  assert.deepEqual([byId.get(unpinned.id)?.pinned, byId.get(unpinned.id)?.archived], [undefined, undefined], 'a pin then an unpin: neither')
  assert.deepEqual([byId.get(unarchived.id)?.pinned, byId.get(unarchived.id)?.archived], [undefined, undefined], 'an archive then an unarchive: neither')
  assert.equal(lines.filter((line) => line.includes('pin and archive from the log')).length, 3, 'each says its flags came from the log')
})

test('a store lets go of a session after its flags event, and another process\'s writer keeps the event out while the flags stand', () => {
  const { root, work } = place()
  const writer = new SessionStore(root, { warn: () => {} })
  const handle = writer.create({ cwd: work })
  writer.release(handle)
  const lines: string[] = []
  const page = new SessionStore(root, { warn: (line: string) => lines.push(line) })
  page.flags(handle.id, { pinned: true })
  assert.equal(flagEvents(page, handle).length, 1, 'the pin is in the log')
  assert.equal(page.holds(handle), false, 'and the store that wrote it holds the session no longer')
  assert.throws(() => readFileSync(lockPath(handle)), /ENOENT/, 'its writer lock is gone')
  writeFileSync(lockPath(handle), `${process.ppid}\n`)
  try {
    page.flags(handle.id, { archived: true })
  } finally {
    rmSync(lockPath(handle), { force: true })
  }
  assert.equal(record(handle).archived, true, 'the archive stands in the record')
  assert.equal(flagEvents(new SessionStore(root, { warn: () => {} }), handle).length, 1, 'but no event was appended to a log another process writes')
  assert.deepEqual(lines, [`heddle session: the pin and archive of ${handle.id} are in its record only, not its log: session "${handle.id}" is already owned by an active write handle (process ${process.ppid})`])
})

test('readers take session/flags as metadata: a fork does not inherit it, the chat does not draw it or split on it, the ledger has no row for it', () => {
  assert.equal(inheritedByFork('session/flags'), false)
  const { root, work } = place()
  const store = new SessionStore(root, { warn: () => {} })
  const source = store.create({ cwd: work })
  store.message(source, user('hello'))
  store.append(source, { type: 'model/request', endpoint: 'e', messages: 1, tools: [] })
  store.append(source, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'one ' } })
  store.flags(source.id, { pinned: true })
  store.append(source, { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } })
  store.append(source, { type: 'assistant/chunk', chunk: { type: 'done', finishReason: 'stop' } })
  store.append(source, { type: 'assistant/completed', text: 'one answer' })
  store.append(source, { type: 'turn/completed', rounds: 1 })
  const events = store.read(source)
  assert.equal(events.filter((event) => event.type === 'session/flags').length, 1, 'the pin landed mid-answer')

  const turns = transcriptTurns(events as never)
  assert.deepEqual(
    turns.filter((turn) => turn.kind === 'assistant').map((turn) => turn.text),
    ['one answer'],
    'the answer is one row, not two split at the pin',
  )
  const ledger = projectLedger(events as never)
  const labels = [...ledger.turns.flatMap((turn) => turn.steps.flatMap((step) => step.records)), ...ledger.loose].map((one) => one.label)
  assert.ok(!labels.includes('session/flags'), `no ledger row for it\n${labels.join(', ')}`)

  const child = store.fork(source.id)
  assert.ok(child !== null)
  assert.deepEqual(flagEvents(store, child), [], 'the fork does not carry the source\'s pin')
  assert.equal(store.list().find((meta) => meta.id === child.id)?.pinned, undefined)
})

test('a session folder the store cannot read is named once, and the other workspaces still list (J180)', (context) => {
  /**
   * developer-six's J180 on #195: a workspace's session folder at mode 000 hid every session of that workspace from the
   * list, search, get and turn, and the server said nothing. The folder is named, not read and not repaired.
   */
  if (process.getuid?.() === 0) {
    context.skip('root reads a folder at mode 000')
    return
  }
  const { root, work } = place()
  const elsewhere = `${work}-elsewhere`
  mkdirSync(elsewhere, { recursive: true })
  const writer = new SessionStore(root, { warn: () => {} })
  const hidden = writer.create({ cwd: work })
  const shown = writer.create({ cwd: elsewhere })
  for (const handle of [hidden, shown]) writer.release(handle)
  const { chmodSync } = fs
  chmodSync(hidden.dir, 0o000)
  try {
    const { store, lines } = restarted(root)
    const ids = () => store.list().map((meta) => meta.id)
    assert.deepEqual(ids(), [shown.id], 'the other workspace\'s session still lists')
    ids()
    assert.deepEqual(lines, [`heddle session: skipped the session folder ${hidden.dir}: permission denied, so none of its sessions is listed`], 'the folder is named once')
    chmodSync(hidden.dir, 0o755)
    assert.deepEqual(new Set(ids()), new Set([hidden.id, shown.id]), 'once it reads again its sessions list')
    chmodSync(hidden.dir, 0o000)
    ids()
    assert.equal(lines.length, 2, 'and a later failure is named anew')
  } finally {
    chmodSync(hidden.dir, 0o755)
  }
})
