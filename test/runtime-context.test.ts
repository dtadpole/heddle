import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  CLEARED_RUNTIME_CONTEXT,
  ContextService,
  RUNTIME_CONTEXT_ORIGIN,
  type RuntimeContextSection,
} from '../src/context/service.ts'
import { SessionStore } from '../src/session/store.ts'
import { transcriptTurns } from '../src/server/web.ts'

/**
 * The runtime-context snapshot, DSH's mechanism for "the standing facts changed".
 *
 * DSH contributes the current sandbox policy to a full runtime-context snapshot before each request; the agent
 * loop logs a **changed** snapshot as a sourced `user/message` after retained history, with the header "This
 * snapshot supersedes earlier runtime-context snapshots", and reuses the retained one while nothing changes. The
 * claims worth pinning here are the ones that make a mode change legible to a running loop and to every reader
 * afterwards: a changed snapshot is appended (history keeps what each step saw), an unchanged one writes nothing,
 * the stable system prompt is untouched, the snapshot is attributable, the transcript does not draw it as a
 * person's turn, and a session written by the previous replacing mechanism is migrated rather than left stale.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-runtime-context-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let fixtures = 0

function setup() {
  fixtures += 1
  const root = join(scratch, `sessions-${fixtures}`)
  const store = new SessionStore(root)
  const context = new ContextService(new Context(), store, { instructions: false })
  const workspace = join(scratch, `workspace-${fixtures}`)
  const session = store.create({ cwd: workspace })
  return { root, store, context, session, workspace }
}

const policy = (mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspace = '/w'): RuntimeContextSection => ({
  name: 'sandbox:policy',
  text: `Current heddle file policy: ${mode}. Any available operation enforced by heddle's file sandbox may modify files under the session workspace: "${workspace}".`,
})

const policySections = (mode: 'read-only' | 'workspace-write' | 'danger-full-access') => [policy(mode)]
const notes = (store: SessionStore, session: Parameters<typeof store.read>[0]) =>
  store.read(session).filter((event) => event.type === 'context/note' && event.origin === RUNTIME_CONTEXT_ORIGIN)
const messageTexts = (store: SessionStore, session: Parameters<typeof store.deriveMessages>[0]) =>
  store
    .deriveMessages(session)
    .map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))

test('the first snapshot is one sourced runtime-context note, and the model reads it', () => {
  const { store, context, session } = setup()
  context.recordRuntimeContext(session, policySections('workspace-write'))

  const written = notes(store, session)
  assert.equal(written.length, 1, 'the first snapshot is one note')
  const event = written[0] as { message?: { role?: string; source?: Record<string, unknown> }; identity?: unknown }
  assert.match(String(event.identity), /^Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./, 'it carries DSH’s superseding header')
  assert.match(String(event.identity), /Current heddle file policy: workspace-write/, 'and the policy section')
  assert.equal(event.message?.role, 'user', 'it is a user message, so it is model history')
  const source = event.message?.source as { kind?: string; form?: string; sections?: readonly { name?: string; text?: string }[] }
  assert.equal(source?.kind, 'runtime-context', 'and it is attributed to the runtime context, not to a person')
  assert.equal(source?.form, 'snapshot', 'as a snapshot')
  assert.equal(source?.sections?.[0]?.name, 'sandbox:policy', 'with the contributing section named')
  assert.match(source?.sections?.[0]?.text ?? '', /workspace-write/, 'and its text')
  assert.equal(messageTexts(store, session).filter((text) => text.includes('Current runtime context')).length, 1, 'the model reads it once')
})

test('an unchanged snapshot writes nothing, and a changed one is appended after it, superseded but retained', () => {
  const { store, context, session } = setup()
  context.recordRuntimeContext(session, policySections('workspace-write'))
  const before = store.count(session)
  context.recordRuntimeContext(session, policySections('workspace-write'))
  assert.equal(store.count(session), before, 'an unchanged snapshot costs no event, so a steady request reuses the retained one')

  context.recordRuntimeContext(session, policySections('read-only'))
  assert.equal(notes(store, session).length, 2, 'a changed snapshot is a new note')
  assert.equal(store.surface(session).nodes.length, 2, 'appended, not replaced: the surface keeps what the previous step saw')
  const texts = messageTexts(store, session).filter((text) => text.includes('Current runtime context'))
  assert.equal(texts.length, 2, 'both snapshots are in model history')
  assert.match(texts[0] ?? '', /workspace-write/, 'the earlier one still says what the earlier step ran under')
  assert.match(texts[1] ?? '', /read-only/, 'and the newer one says the current policy')
  assert.match(texts[1] ?? '', /This snapshot supersedes earlier runtime-context snapshots/, 'the model is told the newer one wins')
  assert.doesNotMatch(texts[0] ?? '', /read-only/, 'the earlier snapshot is not rewritten')
})

test('a change that is reverted is another append, and the latest snapshot is the reverted mode', () => {
  const { store, context, session } = setup()
  for (const mode of ['workspace-write', 'read-only', 'workspace-write'] as const) context.recordRuntimeContext(session, policySections(mode))
  const texts = messageTexts(store, session).filter((text) => text.includes('Current runtime context'))
  assert.equal(texts.length, 3, 'each change is recorded once, including the revert')
  assert.match(texts[2] ?? '', /workspace-write/, 'and the latest snapshot is the mode that is actually in force')
})

test('a fresh process restores the retained snapshot from the log instead of rewriting it', () => {
  const first = setup()
  first.context.recordRuntimeContext(first.session, policySections('workspace-write'))
  const before = first.store.count(first.session)

  /** A new store and service over the same root is what a restarted harness is. */
  const store = new SessionStore(first.root)
  const context = new ContextService(new Context(), store, { instructions: false })
  const [session] = store.list()
  assert.ok(session !== undefined, 'the session survives on disk')
  const handle = store.open(session.id)
  assert.ok(handle !== null)
  context.recordRuntimeContext(handle, policySections('workspace-write'))
  assert.equal(store.count(handle), before, 'the unchanged snapshot is recognised from the log, not rewritten')

  context.recordRuntimeContext(handle, policySections('read-only'))
  assert.equal(notes(store, handle).length, 2, 'and a change after the restart appends exactly one new snapshot')
})

