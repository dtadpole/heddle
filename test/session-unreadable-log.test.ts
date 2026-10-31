import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { existingSessionNames, writeSessionDefinition } from '../src/session/definition.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'
import { frameEnd } from '../src/session/transcript.ts'
import { tree, type TreeNode } from '../src/session/tree.ts'

/**
 * Issue #130: one session log that is not a readable log, and the rest of the store.
 *
 * DSH's JSONL backend judges a session by its header before it lists it: "Unreadable or unsupported headers, including
 * corrupt Zstandard header frames, are omitted from discovery and `list()`. Direct access to a corrupt compressed header
 * still rejects." (dsh-session-persistence-jsonl README; `listArtifacts`, lib/index.js:3102-3138). heddle's log has no
 * header line, so its first record is the one judged. Measured before the fix: a log holding 64 random bytes, or the
 * line `{"not":"zstd"}`, was listed and opened, and the next server start stopped half-way on reading it.
 *
 * The checks use only the store's public surface, and reach `loads` through an optional call, so the same file runs
 * on a tree without the fix and fails there one check at a time.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-unreadable-log-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A store with three sessions in one folder (one with a message, two blank), and the lines it printed. */
function fixture(): { root: string; work: string; turned: SessionHandle; blank: SessionHandle; damaged: SessionHandle } {
  counter += 1
  const root = join(scratch, `store-${counter}`)
  const work = join(scratch, `work-${counter}`)
  const writer = new SessionStore(root, { warn: () => {} })
  const turned = writer.create({ cwd: work })
  writer.message(turned, { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  writer.message(turned, { role: 'assistant', content: [{ type: 'text', text: 'a remembered answer' }] })
  const blank = writer.create({ cwd: work })
  const damaged = writer.create({ cwd: work })
  for (const handle of [turned, blank, damaged]) writer.release(handle)
  return { root, work, turned, blank, damaged }
}

/** A fresh store over the same root, as a restarted server has, collecting what it prints. */
function restarted(root: string): { store: SessionStore; lines: string[] } {
  const lines: string[] = []
  return { store: new SessionStore(root, { warn: (line: string) => lines.push(line) }), lines }
}

const ids = (store: SessionStore) => store.list().map((meta) => meta.id)
const loads = (store: SessionStore, handle: SessionHandle): unknown => (store as unknown as { loads?: (one: SessionHandle) => boolean }).loads?.(handle)

for (const [damage, bytes, reason] of [
  ['64 random bytes', Buffer.from('79ac1a9d5df6abd7a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff00112233445566778899aabbccddeeff0011223344556677', 'hex'), 'its first record is not valid JSON'],
  ['the line {"not":"zstd"}', Buffer.from('{"not":"zstd"}\n'), 'its first record is not a session event'],
] as const) {
  test(`a log holding ${damage} is left out of the list, opens as no session, and is named once`, () => {
    const { root, turned, blank, damaged } = fixture()
    writeFileSync(damaged.transcript, bytes)
    const { store, lines } = restarted(root)

    const listed = ids(store)
    assert.ok(listed.includes(turned.id) && listed.includes(blank.id), `every healthy session is listed\n${listed.join('\n')}`)
    assert.ok(!listed.includes(damaged.id), 'the session whose log cannot be read is not')
    assert.equal(store.open(damaged.id), null, 'and direct access to it is refused: it opens as no session')

    const opened = store.open(turned.id)
    assert.ok(opened !== null, 'a healthy session opens')
    assert.deepEqual(store.messages(opened).map((message) => message.role), ['user', 'assistant'], 'and reads whole')
    assert.ok(store.open(blank.id) !== null, 'so does the healthy blank one')

    ids(store)
    ids(store)
    assert.deepEqual(lines, [`heddle session: skipped unreadable log ${damaged.transcript}: ${reason}`], 'one line names the file, however often the store is listed')
    assert.ok(readFileSync(damaged.transcript).equals(bytes), 'and the file is left as it was')
  })
}

test('a first zstd frame that is complete but fails its checksum is left out, and its log is not cut back', () => {
  /**
   * DSH: a header frame that fails validation is corruption, omitted from `list()` (`readFirstZstdLine`,
   * lib/index.js:3403). Measured before: the store read such a frame as a torn tail at byte 0, and the first write-open
   * cut the whole log back to nothing and recorded `transcript/repaired`.
   */
  const { root, turned, damaged } = fixture()
  const whole = readFileSync(turned.transcript)
  const first = frameEnd(whole, 0)
  assert.ok(first !== undefined)
  const corrupt = Buffer.from(whole)
  corrupt[first - 1] = (corrupt[first - 1] ?? 0) ^ 0xff
  writeFileSync(damaged.transcript, corrupt)
  const { store, lines } = restarted(root)

  assert.ok(!ids(store).includes(damaged.id), 'the session is not listed')
  assert.equal(store.open(damaged.id), null, 'and does not open')
  assert.deepEqual(lines, [`heddle session: skipped unreadable log ${damaged.transcript}: its first zstd frame does not decode`])
  assert.ok(readFileSync(damaged.transcript).equals(corrupt), 'the log keeps every byte')
})

test('the shapes the store always tolerated still list and open: an empty log, a missing one, a torn tail, a torn first frame', () => {
  const { root, turned, blank, damaged } = fixture()
  const torn = readFileSync(turned.transcript)
  truncateSync(turned.transcript, torn.length - 7)
  truncateSync(blank.transcript, readFileSync(blank.transcript).length - 7)
  writeFileSync(damaged.transcript, '')
  const { store, lines } = restarted(root)

  assert.deepEqual(new Set(ids(store)), new Set([turned.id, blank.id, damaged.id]), 'all three are listed')
  for (const handle of [turned, blank, damaged]) assert.ok(store.open(handle.id) !== null, `${handle.id} opens`)
  rmSync(damaged.transcript)
  assert.ok(ids(store).includes(damaged.id), 'a session whose log is missing entirely is still listed')
  assert.ok(store.open(damaged.id) !== null, 'and still opens')
  assert.deepEqual(lines, [], 'and nothing is reported as skipped')
})

test('a log whose first record reads but a later line does not is listed, and the startup sweep leaves it out with one line', () => {
  /**
   * DSH lists a session by its header and finds a damaged body when it is opened. heddle's server reads every session
   * at startup (the goal and team sweeps), so `loads` answers which ones read whole, naming a failure once.
   */
  const { root, turned, damaged } = fixture()
  const log = damaged.transcript
  const head = `${JSON.stringify({ seq: 0, at: new Date().toISOString(), type: 'session/created', cwd: scratch })}\n`
  writeFileSync(log, `${head}{"not":"an event"}\nnot json at all\n`)
  const { store, lines } = restarted(root)

  assert.ok(ids(store).includes(damaged.id), 'its first record is a session event, so it is listed, as DSH lists a readable header')
  const handle = store.open(damaged.id)
  assert.ok(handle !== null)
  assert.equal(loads(store, handle), false, 'the sweep is told it does not read whole')
  assert.equal(loads(store, handle), false, 'and told again when the second sweep asks')
  assert.throws(() => store.read(handle), /:2 is not a session event/, 'reading it refuses at the line that is not an event')
  const healthy = store.open(turned.id)
  assert.ok(healthy !== null)
  assert.equal(loads(store, healthy), true, 'a healthy log reads whole')
  assert.deepEqual(lines, [`heddle session: skipped unreadable log ${log}: line 2 is not a session event`], 'one line names the file')
})

test('a log that does not read names only its file in the error, never the store root on disk', () => {
  /**
   * The error reaches HTTP answers: a turn's error frame, and a route's 500. Measured on #130 (developer-six): the turn
   * route streamed "<data root>/sessions/<folder>/<id>.v2.jsonl.zstd:1 is not valid JSON", the home directory included.
   * The server's own line keeps the whole path; the error names the file.
   */
  const { root, damaged } = fixture()
  const head = `${JSON.stringify({ seq: 0, at: new Date().toISOString(), type: 'session/created', cwd: scratch })}\n`
  writeFileSync(damaged.transcript, `${head}not json\n`)
  const { store } = restarted(root)
  const handle = store.open(damaged.id)
  assert.ok(handle !== null)
  assert.throws(
    () => store.read(handle),
    (error: Error) => error.message.startsWith(`${damaged.id}.v2.jsonl.zstd:2 is not valid JSON`) && !error.message.includes(scratch),
    'the message names the log by its file name, and nothing above it',
  )
})

test('the folder tree leaves out the definition row of a session whose log cannot be read, and draws one whose log is missing', () => {
  /**
   * Measured on #130 after the store dropped the session: GET /api/tree still drew it from its definition,
   * <folder>/_sessions_/<name>/session.json, and a click on the row got 404. The tree asks the store's own judgement of
   * the log the definition names, for a definition the store does not list.
   */
  const { root, work, turned, blank, damaged } = fixture()
  mkdirSync(work, { recursive: true })
  const branch = realpathSync(work)
  for (const handle of [turned, blank, damaged]) {
    writeSessionDefinition(handle, branch, { createdAt: new Date().toISOString(), taken: existingSessionNames(branch) })
  }
  writeFileSync(damaged.transcript, '{"not":"zstd"}\n')
  rmSync(blank.transcript)
  const { store } = restarted(root)
  const rows = (tree(branch, { roots: [{ path: branch, title: 'work' }], sessions: store.list() }).children ?? [])
    .filter((node: TreeNode) => node.kind === 'session')
    .map((node: TreeNode) => node.session?.id)
  assert.ok(rows.includes(turned.id), `a healthy session keeps its row\n${rows.join('\n')}`)
  assert.ok(rows.includes(blank.id), 'a session whose log is missing still draws, as a definition cloned from another machine does')
  assert.ok(!rows.includes(damaged.id), 'the session whose log cannot be read has no row')
})
