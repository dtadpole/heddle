import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { completedPrefix, inheritsAnswer, SessionFlagError, SessionStore } from '../src/session/store.ts'
import { forkTitle, titleFrom } from '../src/session/service.ts'

/**
 * The two session actions that are pure rules or store writes, judged without a browser: naming a session from its
 * first message, naming a fork, and setting a session's flags.
 *
 * Each of these is a place where a wrong implementation is silent — a title derived badly produces a list nobody can
 * scan, a fork that reuses a name produces two rows nobody can tell apart, and a flag written into the wrong file
 * makes the tree and the store disagree about whether a session is archived.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-flags-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function store(): { store: SessionStore; root: string } {
  counter += 1
  const root = join(scratch, `store-${counter}`)
  return { store: new SessionStore(root), root }
}

test('a session is named from its first message, and the name is one line a list can show', () => {
  assert.equal(titleFrom('fix the ledger'), 'fix the ledger', 'a short message is its own name')
  assert.equal(titleFrom('  two   spaces   and  a trailing stop.  '), 'two spaces and a trailing stop', 'whitespace is collapsed and end punctuation dropped')
  assert.equal(titleFrom('line one\nline two'), 'line one line two', 'a multi-line message becomes one line')
  assert.equal(titleFrom('   '), '', 'nothing worth naming stays empty rather than becoming a blank title')

  /** A long message is cut at a word, with an ellipsis, so a name never ends mid-word. */
  const long = titleFrom('Please refactor the ledger projection so that a shadowed range reads exactly once in every case')
  assert.ok(long.length <= 49, `the name is bounded (${long.length})`)
  assert.ok(long.endsWith('…'), 'and says it was cut')
  assert.ok(!/\s…$/.test(long), 'without leaving a space before the ellipsis')
})

test('a fork is named after its parent with a rising ordinal, and never reuses a name', () => {
  assert.equal(forkTitle('a conversation', []), 'a conversation (1)', 'DSH names a fork after its parent')
  assert.equal(forkTitle('a conversation', ['a conversation (1)']), 'a conversation (2)', 'and the ordinal rises')
  assert.equal(forkTitle('a conversation', ['a conversation (1)', 'a conversation (2)']), 'a conversation (3)', 'for as long as it must')
  assert.equal(forkTitle('   ', ['x']), 'session (1)', 'an unnamed parent still yields a readable name')
})

test("a session's flags are written to its record, and a flag that is false is removed rather than stored", () => {
  const { store: sessions, root } = store()
  const handle = sessions.create({ cwd: '/tmp/project' })
  const transcriptBefore = readFileSync(handle.transcript)

  const pinned = sessions.flags(handle.id, { pinned: true })
  assert.equal(pinned?.pinned, true, 'the pin is recorded')
  /**
   * Archiving is the one write that **removes** the pin: the two flags are mutually exclusive in the reference, so a session
   * cannot be pinned and archived at once. The old version of this test expected the pin to survive, which was the gap.
   */
  sessions.flags(handle.id, { archived: true })
  const both = sessions.list().find((one) => one.id === handle.id)
  assert.equal(both?.archived, true, 'the archive landed')
  assert.equal(both?.pinned, undefined, 'and dropped the pin')

  /** The rules the record keeps: a false flag is absent, and the log is untouched. */
  sessions.flags(handle.id, { pinned: false })
  const unpinned = sessions.list().find((one) => one.id === handle.id)
  assert.equal(unpinned?.pinned, undefined, 'unpinning removes the field rather than storing false')
  assert.equal(unpinned?.archived, true, 'without disturbing the other flag')
  assert.ok(readFileSync(handle.transcript).equals(transcriptBefore), 'the append-only log is not one of the places flags are written')

  assert.equal(sessions.flags('session-00000000-0000-4000-8000-000000000000', { pinned: true }), null, 'a session that does not exist is refused')
  assert.ok(root.length > 0)
})

