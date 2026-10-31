import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { toChatMessage } from '../src/llm/adapters.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'

/**
 * The surface: the positional view an append-only log is read through.
 *
 * These are the framework's own primitives — a fold, a replacement, a derivation — so they belong
 * here rather than in `_verifiers_`, which judges the delivered harness. What is pinned is the
 * contract every consumer of the surface relies on: a replacement shadows positions rather than
 * erasing history, a streamed run is one node, and a rewrite the surface could not fold is refused
 * before it reaches the disk.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-surface-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A fresh session, so one case cannot see another's log. */
function session(): { store: SessionStore; handle: SessionHandle } {
  counter += 1
  const store = new SessionStore(join(scratch, `store-${counter}`))
  return { store, handle: store.create({ cwd: scratch }) }
}

test('an append takes the next position, and the messages derive in order', () => {
  const { store, handle } = session()
  store.message(handle, { role: 'system', content: [{ type: 'text', text: 'be brief' }] })
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'first' }] })
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'second' }] })

  const surface = store.surface(handle)
  assert.equal(surface.nodes.length, 3, 'every message took a position')
  assert.equal(surface.contentGeneration, 3, 'each append moved the content generation')
  assert.equal(surface.replaceGeneration, 0, 'and none of them was a replacement')
  assert.deepEqual(
    store.deriveMessages(handle).map((message) => message.role),
    ['system', 'user', 'user'],
  )
})

test('a streamed run is one node, folded from the chunks that follow it', () => {
  const { store, handle } = session()
  store.assistantChunk(handle, { type: 'reasoning-delta', text: 'thinking' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'the ' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'answer' })
  store.assistantChunk(handle, { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{}' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })

  const surface = store.surface(handle)
  assert.equal(surface.nodes.length, 1, 'one run is one position, not five')
  const message = store.deriveNode(handle, surface.nodes[0] ?? -1)
  assert.deepEqual(
    message?.content.map((part) => part.type),
    ['reasoning', 'text', 'tool-call'],
    'the fold keeps arrival order, reasoning stays its own block, and the two text deltas are one block',
  )
})

/**
 * Consecutive deltas of one block derive to **one** part, the way DSH assembles a stream.
 *
 * DSH's `BlockAssembler.push` (dsh-llm `lib/types/assembler.js:46-52`) appends every `text-delta` and
 * `reasoning-delta` of a block to one partial (`partial.text += chunk.text`), so an answer is stored and sent back as
 * whole blocks. Deriving one part per delta instead made the chat adapter, which keeps separate text blocks apart with
 * a newline, hand the model its own earlier answer as `al\nph\na` (live-testing draft developer-five-2).
 */
test('consecutive text deltas derive to one text part, and the request carries them as one string', () => {
  const { store, handle } = session()
  store.assistantChunk(handle, { type: 'text-delta', text: 'al' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'ph' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'a' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })

  const [message] = store.deriveMessages(handle)
  assert.deepEqual(message, { role: 'assistant', content: [{ type: 'text', text: 'alpha' }] })
  assert.deepEqual(toChatMessage(message!), { role: 'assistant', content: 'alpha' }, 'no newline where the stream split it')
})

test('a tool call between two texts is a block boundary, so the texts stay two parts', () => {
  const { store, handle } = session()
  store.assistantChunk(handle, { type: 'text-delta', text: 'let me ' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'look' })
  store.assistantChunk(handle, { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{}' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'done ' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'now' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })

  assert.deepEqual(store.deriveMessages(handle), [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{}' },
        { type: 'text', text: 'done now' },
      ],
    },
  ])
})

test('consecutive reasoning deltas derive to one reasoning part, and a switch of kind starts a new one', () => {
  const { store, handle } = session()
  store.assistantChunk(handle, { type: 'reasoning-delta', text: 'Th' })
  store.assistantChunk(handle, { type: 'reasoning-delta', text: 'ink' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'an' })
  store.assistantChunk(handle, { type: 'text-delta', text: 'swer' })
  store.assistantChunk(handle, { type: 'reasoning-delta', text: 'again' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })

  assert.deepEqual(store.deriveMessages(handle), [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Think' },
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'again' },
      ],
    },
  ])
  assert.equal(
    store.read(handle).filter((event) => event.type === 'assistant/chunk').length,
    6,
    'the log still records one event per chunk; only the derivation coalesces',
  )
})

test('a replacement shadows positions while the log keeps everything', () => {
  const { store, handle } = session()
  const first = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'one' }] })
  const second = store.message(handle, { role: 'assistant', content: [{ type: 'text', text: 'two' }] })
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'three' }] })

  const before = store.surface(handle)
  const replacement = store.append(
    handle,
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '<compacted-summary>two of them</compacted-summary>' }] } },
    { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: second.seq }, sourceEventSeqs: [first.seq, second.seq] },
  )

  const after = store.surface(handle)
  assert.deepEqual(after.nodes, [replacement.seq, before.nodes[2]], 'the span is one node now')
  assert.equal(after.replaceGeneration, 1, 'a replacement is what moves this generation')
  assert.equal(after.contentGeneration, 4, 'and it moves the content generation too')
  assert.deepEqual(after.replacements[0]?.shadowedSeqs, [first.seq, second.seq], 'what it shadowed is recorded')

  const derived = store.deriveMessages(handle)
  assert.deepEqual(
    derived.map((message) => (message.content[0]?.type === 'text' ? message.content[0].text : '')),
    ['<compacted-summary>two of them</compacted-summary>', 'three'],
    'the model sees the summary exactly once, in the position the span held',
  )

  const types = store.read(handle).map((event) => event.type)
  assert.equal(types.filter((type) => type === 'message').length, 4, 'the log still holds every original event')
})

