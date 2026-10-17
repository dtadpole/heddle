import assert from 'node:assert/strict'
import { test } from 'node:test'

import { laneOf, previewOf, projectLedger, projectRows, projectTimeline, type LedgerEvent } from '../src/server/ledger.ts'

/**
 * Unit tests for the Trajectory ledger.
 *
 * The verifier judges what a browser draws; these judge the projection underneath it, which is where the
 * three rules that a reader would believe live: an in-flight record has no duration, an unreported number is
 * absent rather than zero, and a duration comes from the record's own events.
 */

/** One logged event, in the shape the ledger reads: a sequence, a time, and whatever the type carries. */
const event = (seq: number, at: string, rest: Record<string, unknown>): LedgerEvent => ({ seq, at, ...rest }) as LedgerEvent

test('one prompt becomes one turn with its steps, and the records are grouped under them', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'session/created', cwd: '/tmp' }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'what is a heddle?' }] } }),
    event(3, '2026-10-11T10:00:00.100Z', { type: 'model/request', messages: 1, estimatedTokens: 1200, endpoint: 'x', tools: ['bash'] }),
    event(4, '2026-10-11T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } }),
    event(5, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the part of a loom' } }),
    event(6, '2026-10-11T10:00:01.500Z', { type: 'assistant/completed', text: 'the part of a loom', finishReason: 'stop', rounds: 1 }),
    event(7, '2026-10-11T10:00:01.500Z', { type: 'turn/completed', rounds: 1 }),
  ])

  assert.equal(ledger.turns.length, 1, 'one turn')
  assert.equal(ledger.turns[0]!.steps.length, 1, 'and one step for one request')
  const kinds = ledger.turns[0]!.steps[0]!.records.map((record) => record.kind)
  /**
   * The trailing `system` record is the settled answer's own summary — its finish reason and round count.
   * It is a record rather than a decoration because the ledger is where a reader looks for why a step ended
   * the way it did.
   */
  assert.deepEqual(kinds, ['user', 'system', 'reasoning', 'assistant', 'system'], 'the records are grouped in order')
  assert.match(ledger.turns[0]!.steps[0]!.records[4]!.text, /finish:/, 'the last one says how the step ended')
  assert.equal(ledger.turns[0]!.steps[0]!.records[0]!.text, 'what is a heddle?', 'the prompt is the turn opener')
  assert.match(ledger.turns[0]!.steps[0]!.records[1]!.text, /1200|message/, 'the request record carries what the request said')
})

test('a turn and its step get durations, and a step with no end gets none', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:02.000Z', { type: 'assistant/completed', text: 'done' }),
    event(4, '2026-10-11T10:00:02.000Z', { type: 'turn/completed', rounds: 1 }),
  ])
  assert.equal(ledger.turns[0]!.durationMs, 2000, 'the turn measured two seconds')
  assert.equal(ledger.turns[0]!.steps[0]!.durationMs, 2000, 'and so did its step')
})

