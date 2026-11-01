import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService } from '../src/session/service.ts'
import { foldSurface, forkSeed, type SessionEvent, type SessionHandle, type SessionStore } from '../src/session/store.ts'
import { transcriptTurns } from '../src/server/web.ts'

/**
 * A fork is seeded with its source's **log**, not with the projection of it (#52, #55).
 *
 * DSH's `session/fork` cuts at `latestCompletedPrefixBoundary` and seeds the child with that exact event prefix
 * (dsh-api-session-controller/lib/index.js:724-733, 870-872; `buildForkSeed`, dsh-session/lib/types/fork.js:18-27), so the
 * branch shows the source's turns as they were. Measured on both builds before this: the fork re-appended every surface node
 * as one `message`, so a reasoning turn read "17 × 23 = 391.391" with no reasoning row, a tool call lost its name and
 * command, and a compacted source handed over only its summary and live turns.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-fork-seed-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let roots = 0
function service(): SessionService {
  roots += 1
  return new SessionService(new Context(), { root: join(scratch, `root-${roots}`) })
}

/** A turn as the loop records it: the prompt, the request, the streamed answer (reasoning first), its completion. */
function reasoningTurn(svc: SessionService, handle: SessionHandle, prompt: string, answer: readonly string[], reasoning: readonly string[]): void {
  const store = svc.store
  svc.user(handle, prompt)
  store.modelRequest(handle, { endpoint: 'scripted', messages: 2, tools: [] })
  for (const text of reasoning) store.assistantChunk(handle, { type: 'reasoning-delta', text })
  for (const text of answer) store.assistantChunk(handle, { type: 'text-delta', text })
  store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  store.append(handle, { type: 'assistant/completed', text: answer.join(''), reasoning: reasoning.join(''), finishReason: 'stop', rounds: 1 })
  store.append(handle, { type: 'turn/completed', rounds: 1 })
}

/** A turn that runs one tool: the call, its result, the closing answer. */
function toolTurn(svc: SessionService, handle: SessionHandle): void {
  const store = svc.store
  svc.user(handle, 'Use the bash tool to run exactly: echo FORKTOOL-77. Then reply with only: done.')
  store.modelRequest(handle, { endpoint: 'scripted', messages: 2, tools: ['bash'] })
  store.assistantChunk(handle, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"echo FORKTOOL-77"}' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'tool_calls' })
  store.message(handle, { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'FORKTOOL-77\n' }] })
  store.modelRequest(handle, { endpoint: 'scripted', messages: 4, tools: ['bash'] })
  store.assistantChunk(handle, { type: 'text-delta', text: 'done' })
  store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  store.append(handle, { type: 'assistant/completed', text: 'done', finishReason: 'stop', rounds: 2 })
  store.append(handle, { type: 'turn/completed', rounds: 2 })
}

/** A compaction as the engine records it (src/context/compaction.ts): every surface node but the newest `keep` is shadowed. */
function compact(store: SessionStore, handle: SessionHandle, keep: number): void {
  const nodes = store.surface(handle).nodes
  const shadowedSeqs = nodes.slice(0, nodes.length - keep)
  const fromSeq = shadowedSeqs[0] ?? 0
  const throughSeq = shadowedSeqs.at(-1) ?? 0
  const start = store.append(handle, { type: 'compaction/start', fromSeq, throughSeq, shadowedSeqs, shadowedTokenCount: 900, estimatedTokens: 1200, thresholdTokens: 1000 })
  const text = '<compacted-summary>\nthe briefing: the code word is WALRUS-9\n</compacted-summary>'
  const summary = store.append(handle, { type: 'compaction/summary', fromSeq, throughSeq, summary: text, shadowedSeqs, shadowedTokenCount: 900, estimatedTokens: 20 })
  const replacement = store.append(
    handle,
    { type: 'context/note', message: { role: 'user', content: [{ type: 'text', text }] }, origin: 'compaction' },
    { surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: throughSeq }, sourceEventSeqs: [start.seq, summary.seq, ...shadowedSeqs] },
  )
  store.append(handle, { type: 'compaction/end', fromSeq, throughSeq, summarySeq: summary.seq, replacementSeq: replacement.seq })
  store.append(handle, { type: 'compaction/measured', before: 1200, after: 320 })
}

