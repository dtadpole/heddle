import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { repairToolPairing } from '../src/context/pairing.ts'
import type { Message } from '../src/llm/types.ts'
import { transcriptTurns } from '../src/server/web.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent } from '../src/session/store.ts'
import { decodeTranscript } from '../src/session/transcript.ts'

/**
 * A turn cut by a restart is closed when its session is next opened for writing (issue #5).
 *
 * DSH appends closers to a log whose tail turn is still open before anything else runs on attach for writing
 * (`dsh-agent-loop` lib/index.js:1992-1993, `interruptedTurnClosers`): an error result for every call still open, then
 * the step's end and the turn's end (`openTurnClosers`, dsh-session lib/types/repair.js:35-78). Its cold read appends
 * the same closers virtually, so a log whose writer crashed reads balanced before anyone writes it
 * (`readColdSessionLog`, dsh-session-query lib/index.js:26-52). Before this, heddle wrote nothing on shutdown or on
 * restart: the log ended at the call, the view drew it `running` forever, and the turn never ended.
 *
 * The crash here is a real one: a second process writes the turn and is killed with SIGKILL, which runs no cleanup.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-closers-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'session', 'store.ts')).href

/** The text the request-time repair answers an unanswered call with (`repairToolPairing`), read rather than restated. */
function pairingText(callId: string): string {
  const repaired = repairToolPairing([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }] },
  ])
  const answer = repaired.find((message) => message.role === 'tool')
  return (answer?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/**
 * A process that writes one turn up to a running tool call — the user's prompt, the model request, the streamed
 * reasoning, text and call, and the round's `done` — reports the session, and then waits to be killed, which is the
 * log a server leaves when it is stopped while `bash` runs.
 */
function crashingWriter(root: string, cwd: string): { child: ChildProcessWithoutNullStreams; ready: Promise<{ id: string; pid: number }> } {
  const script = join(scratch, `writer-${Math.random().toString(16).slice(2)}.mjs`)
  writeFileSync(
    script,
    [
      `import { SessionStore } from ${JSON.stringify(storeUrl)}`,
      `const store = new SessionStore(${JSON.stringify(root)})`,
      `const handle = store.create({ cwd: ${JSON.stringify(cwd)} })`,
      `store.message(handle, { role: 'user', content: [{ type: 'text', text: 'run the slow command' }] })`,
      `store.modelRequest(handle, { endpoint: 'scripted', messages: 1, tools: ['bash'] })`,
      `store.assistantChunk(handle, { type: 'reasoning-delta', text: 'it takes a while' })`,
      `store.assistantChunk(handle, { type: 'text-delta', text: 'Running it.' })`,
      `store.assistantChunk(handle, { type: 'tool-call', id: 'call-slow', name: 'bash', arguments: '{"command":"sleep 25"}' })`,
      `store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })`,
      `process.stdout.write(JSON.stringify({ id: handle.id, pid: process.pid }) + '\\n')`,
      `setInterval(() => {}, 1000)`,
    ].join('\n'),
  )
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const ready = new Promise<{ id: string; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the writer process said nothing within 10s\n${stderr}`)), 10_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const at = stdout.indexOf('\n')
      if (at === -1) return
      clearTimeout(timer)
      resolve(JSON.parse(stdout.slice(0, at)) as { id: string; pid: number })
    })
    child.once('exit', (code) => reject(new Error(`the writer process exited ${String(code)}\n${stderr}`)))
  })
  return { child, ready }
}

/** Kill a process and wait until it is gone, so its pid is dead when the next line runs. */
async function killed(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

/** The events on disk, decoded from the bytes rather than from any process's memory. */
function onDisk(path: string): SessionEvent[] {
  return decodeTranscript(readFileSync(path)).lines.map((line) => JSON.parse(line) as SessionEvent)
}

/** The tool messages a list of events holds, as call id and text. */
function toolResults(events: readonly SessionEvent[]): { id: unknown; text: string }[] {
  return events
    .filter((event) => event.type === 'message' && (event.message as Message | undefined)?.role === 'tool')
    .map((event) => {
      const message = event.message as Message & { toolCallId?: string }
      return { id: message.toolCallId, text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') }
    })
}

test('a turn its process left at a running tool call reads as interrupted, and is closed on disk before the next write', async () => {
  const root = join(scratch, 'crashed')
  const writer = crashingWriter(root, scratch)
  try {
    const { id } = await writer.ready
    const service = new SessionService(new Context(), { root })
    const handle = service.store.open(id)
    assert.ok(handle !== null, 'the session the other process wrote is found')

    /** While its writer lives the turn may still be running there, so a reader shows it as it is. */
    const live = service.events(handle)
    assert.equal(live.at(-1)?.type, 'assistant/chunk', 'a live writer\'s turn is read as written')
    assert.equal(toolResults(live).length, 0, 'and nothing answers its call yet')

    await killed(writer.child)
    const before = readFileSync(handle.transcript)
    const raw = service.store.read(handle)
    const last = raw.at(-1)!

    /** The writer is gone: the read is balanced the way DSH's cold read is, and the file is left alone. */
    const read = service.events(handle)
    const closers = read.slice(raw.length)
    assert.deepEqual(
      closers.map((event) => event.type),
      ['message', 'assistant/completed', 'turn/completed'],
      `the read closes the open call, then the turn\nsaw: ${JSON.stringify(closers)}`,
    )
    assert.deepEqual(toolResults(closers), [{ id: 'call-slow', text: pairingText('call-slow') }], 'the call is answered in the words the request-time repair uses')
    assert.deepEqual(
      closers.map((event) => event.seq),
      [raw.length, raw.length + 1, raw.length + 2],
      'the closers continue the log\'s sequence',
    )
    assert.ok(closers.every((event) => event.at === last.at), 'and reuse the last real event\'s time rather than inventing one')
    const completed = closers[1]!
    assert.equal(completed.text, 'Running it.', 'the answer record carries the text the turn produced')
    assert.equal(completed.reasoning, 'it takes a while')
    assert.equal(completed.rounds, 1)
    assert.ok(Array.isArray(completed.ended) && completed.ended.length === 1, 'and says why the turn ended early')
    assert.deepEqual(closers[2]!.reason, { kind: 'interrupted' }, 'the turn ends with DSH\'s cause')
    assert.ok(readFileSync(handle.transcript).equals(before), 'a read writes nothing')

    const turns = transcriptTurns(read)
    const call = turns.find((turn) => turn.kind === 'tool' && turn.toolCallId === 'call-slow')
    assert.equal(call?.state, 'error', `the view draws the call as interrupted\n${JSON.stringify(call)}`)
    assert.ok(!turns.some((turn) => turn.state === 'running'), 'and nothing as running')

    /** The first write after the restart: the closers land on disk first, then the new turn. */
    service.user(handle, 'did the command finish?')
    const written = onDisk(handle.transcript)
    assert.deepEqual(written.map((event) => event.seq), written.map((_, index) => index), 'every seq is written once, in order')
    assert.deepEqual(
      written.slice(raw.length).map((event) => event.type),
      ['message', 'assistant/completed', 'turn/completed', 'message'],
      'the closers are appended before anything else runs',
    )
    assert.deepEqual(
      written.slice(raw.length, raw.length + 3).map(({ at: _at, ...rest }) => rest),
      closers.map(({ at: _at, ...rest }) => rest),
      'and they are exactly what the read showed',
    )
    assert.equal((written.at(-1)!.message as Message).role, 'user', 'the new prompt follows them')
    assert.equal(service.events(handle).length, written.length, 'this process now writes the session, so nothing is added on read')
    assert.equal(toolResults(service.events(handle)).length, 1, 'and the call has one answer, not two')
    const messages = service.messages(handle) as readonly Message[]
    assert.equal(repairToolPairing(messages), messages, 'the request no longer needs the request-time repair')
    assert.ok(!transcriptTurns(service.events(handle)).some((turn) => turn.state === 'running'), 'the view never draws the old call as running again')
  } finally {
    await killed(writer.child)
  }
})

test('a turn that is live in this process is never closed, by a read or by a second claim here', () => {
  const root = join(scratch, 'live')
  const service = new SessionService(new Context(), { root })
  const handle = service.store.create({ cwd: scratch })
  service.user(handle, 'run the slow command')
  service.store.modelRequest(handle, { endpoint: 'scripted', messages: 1, tools: ['bash'] })
  service.store.assistantChunk(handle, { type: 'tool-call', id: 'call-live', name: 'bash', arguments: '{}' })
  service.store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })

  /** The call is running now, in this process: a reader sees it running. */
  assert.equal(toolResults(service.events(handle)).length, 0, 'the holder\'s own read adds nothing')
  assert.equal(transcriptTurns(service.events(handle)).at(-1)?.state, 'running', 'and the view draws the call as running, because it is')

  /**
   * A second service over the same store root in the same process shares the process's hold: its read adds nothing, and
   * its claim is not a write-open, so it closes nothing.
   */
  const other = new SessionService(new Context(), { root })
  const same = other.store.open(handle.id)!
  assert.equal(toolResults(other.events(same)).length, 0, 'another reader in this process adds nothing either')
  const count = onDisk(handle.transcript).length
  other.store.claim(same)
  assert.equal(onDisk(handle.transcript).length, count, 'a second claim in this process appends nothing')

  /** The turn goes on and answers its call itself. */
  service.store.message(handle, { role: 'tool', toolCallId: 'call-live', content: [{ type: 'text', text: 'slept' }] })
  const written = onDisk(handle.transcript)
  assert.deepEqual(toolResults(written), [{ id: 'call-live', text: 'slept' }], 'the only answer is the tool\'s own')
  assert.ok(!written.some((event) => event.type === 'turn/completed' || event.type === 'assistant/completed'), 'and no closer ended the live turn')
})

test('openTurnClosers closes only an open tail turn, and only the calls it left unanswered', async () => {
  const { openTurnClosers } = (await import('../src/session/repair.ts')) as {
    openTurnClosers: (events: readonly SessionEvent[], cause: { readonly kind: 'interrupted' }) => SessionEvent[]
  }
  const cause = { kind: 'interrupted' } as const
  let seq = 0
  const at = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`
  const event = (type: string, fields: Record<string, unknown> = {}, minute = 0): SessionEvent => ({ seq: seq++, at: at(minute), type, ...fields })
  const user = (text: string) => event('message', { message: { role: 'user', content: [{ type: 'text', text }] } })
  const chunk = (value: Record<string, unknown>, minute = 0) => event('assistant/chunk', { chunk: value }, minute)
  const result = (id: string, text: string) => event('message', { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] } })

  seq = 0
  const balanced = [event('session/created'), user('hi'), event('model/request'), chunk({ type: 'text-delta', text: 'hello' }), chunk({ type: 'done', finishReason: 'stop' }), event('assistant/completed', { text: 'hello' }), event('turn/completed', { rounds: 1 })]
  assert.deepEqual(openTurnClosers(balanced, cause), [], 'a balanced log needs nothing')
  assert.deepEqual(openTurnClosers([], cause), [], 'nor does an empty one')

  /**
   * heddle writes no turn-start event; a turn is known to have begun at its first model request or streamed chunk,
   * which is how the goal driver tells a turn in flight (src/plugins/goal-driver.ts). A prompt alone is not a turn
   * the loop started, and the fork already leaves such a prompt out of what it inherits.
   */
  assert.deepEqual(openTurnClosers([...balanced, user('a prompt nobody answered')], cause), [], 'a prompt with no model call after it is left as it is')

  seq = balanced.length
  const twoCalls = [
    ...balanced,
    user('two calls'),
    event('model/request'),
    chunk({ type: 'tool-call', id: 'call-a', name: 'bash', arguments: '{}' }),
    chunk({ type: 'tool-call', id: 'call-b', name: 'read_file', arguments: '{}' }),
    chunk({ type: 'done', finishReason: 'tool_calls' }),
    result('call-a', 'error (DENIED): not allowed'),
    event('turn/retry'),
    event('model/request'),
    event('model/request'),
    chunk({ type: 'tool-call', id: 'call-c', name: 'bash', arguments: '{}' }, 7),
  ]
  const closers = openTurnClosers(twoCalls, cause)
  assert.deepEqual(
    closers.map((one) => [one.type, (one.message as { toolCallId?: string } | undefined)?.toolCallId]),
    [['message', 'call-b'], ['message', 'call-c'], ['assistant/completed', undefined], ['turn/completed', undefined]],
    'each unanswered call gets one result, in call order, before the turn is closed',
  )
  assert.ok(closers.every((one) => one.at === at(7)), 'every closer takes the last real event\'s time')
  assert.deepEqual(closers.map((one) => one.seq), [twoCalls.length, twoCalls.length + 1, twoCalls.length + 2, twoCalls.length + 3])
  assert.equal(closers[2]!.rounds, 2, 'a retried request is the same round')
  assert.equal(closers[2]!.denials, 3, 'the error results of the turn, the two closers among them')
  assert.equal(closers[2]!.finishReason, 'tool_calls', 'the last round\'s finish reason')
  assert.deepEqual(closers[3], { seq: twoCalls.length + 3, at: at(7), type: 'turn/completed', rounds: 2, reason: { kind: 'interrupted' } })
  assert.equal(JSON.stringify(closers[0]).indexOf('"seq"'), 1, 'a closer is written in the store\'s key order: seq, at, type, then its fields')

  seq = balanced.length
  const noCall = [...balanced, user('no call'), event('model/request'), chunk({ type: 'text-delta', text: 'half an ans' })]
  assert.deepEqual(
    openTurnClosers(noCall, cause).map((one) => one.type),
    ['assistant/completed', 'turn/completed'],
    'a turn cut while it streamed text is closed without inventing a result',
  )

  /** The bytes both builds write for one cut turn; heddle-session `repair.rs` pins the same three lines. */
  seq = 0
  const cut = [
    event('session/created'),
    user('go'),
    event('model/request'),
    chunk({ type: 'reasoning-delta', text: 'r' }),
    chunk({ type: 'text-delta', text: 'a' }),
    chunk({ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }),
    chunk({ type: 'done', finishReason: 'tool_calls' }, 6),
  ]
  assert.deepEqual(openTurnClosers(cut, cause).map((one) => JSON.stringify(one)), [
    '{"seq":7,"at":"2026-10-30T10:06:00.000Z","type":"message","message":{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"error (INTERRUPTED): the turn ended before this call answered"}]}}',
    '{"seq":8,"at":"2026-10-30T10:06:00.000Z","type":"assistant/completed","text":"a","reasoning":"r","finishReason":"tool_calls","rounds":1,"denials":1,"ended":["the process exited before this turn finished, so the turn was closed; unfinished tool calls have unknown outcomes"]}',
    '{"seq":9,"at":"2026-10-30T10:06:00.000Z","type":"turn/completed","rounds":1,"reason":{"kind":"interrupted"}}',
  ])

  seq = 0
  const earlier = [
    event('session/created'),
    user('old'),
    event('model/request'),
    chunk({ type: 'tool-call', id: 'call-old', name: 'bash', arguments: '{}' }),
    chunk({ type: 'done', finishReason: 'tool_calls' }),
    event('turn/failed', { reason: 'boom' }),
  ]
  assert.deepEqual(openTurnClosers(earlier, cause), [], 'a call left in a turn that already ended is not reopened: the request-time repair answers it')
})