test('an unfinished stream is marked in flight and carries no duration', () => {
  /**
   * The rule DSH states as "in-flight records show a start marker without inventing elapsed time". It covers a
   * killed run and a stream still arriving, and the field is what a renderer needs to avoid printing a
   * duration for something that has not finished.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.500Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'half an ans' } }),
  ])
  const partial = ledger.turns[0]!.steps[0]!.records.find((record) => record.kind === 'assistant')
  assert.ok(partial, 'the partial answer is recorded')
  assert.equal(partial.inFlight, true, 'and marked in flight')
  assert.equal(partial.durationMs, undefined, 'with no duration invented for it')
  assert.equal(partial.startedAt, '2026-10-11T10:00:00.500Z', 'but with the start it does know')
  assert.equal(ledger.inFlight, 1, 'and the ledger counts it')
})

test('an unreported token count is absent, not zero', () => {
  /**
   * `inputTokens: 0` says a request cost nothing. "Not reported" is a different claim, and a renderer that
   * cannot tell them apart will print the false one.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'answer' }),
  ])
  const answer = ledger.turns[0]!.steps[0]!.records.find((record) => record.kind === 'assistant')!
  assert.equal(answer.usage, undefined, 'no usage object at all rather than zeroes')
  assert.deepEqual(ledger.tokens, {}, 'and the totals are empty rather than zero')
})

test('provider usage is kept apart from the harness estimate', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 900 }),
    event(3, '2026-10-11T10:00:00.500Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'assistant/chunk', chunk: { type: 'done', usage: { inputTokens: 812, outputTokens: 7 } } }),
    event(5, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'answer' }),
  ])
  const records = ledger.turns[0]!.steps[0]!.records
  const request = records.find((record) => record.label === 'request')!
  const answer = records.find((record) => record.kind === 'assistant')!
  assert.equal(request.usageSource, 'estimated', 'the request record is the harness estimate')
  assert.equal(answer.usageSource, 'provider', 'and the answer holds what the provider reported')
  assert.deepEqual(answer.usage, { inputTokens: 812, outputTokens: 7 })
  assert.deepEqual(ledger.tokens, { input: 812, output: 7, estimated: 900 }, 'the totals keep the two apart')
})

test('a tool call and its result are one record, and a refusal marks that record', () => {
  /**
   * The owner's rule of 2026-10-17, and DSH's shape: one element per call, carrying its result. The two
   * halves are in the log as separate events; the projection is where they become one row, because a
   * client that had to pair them would be re-deriving the transcript from a flat list.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'run it' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.100Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } }),
    event(4, '2026-10-11T10:00:00.200Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '/Users/zhenc' }] } }),
    event(5, '2026-10-11T10:00:00.300Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c2', name: 'write_file', arguments: '{"path":"/etc/x"}' } }),
    event(6, '2026-10-11T10:00:00.400Z', { type: 'message', message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'error: outside the sandbox root' }] } }),
  ])
  const calls = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'tool')
  assert.equal(calls.length, 2, 'two calls, two records — not four')
  assert.equal(calls[0]!.name, 'bash', 'the first names its tool')
  assert.equal(calls[0]!.text, '{"command":"pwd"}', 'and holds the arguments exactly as recorded')
  assert.equal(calls[0]!.result, '/Users/zhenc', 'with the answer on the same record')
  assert.equal(calls[0]!.state, 'ok')
  assert.equal(calls[1]!.name, 'write_file')
  assert.equal(calls[1]!.state, 'error', 'a refusal marks the call it answers')
  assert.equal(calls[1]!.note, 'the tool refused this call', 'and says so in words')
})

test('records that belong to no turn are kept, not dropped', () => {
  /**
   * A ledger that silently ignores what it does not recognise cannot be trusted to be complete. This is the
   * property that makes the projection safe to extend: an unknown event shows up as a system record.
   */
  const ledger = projectLedger([event(1, '2026-10-11T10:00:00.000Z', { type: 'something/new', detail: 7 })])
  assert.equal(ledger.turns.length, 0, 'no turn was opened')
  assert.equal(ledger.loose.length, 1, 'and the event is kept as a loose record')
  assert.equal(ledger.loose[0]!.label, 'something/new', 'named by its own type')
})

test('projecting the same events twice gives the same ledger', () => {
  const events = [
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'done' }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
  ]
  assert.deepEqual(projectLedger(events), projectLedger(events), 'a pure projection has no state to drift')
})

test('an answer recorded only as a completion still appears', () => {
  /**
   * Measured in a browser before this test existed: a session whose answer arrived as a bare
   * `assistant/completed` — which is what that event carries — produced no assistant record at all, because
   * the handler settled a pending stream and then only wrote the finish-reason note. A ledger without the
   * answers is not a ledger.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.100Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'the answer', finishReason: 'stop' }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const answer = ledger.turns[0]!.steps[0]!.records.find((record) => record.kind === 'assistant')!
  assert.ok(answer, 'the answer is recorded')
  assert.equal(answer.text, 'the answer', 'with the text the completion carried')
})

test('a stream and its completion yield one answer, not two', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.100Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.500Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the answer' } }),
    event(4, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'the answer' }),
    event(5, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const answers = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'assistant')
  assert.equal(answers.length, 1, 'the stream is the answer, and the completion does not duplicate it')
  assert.equal(answers[0]!.text, 'the answer')
})

test('the timeline is the recorded span, and an untimed record contributes no span', () => {
  /**
   * The axis is where a reader looks for "how long", so a bar drawn from a guessed start is a bar that lies.
   * A record with no timing stays in the ledger and is absent from the axis.
   */
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:02.000Z', { type: 'assistant/completed', text: 'done' }), // no time on purpose
    event(4, '2026-10-11T10:00:02.000Z', { type: 'turn/completed', rounds: 1 }),
    // an untimed record: it is in the ledger but must not appear on the axis
    { type: 'something/new' },
  ])
  const timeline = projectTimeline(ledger)
  assert.equal(timeline.startsAt, '2026-10-11T10:00:00.000Z', 'the domain starts at the earliest recorded time')
  assert.equal(timeline.durationMs, 2000, 'and spans the recorded two seconds')
  assert.equal(timeline.spans.length, 1, 'one turn, one span')
  assert.equal(timeline.spans[0]!.turn, 1, 'labelled with its turn')
  assert.ok(timeline.spans[0]!.start === 0, 'starting at the left edge')
  assert.ok(timeline.spans[0]!.end > 0.9, 'and reaching the right')
})

