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
  /** A system prompt at the head, which the child inherits where it stood, as DSH's seed does (#52, #55). */
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

  const notes = events.filter((event) => event.type === 'context/note' && event.origin === 'runtime-context')
  assert.equal(notes.length, 1, `the snapshot came across as one note\nsaw: ${JSON.stringify(events.map((event) => event.type))}`)
  assert.equal(notes[0]?.identity, SNAPSHOT, 'with its identity, so the next round does not write it again')
  assert.equal(notes[0]?.surfaceOp, 'append', 'and the surface marker it was written with')
  assert.ok(
    !events.some((event) => event.type === 'message' && JSON.stringify(event.message).includes('Current runtime context')),
    'no message carries the snapshot',
  )
  assert.equal(
    events.filter((event) => event.type === 'context/note' && JSON.stringify(event).includes('you are heddle')).length,
    1,
    'and the system prompt comes along once, as the note it was, so the child writes no second one',
  )

  /** The model still reads what the source's model read, in the same order. */
  const texts = service.store.messages(child).map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join(''))
  assert.deepEqual(texts, ['you are heddle', 'first question', SNAPSHOT, 'answer to first question', 'second question', 'answer to second question'])
})