test('an append after a replacement lands at the end of the surface', () => {
  const { store, handle } = session()
  const first = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'one' }] })
  const replacement = store.append(handle, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }, {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
  })
  const last = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'after' }] })

  assert.deepEqual(store.surface(handle).nodes, [replacement.seq, last.seq])
})

test('the surface refuses a rewrite it could not fold or must not allow', () => {
  const { store, handle } = session()
  const system = store.message(handle, { role: 'system', content: [{ type: 'text', text: 'be brief' }] })
  const user = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  const tool = store.message(handle, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] })

  assert.throws(
    () => store.append(handle, { type: 'compaction/summary', summary: 'x' }, { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq } }),
    /not surface-eligible/,
    'a log-only event cannot take a model-visible position',
  )
  assert.throws(
    () => store.append(handle, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }, { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq + 1000 } }),
    /not a span of the surface/,
    'a range whose end is not on the surface is refused',
  )
  assert.throws(
    () => store.append(handle, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } }, { surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq } }),
    /system prompt/,
    'the system head may be rewritten only by a system message',
  )
  assert.throws(
    () => store.append(handle, { type: 'message', message: { role: 'tool', toolCallId: 'other', content: [{ type: 'text', text: 'x' }] } }, { surfaceOp: { op: 'replace', startSeq: tool.seq, endSeq: tool.seq } }),
    /tool result/,
    'a tool result answers one call, and its rewrite must answer the same one',
  )
})

test('a second replacement may shadow a span whose seqs are not in order', () => {
  /**
   * The trap: a replacement is written later than what it shadows, so it carries a high seq while
   * sitting at an older position. A span that contains it therefore holds a seq **below** its own
   * `startSeq`, and a validation that expected a numeric interval refused every such span — which
   * meant the second compaction of any session failed. DSH documents the same shape: the range is a
   * surface position span, and `start` may be greater than `end`.
   */
  const { store, handle } = session()
  const one = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'one' }] })
  const two = store.message(handle, { role: 'assistant', content: [{ type: 'text', text: 'two' }] })
  const three = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'three' }] })

  const first = store.append(
    handle,
    { type: 'context/note', message: { role: 'user', content: [{ type: 'text', text: 'first summary' }] }, origin: 'compaction' },
    { surfaceOp: { op: 'replace', startSeq: one.seq, endSeq: two.seq } },
  )
  assert.deepEqual(store.surface(handle).nodes, [first.seq, three.seq])

  const second = store.append(
    handle,
    { type: 'context/note', message: { role: 'user', content: [{ type: 'text', text: 'second summary' }] }, origin: 'compaction' },
    { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: three.seq } },
  )

  assert.deepEqual(store.surface(handle).nodes, [second.seq], 'the whole span is one node now')
  assert.deepEqual(
    store.deriveMessages(handle).map((message) => (message.content[0]?.type === 'text' ? message.content[0].text : '')),
    ['second summary'],
    'and the model reads the newer checkpoint rather than both',
  )
  assert.deepEqual(store.surface(handle).replacements[1]?.shadowedSeqs, [first.seq, three.seq], 'the span is recorded as positions')
})

test('a note the harness wrote is a surface node without being a message', () => {
  const { store, handle } = session()
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'what the person said' }] })
  const note = store.append(handle, {
    type: 'context/note',
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>the project rules</system-reminder>' }] },
    origin: 'instructions',
  })

  assert.deepEqual(
    store.deriveMessages(handle).map((message) => (message.content[0]?.type === 'text' ? message.content[0].text : '')),
    ['what the person said', '<system-reminder>the project rules</system-reminder>'],
    'the model reads it, in position',
  )
  assert.equal(
    store.read(handle).filter((event) => event.type === 'message').length,
    1,
    'and a view of the conversation still sees only what the person said',
  )
  assert.deepEqual(store.surface(handle).nodes, [1, note.seq], 'a note takes a position like any surface event')
})

test('the folded surface is cached until the log grows, and a rewrite is visible at once', () => {
  const { store, handle } = session()
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'one' }] })
  const first = store.surface(handle)
  assert.equal(store.surface(handle), first, 'an unchanged log folds once')

  const node = first.nodes[0] ?? -1
  store.append(handle, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }, {
    surfaceOp: { op: 'replace', startSeq: node, endSeq: node },
  })
  const second = store.surface(handle)
  assert.notEqual(second, first, 'a written event invalidates the fold')
  assert.equal(second.replaceGeneration, 1)
})