test('a session written by the replacing mechanism is migrated: its stale note is replaced, not left beside the snapshot', () => {
  const { store, context, session } = setup()
  const stale = store.append(session, {
    type: 'context/note',
    message: { role: 'user', content: [{ type: 'text', text: 'Current heddle file policy: read-only. The old replacing note.' }] },
    origin: 'sandbox-policy',
  }).seq
  context.recordRuntimeContext(session, policySections('workspace-write'))

  assert.equal(store.surface(session).nodes.length, 1, 'the stale note is shadowed, so the model reads one policy')
  const latest = notes(store, session)[0] as { seq?: number; sourceEventSeqs?: readonly number[] }
  assert.equal(latest.seq, 2, 'the snapshot is the newer event')
  assert.deepEqual([...(latest.sourceEventSeqs ?? [])], [stale], 'and it cites the note it replaced')
  const text = messageTexts(store, session).join('\n')
  assert.doesNotMatch(text, /old replacing note/, 'the stale sentence is not in the request')
  assert.match(text, /Current runtime context/, 'the snapshot is')
})

test('an empty snapshot clears the previous one with DSH’s sentence', () => {
  const { store, context, session } = setup()
  context.recordRuntimeContext(session, policySections('workspace-write'))
  context.recordRuntimeContext(session, [])
  const texts = messageTexts(store, session)
  assert.ok(texts.includes(CLEARED_RUNTIME_CONTEXT), 'the cleared sentence is a snapshot of its own')
  assert.equal(store.surface(session).nodes.length, 2, 'and it supersedes by being the latest, not by rewriting the first')
})

test('the system prompt is untouched by a policy change, and the transcript does not draw the snapshot as a turn', () => {
  const { store, context, session } = setup()
  store.append(session, { type: 'context/note', message: { role: 'system', content: [{ type: 'text', text: 'stable system prompt' }] }, origin: 'system-prompt' })
  context.recordRuntimeContext(session, policySections('workspace-write'))
  context.recordRuntimeContext(session, policySections('read-only'))

  const systemEvents = store.read(session).filter((event) => event.type === 'context/note' && event.origin === 'system-prompt')
  assert.equal(systemEvents.length, 1, 'no policy change rewrites the system note')
  const first = store.deriveMessages(session)[0]
  assert.equal(first?.role, 'system', 'the system prompt stays the first message')
  assert.equal(first?.content.map((part) => (part.type === 'text' ? part.text : '')).join(''), 'stable system prompt', 'byte-identical')

  const turns = transcriptTurns(store.read(session))
  assert.ok(!turns.some((turn) => turn.kind === 'user' && turn.text.includes('Current runtime context')), 'the transcript does not show the harness’s snapshot as a person’s turn')
})