test('a pin and an archive are mutually exclusive, and each writes the field the other cannot keep', () => {
  const { store: sessions } = store()
  const handle = sessions.create({ cwd: '/tmp/project' })

  /** Pinning records *when*, which is the order among several pins — the reference prepends each pin. */
  sessions.flags(handle.id, { pinned: true })
  const pinned = sessions.list().find((one) => one.id === handle.id)
  assert.equal(pinned?.pinned, true, 'the pin is recorded')
  assert.match(String(pinned?.pinnedAt), /^\d{4}-\d{2}-\d{2}T/, 'with the time it was pinned')

  /** Archiving **drops** the pin in the same write, as DSH's archive does. */
  sessions.flags(handle.id, { archived: true })
  const archived = sessions.list().find((one) => one.id === handle.id)
  assert.equal(archived?.archived, true, 'the archive is recorded')
  assert.equal(archived?.pinned, undefined, 'and the pin is gone with it')
  assert.equal(archived?.pinnedAt, undefined, 'including its time')

  /** And pinning an archived session is refused, not silently ignored. */
  assert.throws(
    () => sessions.flags(handle.id, { pinned: true }),
    (error: unknown) => error instanceof SessionFlagError && error.code === 'archived',
    'an archived session cannot be pinned',
  )
  const after = sessions.list().find((one) => one.id === handle.id)
  assert.equal(after?.pinned, undefined, 'and the refusal wrote nothing')

  /** Unarchiving leaves it unpinned, which is the reversible half. */
  sessions.flags(handle.id, { archived: false })
  const restored = sessions.list().find((one) => one.id === handle.id)
  assert.equal(restored?.archived, undefined, 'the archive is removed')
  assert.equal(restored?.pinned, undefined, 'and it is not silently re-pinned')
})

test('forking copies the conversation (not the parent), names it, and leaves the parent untouched', () => {
  const { store: sessions } = store()
  const parent = sessions.create({ cwd: '/tmp/project', endpoint: 'scripted', model: 'scripted' })
  sessions.message(parent, { role: 'user', content: [{ type: 'text', text: 'the first thing said' }] })
  sessions.message(parent, { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] })
  const parentBefore = readFileSync(parent.transcript)

  const forked = sessions.fork(parent.id)
  assert.ok(forked !== null, 'the fork exists')
  assert.notEqual(forked.id, parent.id, 'as a session of its own')
  assert.notEqual(forked.transcript, parent.transcript, 'with its own log')

  /** It continues the same conversation in the same place: the projected messages came with it, in order. */
  const carried = sessions.messages(forked)
  assert.deepEqual(
    carried.map((message) => message.role),
    ['user', 'assistant'],
    'the fork holds the conversation and no system message of its own',
  )
  assert.ok(JSON.stringify(carried).includes('the first thing said'), 'including what was said')
  const forkMeta = sessions.list().find((one) => one.id === forked.id)
  assert.equal(forkMeta?.cwd, '/tmp/project', 'bound to the folder its parent worked in')
  assert.equal(forkMeta?.endpoint, 'scripted', 'and to the backend it was run with')

  const forkedMeta = sessions.list().find((one) => one.id === forked.id)
  assert.equal(forkedMeta?.parentSession, undefined, 'a bare fork records no parent unless asked')

  /** When the caller names the parent — as the service does — the child carries the provenance. */
  const attributed = sessions.fork(parent.id, { parentSession: parent.id })
  assert.ok(attributed !== null)
  assert.equal(sessions.list().find((one) => one.id === attributed.id)?.parentSession, parent.id, 'and a fork of the service kind does')

  assert.ok(readFileSync(parent.transcript).equals(parentBefore), 'the parent log is not rewritten by a fork')
  assert.equal(sessions.list().filter((one) => one.id === parent.id).length, 1, 'and it is still one session')
})

test('a fork of a fork is a fork of the conversation, not of the first session', () => {
  const { store: sessions } = store()
  const parent = sessions.create({ cwd: '/tmp/project' })
  sessions.message(parent, { role: 'user', content: [{ type: 'text', text: 'start' }] })
  const first = sessions.fork(parent.id)
  assert.ok(first !== null)
  sessions.message(first, { role: 'user', content: [{ type: 'text', text: 'a second thought' }] })
  const second = sessions.fork(first.id)
  assert.ok(second !== null)
  const roles = sessions.messages(second).map((message) => message.role)
  assert.equal(roles.filter((role) => role === 'user').length, 2, 'the whole conversation to that point came along')
})