function forkOf(svc: SessionService, source: SessionHandle): SessionHandle {
  const forked = svc.fork(source.id)
  assert.ok(forked !== null && 'handle' in forked, `the source forks\nsaw: ${JSON.stringify(forked)}`)
  return forked.handle
}

/** What a person reads in the chat, and what the model is sent: both must be the source's. */
function sameConversation(svc: SessionService, source: SessionHandle, child: SessionHandle): void {
  /**
   * A closing answer's `forkSeq` names the `turn/completed` of its own log, the seq the Branch action cuts at, so it moves
   * with the child's renumbering; the row compares by whether it can be branched from, and the child's seq is checked
   * against the child's log.
   */
  const conversation = (rows: ReturnType<typeof transcriptTurns>) => rows.map(({ forkSeq, ...row }) => ({ ...row, branchable: forkSeq !== undefined }))
  const sourceRows = conversation(transcriptTurns(svc.store.read(source)))
  const childRows = conversation(transcriptTurns(svc.store.read(child)))
  assert.deepEqual(childRows, sourceRows, `the fork's rows are the source's\nsource: ${JSON.stringify(sourceRows)}\nfork:   ${JSON.stringify(childRows)}`)
  const childEvents = new Map(svc.store.read(child).map((event) => [event.seq, event]))
  for (const row of transcriptTurns(svc.store.read(child))) {
    if (row.forkSeq !== undefined) assert.equal(childEvents.get(row.forkSeq)?.type, 'turn/completed', `a branchable answer in the fork names the fork's own turn end\nsaw: ${row.forkSeq}`)
  }
  assert.deepEqual(svc.store.messages(child), svc.store.messages(source), "and the fork's model reads what the source's model read")
}

test('a fork of a reasoning turn shows the reasoning as its own row and the answer alone (#52)', () => {
  const svc = service()
  const source = svc.start({ cwd: scratch, title: 'Reasoning' })
  reasoningTurn(svc, source, 'What is 17 times 23? Think it through, then reply with the number only.', ['39', '1'], ['17', ' × 23', ' = 391.'])

  const child = forkOf(svc, source)
  const rows = transcriptTurns(svc.store.read(child)).map((row) => [row.kind, row.text])
  assert.deepEqual(
    rows,
    [
      ['user', 'What is 17 times 23? Think it through, then reply with the number only.'],
      ['reasoning', '17 × 23 = 391.'],
      ['assistant', '391'],
    ],
    'the reasoning is a row of its own, and the answer is not glued to it',
  )
  sameConversation(svc, source, child)
})

test("a fork of a tool turn keeps the call's name and command beside its result (#52)", () => {
  const svc = service()
  const source = svc.start({ cwd: scratch, title: 'Tool' })
  toolTurn(svc, source)

  const child = forkOf(svc, source)
  const tool = transcriptTurns(svc.store.read(child)).find((row) => row.kind === 'tool')
  assert.equal(tool?.name, 'bash', 'the call keeps its name')
  assert.equal(tool?.text, '{"command":"echo FORKTOOL-77"}', 'and its command')
  assert.equal(tool?.result, 'FORKTOOL-77\n', 'beside its result')
  sameConversation(svc, source, child)
})

test('a fork of a compacted session keeps every turn before the compaction, and the summary stands in for them in its context (#55)', () => {
  const svc = service()
  const source = svc.start({ cwd: scratch, title: 'Compacted' })
  reasoningTurn(svc, source, 'Remember the code word WALRUS-9. Reply with only: noted.', ['noted.'], ['The user asks me to remember it.'])
  reasoningTurn(svc, source, 'Write about bridges, part 1', ['Bridges, part one.'], ['Part 1.'])
  svc.user(source, 'Write about bridges, part 2')
  compact(svc.store, source, 1)
  svc.store.assistantChunk(source, { type: 'text-delta', text: 'Bridges, part two.' })
  svc.store.assistantChunk(source, { type: 'done', finishReason: 'stop' })
  svc.store.append(source, { type: 'assistant/completed', text: 'Bridges, part two.', finishReason: 'stop', rounds: 1 })
  svc.store.append(source, { type: 'turn/completed', rounds: 1 })

  const child = forkOf(svc, source)
  const prompts = transcriptTurns(svc.store.read(child)).filter((row) => row.kind === 'user').map((row) => row.text)
  assert.deepEqual(
    prompts,
    ['Remember the code word WALRUS-9. Reply with only: noted.', 'Write about bridges, part 1', 'Write about bridges, part 2'],
    'the branch starts where its source started, not at the compaction',
  )
  const types = svc.store.read(child).map((event) => event.type)
  for (const record of ['compaction/start', 'compaction/summary', 'compaction/end']) {
    assert.ok(types.includes(record), `the branch carries the source's ${record} record`)
  }
  const context = svc.store.messages(child).map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join(''))
  assert.match(context[0] ?? '', /WALRUS-9/, 'and its model reads the summary first')
  assert.ok(!context.some((text) => text.includes('Remember the code word')), 'in place of the turns it summarises')
  sameConversation(svc, source, child)

  const listed = svc.list()
  assert.equal(listed.find((meta) => meta.id === child.id)?.turns, listed.find((meta) => meta.id === source.id)?.turns, 'the fork counts as many turns as its source')
})

