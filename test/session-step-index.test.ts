import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../src/agent/loop.ts'
import { ApprovalService } from '../src/approvals/service.ts'
import { ContextService } from '../src/context/service.ts'
import { ModelService } from '../src/llm/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { deriveMessage, deriveNodeMessage, indexBySeq, SessionStore, type SessionHandle } from '../src/session/store.ts'
import { encodeFrame } from '../src/session/transcript.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * Issue #159: every model step of a long session asked the steering check ("did a user message arrive?") two or three
 * times, and the check derived every surface node, each derivation indexing the **whole log** again. One check cost
 * (surface nodes) × (log events), synchronously on the event loop: measured on main 40182eed with the session below
 * (300 turns, 51K events), the check took 1.4 s, each step waited 2.4 s before its model request, and the TS server's
 * loop stood still for 2.7 s at a time. The store now keeps one index per loaded log and extends it as the log grows,
 * and the check reads each position's own event.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-step-index-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const TURNS = 300
const DELTAS = 166

/**
 * A session of `turns` short turns, written as frames in one append the way a long session's log holds them: a prompt,
 * a request, `deltas` streamed text deltas and a `done`, and the turn's two closers (171 events a turn).
 */
function longSession(root: string, turns = TURNS, deltas = DELTAS): string {
  const writer = new SessionStore(root)
  const handle = writer.create({ cwd: scratch })
  let seq = writer.count(handle)
  writer.release(handle)
  const at = new Date().toISOString()
  const frames: Buffer[] = []
  const put = (event: Record<string, unknown>) => frames.push(encodeFrame(`${JSON.stringify({ seq: seq++, at, ...event })}\n`))
  for (let turn = 0; turn < turns; turn += 1) {
    put({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `question ${turn}` }] } })
    put({ type: 'model/request', endpoint: 'double', model: 'm', messages: turn * 2 + 1, tools: [] })
    for (let index = 0; index < deltas; index += 1) put({ type: 'assistant/chunk', chunk: { type: 'text-delta', text: ` word${index}` } })
    put({ type: 'assistant/chunk', chunk: { type: 'done', finishReason: 'stop' } })
    put({ type: 'assistant/completed', text: 'answer', reasoning: '', finishReason: 'stop', rounds: 1, denials: 0 })
    put({ type: 'turn/completed', rounds: 1 })
  }
  appendFileSync(handle.transcript, Buffer.concat(frames))
  return handle.id
}

/** The steering check's positions asked node by node, as the agent loop asked them before #159. */
function usersNodeByNode(store: SessionStore, handle: SessionHandle): Set<number> {
  return new Set(store.surface(handle).nodes.filter((seq) => store.deriveNode(handle, seq)?.role === 'user'))
}

test('the steering check of a 300-turn session costs milliseconds, and the log is indexed once for all of it', (t) => {
  const root = join(scratch, 'check')
  const id = longSession(root)
  const store = new SessionStore(root)
  const handle = store.open(id)!
  /** Writing takes the lock and reads the log again, once: everything after this is one step's work. */
  store.claim(handle)
  assert.ok(store.count(handle) > 50_000, `a 300-turn log: ${store.count(handle)} events`)

  const first = performance.now()
  const users = usersNodeByNode(store, handle)
  const firstMs = performance.now() - first
  assert.equal(users.size, TURNS, 'every prompt is a user position')

  /** Asked again, as each step asks it two or three times. */
  const started = performance.now()
  for (let round = 0; round < 3; round += 1) assert.deepEqual(usersNodeByNode(store, handle), users)
  const eachMs = (performance.now() - started) / 3
  t.diagnostic(`node by node over ${store.surface(handle).nodes.length} positions: ${eachMs.toFixed(1)} ms a check, the first ${firstMs.toFixed(1)} ms`)
  assert.ok(eachMs < 50, `deriving every node of the surface at 300 turns took ${eachMs.toFixed(1)} ms a check (the first ${firstMs.toFixed(1)} ms)`)

  /** The loop's own question, in one call, answers the same from the same index. */
  assert.deepEqual(new Set(store.userInputSeqs(handle)), users)
  assert.equal(store.seqIndexBuilds, 1, 'the log was indexed once')

  /** A step's appends extend the index, and a steered message is seen at once. */
  store.modelRequest(handle, { endpoint: 'double', messages: 601, tools: [] })
  const steered = store.message(handle, { role: 'user', content: [{ type: 'text', text: 'and one more thing' }] })
  const now = store.userInputSeqs(handle)
  assert.ok(now.has(steered.seq), 'the steered prompt is new input')
  assert.equal(now.size, TURNS + 1)
  assert.deepEqual(new Set(now), usersNodeByNode(store, handle))
  assert.equal(store.seqIndexBuilds, 1, 'appending extended the index rather than rebuilding it')
  assert.deepEqual([...store.bySeq(handle)], [...indexBySeq(store.read(handle))])
})

