import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { repairToolPairing } from '../src/context/pairing.ts'
import { ContextService } from '../src/context/service.ts'
import type { Message } from '../src/llm/types.ts'
import { transcriptTurns } from '../src/server/web.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'

/**
 * A turn whose stream broke mid-answer leaves its fragment out of what the model reads next (#173).
 *
 * Live on both builds: a turn whose provider stream was cut after "PARTIAL-99 alpha " failed, and the next turn's
 * request carried that fragment as the model's own earlier answer. DSH settles a failed stream as `assistant/attempt`,
 * which takes no place on the surface, and only a stream a Stop cut with content as an `assistant/message` marked
 * `interrupted` (dsh-agent-loop). heddle records every chunk as it arrives, so the derivation leaves out a run with no
 * `done` whose turn closed with `finishReason: 'error'`; a stopped run keeps what streamed. The fork and the summary
 * read the same derivation, so neither carries the fragment on. The page still draws it, with the failure line.
 * heddle-session `surface.rs` pins the same rule, and `tests/typescript_projection.rs` compares the two builds.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-failed-fragment-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function session(): { store: SessionStore; handle: SessionHandle } {
  counter += 1
  const store = new SessionStore(join(scratch, `store-${counter}`))
  return { store, handle: store.create({ cwd: join(scratch, `work-${counter}`) }) }
}

/** A prompt and a model request. */
function ask(store: SessionStore, handle: SessionHandle, text: string): void {
  store.message(handle, { role: 'user', content: [{ type: 'text', text }] })
  store.modelRequest(handle, { endpoint: 'chat', messages: 1, tools: [] })
}

/** A run that streamed `text` and broke, closed the way the loop closes a turn that threw (`recordUnfinished`). */
function brokenRun(store: SessionStore, handle: SessionHandle, text: string, how: 'error' | 'aborted', earlier = '', steer?: string): void {
  store.assistantChunk(handle, { type: 'reasoning-delta', text: 'thinking about it' })
  if (steer !== undefined) store.message(handle, { role: 'user', content: [{ type: 'text', text: steer }] })
  store.assistantChunk(handle, { type: 'text-delta', text })
  const message = 'the request to \'chat\' could not be read — aborted'
  store.append(handle, {
    type: 'assistant/completed',
    text: earlier + text,
    reasoning: 'thinking about it',
    finishReason: how,
    rounds: 1,
    denials: 0,
    ended: [how === 'aborted' ? 'stopped by the caller' : `failed: ${message}`],
    ...(how === 'aborted' ? {} : { error: message }),
  })
  store.append(handle, { type: 'turn/completed', rounds: 1, ...(how === 'aborted' ? { stopped: true } : { error: message }) })
}

/** A turn answered in full. */
function answered(store: SessionStore, handle: SessionHandle, prompt: string, text: string): void {
  ask(store, handle, prompt)
  store.assistantChunk(handle, { type: 'text-delta', text })
  store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  store.append(handle, { type: 'assistant/completed', text, reasoning: '', finishReason: 'stop', rounds: 1, denials: 0 })
  store.append(handle, { type: 'turn/completed', rounds: 1 })
}

/** The model's view as role and text, the way a request is built: the derivation, then the pairing repair. */
function view(messages: readonly Message[]): string[] {
  return messages.map((message) => `${message.role}: ${message.content.map((part) => (part.type === 'tool-call' ? `[call ${part.name}]` : 'text' in part ? part.text : '')).join(' | ')}`)
}

test('a failed run leaves the next request, and a stopped one keeps what streamed', () => {
  const { store, handle } = session()
  ask(store, handle, 'CUT-TEXT-173 turn')
  brokenRun(store, handle, 'PARTIAL-99 alpha ', 'error')
  ask(store, handle, 'NEXT turn')
  assert.deepEqual(view(repairToolPairing(store.deriveMessages(handle))), ['user: CUT-TEXT-173 turn', 'user: NEXT turn'], 'the fragment, its reasoning included, is not the model\'s answer')

  /** The log still holds every chunk, and the page draws the fragment with the turn's failure line. */
  const events = store.read(handle)
  assert.ok(events.some((event) => event.type === 'assistant/chunk' && (event.chunk as { text?: string }).text === 'PARTIAL-99 alpha '), 'the log keeps the chunks')
  const drawn = transcriptTurns(events).find((turn) => turn.kind === 'assistant')
  assert.match(String(drawn?.text), /PARTIAL-99 alpha/, `the page still shows the partial (${JSON.stringify(drawn)})`)
  assert.match(String(drawn?.ended?.join(' ')), /failed: /, 'with the failure line')

  const stopped = session()
  ask(stopped.store, stopped.handle, 'STOP-ME turn')
  brokenRun(stopped.store, stopped.handle, 'PARTIAL-99 alpha ', 'aborted')
  ask(stopped.store, stopped.handle, 'NEXT turn')
  assert.deepEqual(
    view(stopped.store.deriveMessages(stopped.handle)),
    ['user: STOP-ME turn', 'assistant: thinking about it | PARTIAL-99 alpha ', 'user: NEXT turn'],
    'a run a Stop cut keeps what streamed, as DSH keeps an interrupted message',
  )
})