test("the seed is the source's own events, byte for byte, with their own times, and it is not published as live activity", () => {
  const published: { session: string; type: string }[] = []
  const svc = new SessionService(new Context(), { root: join(scratch, 'published') }, { onEvent: (handle, event) => published.push({ session: handle.id, type: event.type }) })
  const store = svc.store
  const source = store.create({ cwd: scratch, title: 'Bytes' })
  reasoningTurn(svc, source, 'a prompt', ['an answer'], ['a thought'])

  const child = store.fork(source.id, { parentSession: source.id })
  assert.ok(child !== null)
  const line = (event: SessionEvent): string => JSON.stringify(event)
  assert.deepEqual(store.read(child).slice(1).map(line), store.read(source).slice(1).map(line), 'every inherited event is the source line, seq and time included')
  assert.equal(store.read(child)[0]?.type, 'session/created', 'after the child’s own creation')
  assert.deepEqual(
    published.filter((one) => one.session === child.id).map((one) => one.type),
    ['session/created'],
    'and only the creation was published: the seed is history, not a turn happening now',
  )
})

test("an event that belongs to the source stays behind, and the seqs after it are renumbered in every field that names one", () => {
  const svc = service()
  const store = svc.store
  const source = svc.start({ cwd: scratch, title: 'Renumbered' })
  /** A goal, a team journal entry and a repair record: the source's own, which the child must not inherit. */
  store.append(source, { type: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal-1', objective: 'x', phase: 'active' } })
  store.append(source, { type: 'team/member', version: 1, teamId: source.id, member: { id: 'm', name: 'm' } })
  store.append(source, { type: 'transcript/repaired', droppedBytes: 3 })
  reasoningTurn(svc, source, 'first', ['one'], ['thinking one'])
  reasoningTurn(svc, source, 'second', ['two'], ['thinking two'])
  svc.user(source, 'third')
  compact(store, source, 1)
  reasoningTurn(svc, source, 'fourth', ['four'], ['thinking four'])

  const child = forkOf(svc, source)
  const events = store.read(child)
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index), 'the child’s seqs run on without a hole')
  assert.ok(!events.some((event) => event.type === 'goal/change' || event.type.startsWith('team/') || event.type === 'transcript/repaired'), 'none of the source’s own records came along')
  assert.equal(events.filter((event) => event.type === 'session/created').length, 1, 'and only the child’s own creation')

  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const end = events.find((event) => event.type === 'compaction/end')
  assert.equal(bySeq.get(end?.summarySeq as number)?.type, 'compaction/summary', 'the end record names the child’s summary')
  const replacement = bySeq.get(end?.replacementSeq as number)
  assert.equal(replacement?.origin, 'compaction', 'and the child’s replacement note')
  const op = replacement?.surfaceOp as { startSeq: number; endSeq: number }
  assert.equal(op.startSeq, end?.fromSeq, 'whose range is the end record’s range')
  assert.equal(bySeq.get(op.startSeq)?.type, 'message', 'starting at the child’s first prompt')
  assert.equal((bySeq.get(op.startSeq)?.message as { content: { text: string }[] }).content[0]?.text, 'first')
  assert.equal(bySeq.get((replacement?.sourceEventSeqs as number[])[0] ?? -1)?.type, 'compaction/start', 'and its sources name the child’s start record')
  assert.doesNotThrow(() => foldSurface(events), 'the child’s surface folds')
  sameConversation(svc, source, child)
})