test('a running record extends the axis and marks its span running', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:05.000Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'still going' } }),
  ])
  const timeline = projectTimeline(ledger)
  assert.equal(timeline.endsAt, '2026-10-11T10:00:05.000Z', 'the domain reaches the newest event')
  assert.equal(timeline.spans[0]!.running, true, 'and the span is marked running rather than given a duration')
})

test('a ledger with nothing timed has an empty axis rather than a made-up one', () => {
  assert.deepEqual(projectTimeline(projectLedger([{ type: 'session/created' }])), { spans: [], durationMs: 0 })
})

test('spans are ordered by turn and each keeps a visible width', () => {
  const ledger = projectLedger([
    event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } }),
    event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(3, '2026-10-11T10:00:00.000Z', { type: 'turn/completed', rounds: 1 }),
    event(4, '2026-10-11T10:00:10.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } }),
    event(5, '2026-10-11T10:00:10.000Z', { type: 'model/request', estimatedTokens: 10 }),
    event(6, '2026-10-11T10:00:20.000Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const timeline = projectTimeline(ledger)
  assert.deepEqual(timeline.spans.map((span) => span.turn), [1, 2], 'in turn order')
  /**
   * The floor is a share of the axis wide enough to **aim at**, not merely to see. The first version used
   * 0.4%, which came out as a two-pixel sliver in a session with a long gap between turns — legible as
   * "something happened here" and unusable as a control.
   */
  assert.ok(timeline.spans.every((span) => span.end - span.start >= 0.02), 'each is wide enough to pick')
})

test("a turn's band is coloured by what it did, not by the prompt that opened it", () => {
  /**
   * Every turn starts with a user record. Ordering the kinds by the first record therefore made every band
   * the same colour — measured, and it is the kind of detail that looks fine in a test and useless on screen.
   */
  const withTool = projectTimeline(
    projectLedger([
      event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
      event(3, '2026-10-11T10:00:00.100Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'bash', arguments: '{}' } }),
      event(4, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
    ]),
  )
  const withAnswer = projectTimeline(
    projectLedger([
      event(1, '2026-10-11T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
      event(2, '2026-10-11T10:00:00.000Z', { type: 'model/request', estimatedTokens: 10 }),
      event(3, '2026-10-11T10:00:01.000Z', { type: 'assistant/completed', text: 'done' }),
      event(4, '2026-10-11T10:00:01.000Z', { type: 'turn/completed', rounds: 1 }),
    ]),
  )
  assert.equal(withTool.spans[0]!.kinds[0]!, 'tool', 'a turn that called a tool leads with the tool')
  assert.equal(withAnswer.spans[0]!.kinds[0]!, 'assistant', 'and a turn that only answered leads with the answer')
})

test('a tool result fills the call it answers, so one row holds both halves', () => {
  /**
   * The Trajectory table shows one row per tool **call**, with the result inside it — DSH's shape. Two rows
   * per call is what the owner asked to replace: matching them up by eye is the reader's problem, and it is
   * a problem the projection can solve because the id is already in the log.
   */
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'list it' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'list_dir', arguments: '{"path":"/tmp"}' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt\nb.txt' }] } }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const tools = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'tool')
  assert.equal(tools.length, 1, 'one call, one record')
  assert.equal(tools[0]!.name, 'list_dir', 'the call names the tool, apart from the arrow its label carries')
  assert.equal(tools[0]!.text, '{"path":"/tmp"}', 'and keeps its arguments')
  assert.equal(tools[0]!.result, 'a.txt\nb.txt', 'with the answer on the same record')
  assert.equal(tools[0]!.state, 'ok', 'and a state that says it worked')
})

test('an error result marks the call failed, and a result with no call is still shown', () => {
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"false"}' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'error: exit 1' }] } }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'message', message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: 'orphan output' }] } }),
    event(6, '2026-10-17T10:00:00.500Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const tools = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'tool')
  assert.equal(tools[0]!.state, 'error', 'a refusal marks the call it answers')
  assert.equal(tools[0]!.result, 'error: exit 1')
  assert.equal(tools[1]!.result, 'orphan output', 'a result with no call is still shown rather than dropped')
  assert.equal(tools[1]!.state, 'ok')
})

test('a call with no id is paired with the newest call still open', () => {
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'bash', arguments: '{"command":"one"}' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'first' }] } }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'bash', arguments: '{"command":"two"}' } }),
    event(6, '2026-10-17T10:00:00.500Z', { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'second' }] } }),
    event(7, '2026-10-17T10:00:00.600Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const tools = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'tool')
  assert.deepEqual(
    tools.map((record) => [record.text, record.result]),
    [
      ['{"command":"one"}', 'first'],
      ['{"command":"two"}', 'second'],
    ],
    'each result fills its own call, not the previous one',
  )
})