test('the rounds a failed turn finished stay: only the run that broke is left out', () => {
  const { store, handle } = session()
  ask(store, handle, 'list it, then explain')
  store.assistantChunk(handle, { type: 'text-delta', text: 'Listing.' })
  store.assistantChunk(handle, { type: 'tool-call', id: 'call-1', name: 'list_dir', arguments: '{}' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })
  store.message(handle, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }] })
  store.modelRequest(handle, { endpoint: 'chat', messages: 4, tools: [] })
  /** A steer that landed while the broken run streamed is the person's, and stays, placed at the step's end (#30). */
  brokenRun(store, handle, 'It holds a.t', 'error', 'Listing.', 'STEER be brief')
  assert.deepEqual(view(repairToolPairing(store.deriveMessages(handle))), ['user: list it, then explain', 'assistant: Listing. | [call list_dir]', 'tool: a.txt', 'user: STEER be brief'])
})

test('a fork of a session with a failed turn does not inherit the fragment as an answer', () => {
  const { store, handle } = session()
  ask(store, handle, 'CUT-TEXT-173 turn')
  brokenRun(store, handle, 'PARTIAL-99 alpha ', 'error')
  answered(store, handle, 'NEXT turn', 'second answer')
  const child = store.fork(handle.id)
  assert.ok(child, 'the session forks')
  assert.deepEqual(view(store.deriveMessages(child)), ['user: CUT-TEXT-173 turn', 'user: NEXT turn', 'assistant: second answer'], 'the branch reads what the source reads')
  assert.ok(store.read(child).some((event) => event.type === 'assistant/chunk' && (event.chunk as { text?: string }).text === 'PARTIAL-99 alpha '), 'while its log keeps the chunks, as the source\'s does')
})

test('a summary of a span with a failed turn is not handed the fragment', async () => {
  counter += 1
  const store = new SessionStore(join(scratch, `store-${counter}`))
  const seen: (readonly Message[])[] = []
  const context = new ContextService(new Context(), store, { instructions: false, contextWindow: 900 }, {
    complete: async (request) => {
      seen.push(request.messages)
      return 'the briefing'
    },
  })
  const workspace = join(scratch, `work-${counter}`)
  const handle = store.create({ cwd: workspace })
  ask(store, handle, `CUT-TEXT-173 ${'u'.repeat(1500)}`)
  brokenRun(store, handle, 'PARTIAL-99 alpha ', 'error')
  answered(store, handle, `NEXT ${'q'.repeat(1500)}`, 'a'.repeat(1500))
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'and now?' }] })

  const report = await context.prepare(handle, { cwd: workspace, endpoint: 'local' })
  assert.equal(report.compacted, true, 'the session was over its trigger and compacted')
  assert.equal(seen.length, 1, 'one summary call')
  const sent = JSON.stringify(seen[0])
  assert.ok(sent.includes('CUT-TEXT-173'), 'the summary saw the failed turn\'s prompt')
  assert.ok(!sent.includes('PARTIAL-99'), 'and not its fragment')
  assert.ok(!sent.includes('thinking about it'), 'nor its reasoning')
})

test('a node that derives nothing stands on the surface at no price, and the session still compacts', async () => {
  /**
   * The measurement prices the nodes that derive a message, and the plan compared it with every node, so a node that
   * derives none made every compaction throw "the measurement is of a different surface than the one on disk". A run
   * that streamed only its `done` (an empty answer) was such a node before #173; a failed run is one now.
   */
  for (const shape of ['done only', 'failed run'] as const) {
    counter += 1
    const store = new SessionStore(join(scratch, `store-${counter}`))
    const context = new ContextService(new Context(), store, { instructions: false, contextWindow: 900 }, { complete: async () => 'the briefing' })
    const workspace = join(scratch, `work-${counter}`)
    const handle = store.create({ cwd: workspace })
    ask(store, handle, 'u'.repeat(1500))
    if (shape === 'done only') {
      store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
      store.append(handle, { type: 'turn/completed', rounds: 1 })
    } else {
      brokenRun(store, handle, 'PARTIAL-99 alpha ', 'error')
    }
    answered(store, handle, 'q'.repeat(1500), 'a'.repeat(1500))
    store.message(handle, { role: 'user', content: [{ type: 'text', text: 'and now?' }] })
    const report = await context.prepare(handle, { cwd: workspace, endpoint: 'local' })
    assert.equal(report.compacted, true, `a session with a ${shape} node compacts`)
  }
})