test('forkSeed returns the inherited events untouched when nothing is left out', () => {
  const events: SessionEvent[] = [
    { seq: 0, at: 't0', type: 'session/created', cwd: '/x' },
    { seq: 1, at: 't1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, at: 't2', type: 'context/note', message: { role: 'user', content: [] }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] },
  ]
  const seeded = forkSeed(events, 1)
  assert.equal(seeded.length, 2)
  assert.equal(seeded[0], events[1], 'the same objects, so the same bytes')
  assert.equal(seeded[1], events[2])
})

/** The same source and expected seed as heddle-session `surface.rs`, so both builds write a fork's log with the same bytes. */
const SEED_SOURCE = [
  '{"seq":0,"at":"t0","type":"session/created","cwd":"/w"}',
  '{"seq":1,"at":"t1","type":"goal/change","version":1}',
  '{"seq":2,"at":"t2","type":"message","message":{"role":"user","content":[{"type":"text","text":"one"}]}}',
  '{"seq":3,"at":"t3","type":"assistant/chunk","chunk":{"type":"text-delta","text":"a"}}',
  '{"seq":4,"at":"t4","type":"assistant/chunk","chunk":{"type":"done","finishReason":"stop"}}',
  '{"seq":5,"at":"t5","type":"turn/completed","rounds":1}',
  '{"seq":6,"at":"t6","type":"message","message":{"role":"user","content":[{"type":"text","text":"two"}]}}',
  '{"seq":7,"at":"t7","type":"compaction/start","fromSeq":2,"throughSeq":3,"shadowedSeqs":[2,3]}',
  '{"seq":8,"at":"t8","type":"compaction/summary","fromSeq":2,"throughSeq":3,"summary":"s","shadowedSeqs":[2,3]}',
  '{"seq":9,"at":"t9","type":"context/note","message":{"role":"user","content":[{"type":"text","text":"s"}]},"origin":"compaction","surfaceOp":{"op":"replace","startSeq":2,"endSeq":3},"sourceEventSeqs":[7,8,2,3]}',
  '{"seq":10,"at":"t10","type":"compaction/end","fromSeq":2,"throughSeq":3,"summarySeq":8,"replacementSeq":9}',
  '{"seq":11,"at":"t11","type":"compaction/prune","shadowedRange":{"start":6,"end":6},"shadowedSeqs":[6]}',
]
const SEED_EXPECTED = [
  '{"seq":1,"at":"t2","type":"message","message":{"role":"user","content":[{"type":"text","text":"one"}]}}',
  '{"seq":2,"at":"t3","type":"assistant/chunk","chunk":{"type":"text-delta","text":"a"}}',
  '{"seq":3,"at":"t4","type":"assistant/chunk","chunk":{"type":"done","finishReason":"stop"}}',
  '{"seq":4,"at":"t5","type":"turn/completed","rounds":1}',
  '{"seq":5,"at":"t6","type":"message","message":{"role":"user","content":[{"type":"text","text":"two"}]}}',
  '{"seq":6,"at":"t7","type":"compaction/start","fromSeq":1,"throughSeq":2,"shadowedSeqs":[1,2]}',
  '{"seq":7,"at":"t8","type":"compaction/summary","fromSeq":1,"throughSeq":2,"summary":"s","shadowedSeqs":[1,2]}',
  '{"seq":8,"at":"t9","type":"context/note","message":{"role":"user","content":[{"type":"text","text":"s"}]},"origin":"compaction","surfaceOp":{"op":"replace","startSeq":1,"endSeq":2},"sourceEventSeqs":[6,7,1,2]}',
  '{"seq":9,"at":"t10","type":"compaction/end","fromSeq":1,"throughSeq":2,"summarySeq":7,"replacementSeq":8}',
  '{"seq":10,"at":"t11","type":"compaction/prune","shadowedRange":{"start":5,"end":5},"shadowedSeqs":[5]}',
]

test('forkSeed renumbers every seq after an event it leaves behind, with the bytes the Rust build writes', () => {
  const seeded = forkSeed(SEED_SOURCE.map((line) => JSON.parse(line) as SessionEvent), 1)
  assert.deepEqual(seeded.map((event) => JSON.stringify(event)), SEED_EXPECTED)
  const child = [JSON.parse('{"seq":0,"at":"c","type":"session/created"}') as SessionEvent, ...seeded]
  assert.deepEqual(foldSurface(child).nodes, [8, 5], 'the summary stands where the first turn stood')
})
