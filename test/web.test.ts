import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pageAccess, tokenFormPage, transcriptTurns, abortSession } from '../src/server/web.ts'

/**
 * Unit tests for the Web UI's two pure pieces.
 *
 * The verifiers judge the delivered page in a browser, which is the only way to see a rendering failure.
 * These judge the two decisions **underneath** it — how a recorded session folds into display turns, and
 * which refusal a caller is shown — because both have rules that are easy to get subtly wrong and cheap to
 * state here: the fold must read deltas rather than completions, and the two refusals must not read alike.
 */

test('a tool call keeps its name as a label, apart from its arguments', () => {
  /**
   * The label is what a collapsed block shows. Deriving it on the client would mean parsing it back out of
   * the string this function just built, so it is carried as a field.
   */
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } },
  ])
  assert.deepEqual(turns, [
    { kind: 'tool', name: 'bash', label: '→ bash', text: '{"command":"pwd"}', state: 'running', toolCallId: 'c1' },
  ])
})

test('reasoning keeps its own kind, because a reader wants it apart from the answer', () => {
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } },
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.kind, turn.text]),
    [
      ['reasoning', 'thinking'],
      ['assistant', 'answer'],
    ],
  )
})

test('a completed turn is not read as well as its deltas, or every answer would appear twice', () => {
  /**
   * The log records both for one turn: the deltas as they arrived, and the settled `assistant/completed`.
   * Reading both is the mistake this test exists to prevent, and it is invisible in a transcript with one
   * short answer because the duplicate looks like a second paragraph.
   */
  const events = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ask' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the answer' } },
    { type: 'assistant/completed', text: 'the answer', reasoning: 'why' },
    { type: 'turn/completed', turns: 1 },
  ]
  const turns = transcriptTurns(events)
  assert.equal(turns.filter((turn) => turn.text === 'the answer').length, 1, 'the answer appears once')
  assert.equal(turns.length, 2, 'the user line and the answer, and nothing else')
})

test('a tool result is a tool turn, and an error result is marked denied', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'output' }] } },
    { type: 'message', message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'error: refused' }] } },
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.kind, turn.state]),
    [
      ['tool', 'ok'],
      ['tool', 'error'],
    ],
    'a result with no call to fill in is still shown, and says whether it failed',
  )
})

test('a tool result fills the call it answers, so the two are one turn', () => {
  /**
   * The claim the chat view exists to make: "it ran this and got that" is one element a reader can open,
   * not two rows to match up by eye. The id is what pairs them, and the fold is where the pairing lives,
   * because a client that had to do it would be re-deriving the transcript from a flat list.
   */
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] } },
    { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'I should look' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'list_dir', arguments: '{"path":"/tmp"}' } },
    { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt\nb.txt' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'two files' } },
  ])

  assert.deepEqual(turns, [
    { kind: 'user', text: 'list the files' },
    { kind: 'reasoning', text: 'I should look' },
    { kind: 'tool', name: 'list_dir', label: '→ list_dir', text: '{"path":"/tmp"}', state: 'ok', toolCallId: 'c1', result: 'a.txt\nb.txt' },
    { kind: 'assistant', text: 'two files' },
  ])
  assert.equal(turns.filter((turn) => turn.kind === 'tool').length, 1, 'one call, one turn')
})

test('a call with no id is paired with the newest call still open', () => {
  /**
   * Not every provider sends an id. Pairing by position is the fallback, and it must not reach backwards
   * past a call that already has its result — otherwise a second call would fill in the first one's row.
   */
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'bash', arguments: '{"command":"one"}' } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'bash', arguments: '{"command":"two"}' } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'second' }] } },
  ])
  assert.deepEqual(
    turns.map((turn) => [turn.text, turn.result, turn.state]),
    [
      ['{"command":"one"}', 'first', 'ok'],
      ['{"command":"two"}', 'second', 'ok'],
    ],
  )
})

test('events that are not a display turn are ignored rather than rendered as blanks', () => {
  const turns = transcriptTurns([
    { type: 'session/created', cwd: '/tmp' },
    { type: 'model/request', messages: 2 },
    { type: 'assistant/chunk', chunk: { type: 'done' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'kept' }] } },
  ])
  assert.deepEqual(turns, [{ kind: 'user', text: 'kept' }])
})