test('a fork is named the way the reference names it: an existing ordinal is incremented, not appended to', () => {
  /** DSH's `increasedForkTitle`: `x (1)` becomes `x (2)`, a full-width `x（2）` becomes `x（3）`, and a bare title gains ` (1)`. */
  assert.equal(forkTitle('a conversation', []), 'a conversation (1)', 'a title without an ordinal gains one')
  assert.equal(forkTitle('a conversation (1)', []), 'a conversation (2)', 'an ASCII ordinal is incremented in place')
  assert.equal(forkTitle('a conversation (9)', []), 'a conversation (10)', 'and the number is not a character count')
  assert.equal(forkTitle('对话（2）', []), '对话（3）', 'a full-width ordinal, as a Chinese title carries, increments in its own form')
  /** A taken name still steps past it: this store lists titles side by side, so a duplicate is a row nobody can tell apart. */
  assert.equal(forkTitle('a conversation (19)', ['a conversation (20)']), 'a conversation (21)', 'a taken ordinal steps past itself')
})

test('a fork inherits the projection cut at the last completed turn, not a dangling half-turn', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({ seq, at: '2026-10-17T00:00:00.000Z', type, ...extra })
  const message = (seq: number, role: string, text: string) => at(seq, 'message', { message: { role, content: [{ type: 'text', text }] } })

  /** A completed turn followed by a question whose answer never arrived: only the completed part is inherited. */
  const log = [
    message(0, 'user', 'first question'),
    message(1, 'assistant', 'first answer'),
    at(2, 'turn/completed'),
    message(3, 'user', 'a question that never got an answer'),
  ]
  const cut = completedPrefix(log)
  assert.deepEqual(cut.map((event) => event.seq), [0, 1, 2], 'the dangling user message is outside the cut')

  /** Two completed turns keep both, and a log with no completion returns whole — the caller decides whether that is forkable. */
  const twoTurns = [message(0, 'user', 'q1'), message(1, 'assistant', 'a1'), at(2, 'turn/completed'), message(3, 'user', 'q2'), message(4, 'assistant', 'a2'), at(5, 'turn/completed'), message(6, 'user', 'q3')]
  assert.deepEqual(completedPrefix(twoTurns).map((event) => event.seq), [0, 1, 2, 3, 4, 5], 'both completed turns are inherited')
  const noCompletion = [message(0, 'user', 'q'), message(1, 'assistant', 'a')]
  assert.equal(completedPrefix(noCompletion).length, 2, 'a log that never completed a turn is returned whole')
})

test('a fork is refused on a question with no answer, and allowed on a conversation that was itself forked', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({ seq, at: '2026-10-17T00:00:00.000Z', type, ...extra })
  const message = (seq: number, role: string, text: string) => at(seq, 'message', { message: { role, content: [{ type: 'text', text }] } })

  const dangling = [message(0, 'user', 'a question that never got an answer')]
  assert.equal(inheritsAnswer(dangling), false, 'a recorded question with no answer has nothing to continue')

  const completed = [message(0, 'user', 'q'), message(1, 'assistant', 'a'), at(2, 'turn/completed')]
  assert.equal(inheritsAnswer(completed), true, 'a completed turn is forkable')

  /** A fork's own log holds copied messages and no chunk events, and it must still be forkable. */
  const forkedLog = [message(0, 'user', 'q'), message(1, 'assistant', 'a')]
  assert.equal(inheritsAnswer(forkedLog), true, 'a conversation that was itself forked is forkable')

  /** A question recorded after the last completed turn does not make the session unforkable: the cut drops it. */
  const withDanglingTail = [message(0, 'user', 'q'), message(1, 'assistant', 'a'), at(2, 'turn/completed'), message(3, 'user', 'later question')]
  assert.equal(inheritsAnswer(withDanglingTail), true, 'a dangling tail is cut away, not a refusal')
})