test('the kept index and the user positions answer what a fresh derivation answers, for every kind of node', () => {
  const store = new SessionStore(join(scratch, 'kinds'))
  const handle = store.create({ cwd: scratch })
  const note = (role: string, text: string) => store.append(handle, { type: 'context/note', message: { role, content: [{ type: 'text', text }] } })
  const chunk = (value: Record<string, unknown>) => store.append(handle, { type: 'assistant/chunk', chunk: value })
  note('system', 'the system prompt')
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'first question' }] })
  chunk({ type: 'text-delta', text: 'let me look' })
  chunk({ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' })
  chunk({ type: 'done', finishReason: 'tool_calls' })
  store.message(handle, { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] })
  /** A run its turn closed as failed derives to nothing (#173). */
  chunk({ type: 'text-delta', text: 'half an answ' })
  store.append(handle, { type: 'assistant/completed', text: '', finishReason: 'error' })
  store.append(handle, { type: 'turn/completed' })
  /** A summary is a user-role note; a message with no content derives to nothing. */
  note('user', 'a summary of the earlier turns')
  store.append(handle, { type: 'message', message: { role: 'user', content: [] } })
  store.message(handle, { role: 'user', content: [{ type: 'text', text: 'second question' }] })
  chunk({ type: 'text-delta', text: 'the answer' })
  chunk({ type: 'done', finishReason: 'stop' })

  const events = store.read(handle)
  const fresh = indexBySeq(events)
  for (const event of events) {
    assert.equal(store.bySeq(handle).get(event.seq), fresh.get(event.seq))
    assert.deepEqual(store.deriveNode(handle, event.seq), deriveMessage(fresh, event.seq))
  }
  const users = store.userInputSeqs(handle)
  assert.deepEqual(new Set(users), usersNodeByNode(store, handle))
  const texts = [...users].map((seq) => {
    const part = store.deriveNode(handle, seq)?.content[0]
    return part?.type === 'text' ? part.text : ''
  })
  assert.deepEqual(texts, ['first question', 'a summary of the earlier turns', 'second question'], 'two prompts and the summary note, not the empty message')
})

test('a log that holds a seq twice is read as indexBySeq reads it: the later event wins the seq', () => {
  const root = join(scratch, 'twice')
  const writer = new SessionStore(root)
  const created = writer.create({ cwd: scratch })
  writer.release(created)
  const at = new Date().toISOString()
  const line = (seq: number, text: string) =>
    encodeFrame(`${JSON.stringify({ seq, at, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`)
  appendFileSync(created.transcript, Buffer.concat([line(1, 'the first one'), line(1, 'the later one'), line(2, 'the next one')]))
  const store = new SessionStore(root)
  const handle = store.open(created.id)!
  const events = store.read(handle)
  assert.equal(store.bySeq(handle).get(1), indexBySeq(events).get(1))
  assert.deepEqual(store.deriveNode(handle, 1), deriveNodeMessage(events, 1))
  assert.deepEqual(new Set(store.userInputSeqs(handle)), usersNodeByNode(store, handle))
})

