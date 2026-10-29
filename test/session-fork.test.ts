import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService } from '../src/session/service.ts'
import type { SessionHandle } from '../src/session/store.ts'
import { transcriptTurns } from '../src/server/web.ts'

/**
 * What a fork carries over: the conversation, and the harness's notes **as notes**.
 *
 * DSH's `session/fork` seeds the child with the exact event prefix of its source (`buildForkSeed` in
 * dsh-session/lib/types/fork.js:18-27, called from dsh-api-session-controller/lib/index.js:870-872), so a runtime-context
 * snapshot stays a runtime-context snapshot in the child. Measured on both builds in phase A (R-developer-eight-15): the fork
 * re-appended every surface node as a `message`, so the child's chat drew a "Current runtime context..." user bubble and
 * counted one turn more than its source.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-fork-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const SNAPSHOT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent heddle file policy: workspace-write.'

/** One recorded turn, in the order the loop writes it: the prompt, the harness's snapshot, the answer, the boundary. */
function turn(service: SessionService, handle: SessionHandle, prompt: string, options: { readonly note?: boolean } = {}): void {
  service.user(handle, prompt)
  if (options.note === true) {
    service.store.append(
      handle,
      {
        type: 'context/note',
        message: { role: 'user', content: [{ type: 'text', text: SNAPSHOT }], source: { kind: 'runtime-context' } },
        origin: 'runtime-context',
        identity: SNAPSHOT,
      },
      { surfaceOp: 'append' },
    )
  }
  service.store.assistantChunk(handle, { type: 'text-delta', text: `answer to ${prompt}` })
  service.store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  service.store.append(handle, { type: 'assistant/completed', text: `answer to ${prompt}`, finishReason: 'stop', rounds: 1 })
  service.store.append(handle, { type: 'turn/completed' })
}

test('a fork keeps the runtime-context note a note, so the child shows the same turns as its source', () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-1') })
  const source = service.start({ cwd: scratch, title: 'Source' })
  /** A system prompt at the head, which the child assembles for itself and must not inherit. */
  service.store.append(
    source,
    { type: 'context/note', message: { role: 'system', content: [{ type: 'text', text: 'you are heddle' }] }, origin: 'system-prompt' },
    { surfaceOp: 'append' },
  )
  turn(service, source, 'first question', { note: true })
  turn(service, source, 'second question')

  const forked = service.fork(source.id)
  assert.ok(forked !== null && 'handle' in forked, 'the source forks')
  const child = forked.handle
  const events = service.store.read(child)

  const userTurns = (list: ReturnType<typeof transcriptTurns>) => list.filter((one) => one.kind === 'user').map((one) => one.text)
  const sourceTurns = userTurns(transcriptTurns(service.store.read(source)))
  assert.deepEqual(sourceTurns, ['first question', 'second question'], 'the source shows its two prompts')
  assert.deepEqual(userTurns(transcriptTurns(events)), sourceTurns, 'and the child shows the same two, with no runtime-context bubble')

  const listed = service.list()
  assert.equal(
    listed.find((meta) => meta.id === child.id)?.turns,
    listed.find((meta) => meta.id === source.id)?.turns,
    'the child counts as many turns as its source',
  )

  const notes = events.filter((event) => event.type === 'context/note')
  assert.equal(notes.length, 1, `the snapshot came across as one note\nsaw: ${JSON.stringify(events.map((event) => event.type))}`)
  assert.equal(notes[0]?.origin, 'runtime-context', 'with its origin')
  assert.equal(notes[0]?.identity, SNAPSHOT, 'and its identity, so the next round does not write it again')
  assert.equal(notes[0]?.surfaceOp, undefined, "and none of the source's surface positions")
  assert.ok(
    !events.some((event) => event.type === 'message' && JSON.stringify(event.message).includes('Current runtime context')),
    'no message carries the snapshot',
  )
  assert.ok(
    !events.some((event) => JSON.stringify(event).includes('you are heddle')),
    'and the system prompt is not inherited',
  )

  /** The model still reads what the source's model read, in the same order. */
  const texts = service.store.messages(child).map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join(''))
  assert.deepEqual(texts, ['first question', SNAPSHOT, 'answer to first question', 'second question', 'answer to second question'])
})

/**
 * Fork at a chosen turn: DSH's `session/fork` with `atSeq`, the inclusive event seq to cut at
 * (dsh-api-session-controller/lib/index.js:849-872), which its chat's Branch action sets to the seq that ended the turn.
 * Phase A measured heddle ignoring it on both builds (R-developer-eight-16): the child always held every turn.
 */
test('a fork at a turn end holds the turns up to it, and a seq the source lacks is refused with the last seq', () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-2') })
  const source = service.start({ cwd: scratch, title: 'Long' })
  for (const prompt of ['turn one', 'turn two', 'turn three']) turn(service, source, prompt)
  const ends = service.store.read(source).filter((event) => event.type === 'turn/completed').map((event) => event.seq)
  assert.equal(ends.length, 3, 'three completed turns')

  const forked = service.fork(source.id, { atSeq: ends[1] })
  assert.ok(forked !== null && 'handle' in forked, `the cut at the second turn's end forks\nsaw: ${JSON.stringify(forked)}`)
  const prompts = transcriptTurns(service.store.read(forked.handle)).filter((one) => one.kind === 'user').map((one) => one.text)
  assert.deepEqual(prompts, ['turn one', 'turn two'], 'the child ends after turn two')
  assert.equal(service.list().find((meta) => meta.id === forked.handle.id)?.title, 'Long (1)', 'and is titled after its source')
  assert.equal(service.list().find((meta) => meta.id === forked.handle.id)?.parentSession, source.id, 'and records it')

  const last = service.store.read(source).at(-1)?.seq
  assert.deepEqual(service.fork(source.id, { atSeq: 9999 }), { error: 'no-such-event', atSeq: 9999, lastSeq: last }, 'a seq past the log is refused')
  const untouched = service.start({ cwd: scratch, title: 'Empty' })
  assert.deepEqual(service.fork(untouched.id), { error: 'unavailable' }, 'with no atSeq a session with no completed turn is still refused')
  const atStart = service.fork(untouched.id, { atSeq: 0 })
  assert.ok(atStart !== null && 'handle' in atStart, 'while an explicit seq it has forks, as DSH accepts any existing event')
})

test('the transcript marks the answer that closes a completed turn with the seq the Branch action forks at', () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-3') })
  const source = service.start({ cwd: scratch, title: 'Marks' })
  turn(service, source, 'first')
  turn(service, source, 'second')
  const events = service.store.read(source)
  const ends = events.filter((event) => event.type === 'turn/completed').map((event) => event.seq)
  const turns = transcriptTurns(events)
  assert.deepEqual(
    turns.filter((one) => one.forkSeq !== undefined).map((one) => [one.kind, one.text, one.forkSeq]),
    [
      ['assistant', 'answer to first', ends[0]],
      ['assistant', 'answer to second', ends[1]],
    ],
  )

  /** A turn whose last row is a call, not an answer with text, is not offered: DSH marks it unavailable. */
  service.user(source, 'third')
  service.store.assistantChunk(source, { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{}' })
  service.store.assistantChunk(source, { type: 'done', finishReason: 'tool-calls' })
  service.store.append(source, { type: 'turn/completed' })
  const after = transcriptTurns(service.store.read(source))
  assert.equal(after.filter((one) => one.forkSeq !== undefined).length, 2, 'the call-ended turn carries no seq')
})