test('a refusal with no token and a refusal with a stale one say different things', () => {
  /**
   * They are different situations and a person acts differently on each: one has never had a token, the
   * other had one that stopped working. The page has to tell them apart, and it has to carry the form — the
   * earlier version was a sentence with no way forward, which turned every restart into an outage.
   */
  const fresh = tokenFormPage()
  const stale = tokenFormPage({ stale: true })

  assert.match(fresh, /token is required/i, 'the no-token page says a token is required')
  assert.doesNotMatch(fresh, /not the current one/i)
  assert.match(stale, /not the current one/i, 'the stale page says the token is stale')
  assert.doesNotMatch(stale, /is required for this page/i)

  /**
   * The pairs are annotated because `noUncheckedIndexedAccess` makes a destructured element of an
   * inferred array type `string | undefined`. That is a claim about indexed access, not about this
   * page: `tokenFormPage` returns a `string`, and saying so here is what keeps the refusal judged
   * for what it says rather than for how the literal was inferred.
   */
  const refusals: readonly (readonly [string, string])[] = [
    ['no token', fresh],
    ['stale token', stale],
  ]
  for (const [label, html] of refusals) {
    assert.match(html, /<form method="get" action="\/"/, `${label}: carries the form`)
    assert.match(html, /name="token"/, `${label}: has somewhere to paste a token`)
    assert.match(html, /web\.log/, `${label}: says where the current token is`)
    assert.match(html, /^<!doctype html>/i, `${label}: is a document rather than a sentence`)
  }
})

test('the page needs a session, and a refusal says which situation the caller is in', () => {
  /**
   * The bare URL used to answer `200` with a whole UI and an empty log, which reads as a page that lost its
   * data rather than as one that was never opened with a token. DSH refuses the bare URL, and so does this —
   * while a browser that has been through the printed URL keeps working, because the cookie is the same
   * credential the token mints.
   */
  assert.deepEqual(pageAccess({ ok: true }, { cookie: true }), { status: 200, stale: false }, 'a session is served')
  assert.deepEqual(pageAccess({ ok: true }, { cookie: false }), { status: 200, stale: false }, 'a launch token in the query is a session too')

  assert.deepEqual(pageAccess({ ok: false }, { cookie: false }), { status: 401, stale: false }, 'no credential is refused as a missing token')
  assert.deepEqual(
    pageAccess({ ok: false }, { cookie: true }),
    { status: 401, stale: true },
    'a credential that was offered and refused is called stale, which is a different message',
  )
})

test('a streamed answer is one turn however many deltas it arrived in', () => {
  /**
   * Measured in a browser on 2026-10-17: opening a session drew an answer as dozens of rows, one per
   * `text-delta` the provider had sent. The live view merges deltas into one node; the history fold did
   * not, so the same answer read as a different conversation after a reload.
   */
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'one ' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer ' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'in three parts' } },
  ])
  assert.deepEqual(turns, [{ kind: 'assistant', text: 'one answer in three parts' }])
})

test('a reasoning run is one turn too, and the answer is a turn of its own', () => {
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'think ' } },
    { type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'harder' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the ' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'answer' } },
  ])
  assert.deepEqual(turns, [
    { kind: 'reasoning', text: 'think harder' },
    { kind: 'assistant', text: 'the answer' },
  ])
})

test('a tool call separates the text runs around it', () => {
  const turns = transcriptTurns([
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'let me check. ' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } },
    { type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '/tmp' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'done.' } },
  ])
  assert.deepEqual(turns.map((turn) => turn.kind), ['assistant', 'tool', 'assistant'])
  assert.equal(turns[0]?.text, 'let me check. ', 'the text before the call stays one turn')
  assert.equal(turns[1]?.result, '/tmp', 'the result still fills the call it answers')
  assert.equal(turns[2]?.text, 'done.', 'and the text after it is a new one')
})

test('a stop aborts every running turn of one session, and finds none the second time', () => {
  /**
   * The rule the composer's Stop button asks about: it aborts the handles that session is running under and
   * clears them, so a second click is a no-op rather than an abort of something else.
   */
  const first = new AbortController()
  const second = new AbortController()
  const other = new AbortController()
  const controllers = new Map<string, Set<AbortController>>([
    ['session-a', new Set([first, second])],
    ['session-b', new Set([other])],
  ])
  assert.equal(abortSession(controllers, 'session-a'), 2)
  assert.equal(first.signal.aborted, true, 'every handle of the session is aborted')
  assert.equal(second.signal.aborted, true)
  assert.equal(other.signal.aborted, false, 'another session is untouched')
  assert.equal(abortSession(controllers, 'session-a'), 0, 'a second stop finds nothing')
  assert.equal(controllers.has('session-a'), false, 'and the session holds no handles')
})