/** An instant OpenAI-compatible double: requests 1..3 each ask for one `noop` call, the 4th answers in `DELTAS` deltas. */
async function provider() {
  let requests = 0
  const server = createServer((request, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      if (requests <= 3) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name: 'noop', arguments: '{}' } }] }, null)
        send({}, 'tool_calls')
      } else {
        for (let index = 0; index < DELTAS; index += 1) send({ role: 'assistant', content: ` w${index}` }, null)
        send({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

test('a step in a 300-turn session reaches its model request in milliseconds and never holds the event loop', async (t) => {
  const root = join(scratch, 'turn')
  const id = longSession(root)
  const marks: { t: number; type: string; role?: string; chunk?: string }[] = []
  const ctx = new Context()
  const sessions = new SessionService(ctx, { root }, {
    onEvent: (_handle, event) => {
      const message = event.message as { role?: string } | undefined
      const chunk = event.chunk as { type?: string } | undefined
      marks.push({ t: performance.now(), type: event.type, ...(message?.role !== undefined ? { role: message.role } : {}), ...(chunk?.type !== undefined ? { chunk: chunk.type } : {}) })
    },
  })
  const session = sessions.start({ resume: id })
  /** The first write after a start reads the log again (the writer lock's claim), once; the steps are what is judged. */
  sessions.store.claim(session)
  const sandbox = new SandboxService(ctx, { workspaceRoot: scratch, backend: 'none' })
  const tools = new ToolRegistry(ctx, new ApprovalService(ctx, { mode: 'allow' }), sandbox, sessions)
  tools.register({ spec: { name: 'noop', description: 'does nothing', parameters: { type: 'object', properties: {} } }, run: async () => ({ output: 'ok' }) })
  new ContextService(ctx, sessions.store, { instructionsMaxBytes: 100_000, contextWindow: 10_000_000 })
  const double = await provider()
  new ModelService(ctx, [{ name: 'double', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'm' } as never])

  /** The event loop's longest stall during the turn: a 5 ms ticker, and the longest interval between its ticks less 5. */
  let last = performance.now()
  let longest = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last - 5)
    last = now
  }, 5)
  let result
  try {
    result = await runTurn(ctx, { session, endpoint: 'double', prompt: 'run three tools', maxRounds: 8 })
  } finally {
    clearInterval(ticker)
    await double.close()
  }
  assert.equal(result.toolCalls.length, 3, 'three steps of one call each')
  assert.equal(result.rounds, 4)

  /** The wait before each model request, from the message before it: the prompt, then each tool result. */
  const waits: number[] = []
  let before: number | undefined
  for (const mark of marks) {
    if (mark.type === 'message' && (mark.role === 'user' || mark.role === 'tool')) before = mark.t
    if (mark.type === 'model/request' && before !== undefined) {
      waits.push(mark.t - before)
      before = undefined
    }
  }
  /** And the "answer completes" path: the last answer's first delta to `assistant/completed`. */
  const lastRequest = marks.findLastIndex((mark) => mark.type === 'model/request')
  const firstDelta = marks.slice(lastRequest).find((mark) => mark.chunk === 'text-delta')
  const completed = marks.find((mark) => mark.type === 'assistant/completed')
  const shown = `waits ${waits.map((ms) => ms.toFixed(0)).join(' / ')} ms; longest loop stall ${longest.toFixed(0)} ms`
  t.diagnostic(`${shown}; first delta to completed ${firstDelta === undefined || completed === undefined ? '?' : (completed.t - firstDelta.t).toFixed(0)} ms`)
  assert.equal(waits.length, 4, shown)
  assert.ok(Math.max(...waits) < 200, `a step waited before its model request: ${shown}`)
  assert.ok(firstDelta !== undefined && completed !== undefined)
  assert.ok(completed.t - firstDelta.t < 200, `the answer took ${(completed.t - firstDelta.t).toFixed(0)} ms from its first delta to completed`)
  assert.ok(longest < 200, `the event loop stood still during a step: ${shown}`)
})