test('a context note is a row with its text and its origin, not a JSON dump', () => {
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'context/note', origin: 'instructions', message: { role: 'user', content: [{ type: 'text', text: 'be terse' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'context/note', origin: 'system-prompt', message: { role: 'system', content: [{ type: 'text', text: 'you are heddle' }] } }),
  ])
  const notes = ledger.loose
  assert.equal(notes[0]!.kind, 'context', 'the instruction baseline is a CONTEXT row, as DSH tags it')
  assert.equal(notes[0]!.text, 'be terse', 'the note’s own words, not the event as JSON')
  assert.equal(notes[0]!.origin, 'instructions')
  assert.equal(notes[1]!.kind, 'system', 'the system prompt is a SYSTEM row')
  assert.equal(notes[1]!.text, 'you are heddle')
})

test('rows carry where they sit, so a table can draw boundaries without a tree', () => {
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'a' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'assistant/completed', text: 'a', finishReason: 'stop', rounds: 1 }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'turn/completed', rounds: 1 }),
    event(6, '2026-10-17T10:00:01.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'two' }] } }),
    event(7, '2026-10-17T10:00:01.100Z', { type: 'model/request', messages: 1 }),
    event(8, '2026-10-17T10:00:01.200Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'b' } }),
    event(9, '2026-10-17T10:00:01.300Z', { type: 'assistant/completed', text: 'b', finishReason: 'stop', rounds: 1 }),
    event(10, '2026-10-17T10:00:01.400Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const rows = projectRows(ledger)
  assert.deepEqual(
    rows.map((row) => [row.turn, row.step, row.turnStart, row.stepStart]),
    [
      [1, 1, true, true],
      [1, 1, false, false],
      [1, 1, false, false],
      [2, 1, true, true],
      [2, 1, false, false],
      [2, 1, false, false],
    ],
    'the first row of each turn is marked, and so is the first row of each step',
  )
  assert.equal(rows.filter((row) => row.turnStart).length, 2, 'one boundary per turn')
})

test('a row carries its own one-line preview, so the page does not decide it', () => {
  /**
   * The preview is a claim about the record — an assistant that only called tools has no words, a tool
   * result with no call still names itself — so it is made beside the projection and judged here rather
   * than inside a page no unit test can reach.
   */
  assert.equal(previewOf({ kind: 'user', label: 'user', text: 'two\nlines' }), 'two', 'the first line is the preview')
  assert.equal(previewOf({ kind: 'tool', label: '→ list_dir', name: 'list_dir', text: '{"path":"/tmp"}' }), '{"path":"/tmp"}')
  assert.equal(previewOf({ kind: 'assistant', label: 'assistant', text: '' }), '(tool call only)', 'an answer that only called tools says so')
  assert.equal(previewOf({ kind: 'tool', label: 'tool result', text: '', result: 'a.txt' }), 'tool result', 'a result with no call still names itself')
  assert.equal(previewOf({ kind: 'system', label: 'request', text: '' }), 'request')
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ask' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'turn/completed', rounds: 1 }),
  ])
  assert.equal(projectRows(ledger)[0]!.preview, 'ask', 'and the projection puts it on the row')
})

test('every kind belongs to one of the three overview lanes', () => {
  /**
   * The browser check judges that three lanes are drawn; this judges that a record lands in the right one,
   * which is the half a wrong mapping would silently break.
   */
  assert.equal(laneOf('user'), 'input')
  assert.equal(laneOf('context'), 'input')
  assert.equal(laneOf('system'), 'input')
  assert.equal(laneOf('assistant'), 'model')
  assert.equal(laneOf('reasoning'), 'model')
  assert.equal(laneOf('compaction'), 'model')
  assert.equal(laneOf('tool'), 'tools')
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ask' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const spans = projectTimeline(ledger).spans
  assert.ok(spans.length > 0, 'a turn with a tool call has a span')
  assert.ok(spans[0]!.lanes.includes('tools'), 'and the span says it touched the tools lane')
})

test('a streamed answer and its completion are one record, with the done chunk between them', () => {
  /**
   * The regression the owner saw in the UI: the answer drawn twice. The handler used to ask whether a
   * stream was *pending*, and a `done` chunk settles the pending stream before `assistant/completed`
   * arrives — so the answer was written once from the deltas and once from the completion. This is the
   * real event order of a streamed turn, which the older test omitted.
   */
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'list it' }] } }),
    event(2, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 1 }),
    event(3, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the answer' } }),
    event(4, '2026-10-17T10:00:00.300Z', { type: 'assistant/chunk', chunk: { type: 'done' } }),
    event(5, '2026-10-17T10:00:00.400Z', { type: 'assistant/completed', text: 'the answer' }),
    event(6, '2026-10-17T10:00:00.500Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const answers = ledger.turns[0]!.steps[0]!.records.filter((record) => record.kind === 'assistant')
  assert.equal(answers.length, 1, 'one answer, not two')
  assert.equal(answers[0]!.text, 'the answer')
})

test('the prompt is folded into one step, not every step of the turn', () => {
  /**
   * The second half of the owner's bug: the prompt and its context note appeared in both steps of a turn
   * with two model requests. The prologue was folded into the closing step and then kept because the
   * request boundary passed `keepPrologue`. The user's words belong to the turn's first step only.
   */
  const ledger = projectLedger([
    event(1, '2026-10-17T10:00:00.000Z', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'what is in here' }] } }),
    event(2, '2026-10-17T10:00:00.010Z', { type: 'context/note', origin: 'instructions', message: { role: 'user', content: [{ type: 'text', text: 'be terse' }] } }),
    event(3, '2026-10-17T10:00:00.100Z', { type: 'model/request', messages: 2 }),
    event(4, '2026-10-17T10:00:00.200Z', { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'list_dir', arguments: '{"path":"/tmp"}' } }),
    event(5, '2026-10-17T10:00:00.300Z', { type: 'assistant/chunk', chunk: { type: 'done' } }),
    event(6, '2026-10-17T10:00:00.400Z', { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } }),
    event(7, '2026-10-17T10:00:00.500Z', { type: 'model/request', messages: 4 }),
    event(8, '2026-10-17T10:00:00.600Z', { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'two files' } }),
    event(9, '2026-10-17T10:00:00.700Z', { type: 'assistant/chunk', chunk: { type: 'done' } }),
    event(10, '2026-10-17T10:00:00.800Z', { type: 'assistant/completed', text: 'two files' }),
    event(11, '2026-10-17T10:00:00.900Z', { type: 'turn/completed', rounds: 1 }),
  ])
  const steps = ledger.turns[0]!.steps
  const ofKind = (kind: string) => steps.flatMap((step) => step.records).filter((record) => record.kind === kind)
  assert.equal(ofKind('user').length, 1, 'the prompt is recorded once for the turn')
  assert.equal(ofKind('context').length, 1, 'and so is the instruction baseline it carried')
  assert.equal(steps[1]!.records.filter((record) => record.kind === 'user' || record.kind === 'context').length, 0, 'the second step starts from the model request, not from a copy of the prompt')
})
