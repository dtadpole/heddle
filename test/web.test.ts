import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHash } from 'node:crypto'

import { attachmentsOf, FILE_ANSWER_HEADERS, inlineContentType, markedPage, pageAccess, tokenFormPage, transcriptTurns, abortSession , } from '../src/server/web.ts'
import { mergeUsage } from '../src/agent/loop.ts'

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

test('a person\'s message carries the logged event time, which is the clock its bubble shows', () => {
  /**
   * The bubble's clock is the **recorded** instant, not the render clock: a reloaded session must show when each
   * message was sent. The event's own `at` is what travels, because that is the stamp the log wrote.
   */
  const turns = transcriptTurns([
    { type: 'message', at: '2026-10-17T22:03:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'what is in here' }] } },
    { type: 'message', at: '2026-10-17T22:03:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'two files' }] } },
  ])
  const [asked, answered] = turns
  assert.ok(asked !== undefined && answered !== undefined, 'the log folds into a question and its answer')
  assert.equal(asked.kind, 'user')
  assert.equal(asked.time, '2026-10-17T22:03:00.000Z', 'the user turn carries the event time')
  assert.equal(answered.kind, 'assistant')
})

test('the answer carries the files its exchange wrote, with the lines each one now has', () => {
  /**
   * The Edited-files panel's data. DSH derives it from a host-side before/after comparison; heddle states the fact
   * its log records — a `write_file` call's path and the lines its content carried. `added` counts lines, so a
   * trailing newline closes the last line instead of opening an empty one.
   */
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'make two files' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'one\ntwo\n' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'wrote 8 bytes to a.txt' }], toolCallId: 'c1' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'three' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'wrote 5 bytes to b.txt' }], toolCallId: 'c2' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'both written' } },
  ])
  const answer = turns.find((turn) => turn.kind === 'assistant')
  assert.ok(answer !== undefined, 'the exchange has an answer to hang the panel on')
  assert.deepEqual(answer.files, [
    { path: 'a.txt', added: 2 },
    { path: 'b.txt', added: 1 },
  ])
  assert.equal(
    turns.find((turn) => turn.kind === 'user')?.files,
    undefined,
    'the person\'s message carries no panel',
  )
})

test('writes belong to their own exchange, and a read-only exchange carries no files', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'wrote 1 bytes to a.txt' }], toolCallId: 'c1' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'done' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'nothing to write' } },
  ])
  const answers = turns.filter((turn) => turn.kind === 'assistant')
  assert.equal(answers.length, 2, 'one answer per exchange')
  assert.deepEqual(answers[0]?.files, [{ path: 'a.txt', added: 1 }])
  assert.equal(answers[1]?.files, undefined, 'the next exchange does not inherit the previous one\'s files')
})

test('a file route answers with the sandbox and nosniff headers DSH puts on its own file route', () => {
  /**
   * DSH parity R-developer-twelve-16, measured 2026-10-29: a workspace SVG served inline by `/api/raw` and opened
   * directly ran its script with the session's access. DSH's file route sends exactly these on every answer.
   */
  assert.deepEqual(FILE_ANSWER_HEADERS, {
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
  })
})

test('a write that failed is not an edited file; one that succeeded in the same exchange is', () => {
  /**
   * DSH parity R-developer-twelve-11, measured 2026-10-29: with every `write_file` refused by the sandbox the panel
   * still named the files with their added lines, though the disk was unchanged. A call's arguments are what the
   * model asked for; only an `ok` result is a change.
   */
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'edit three files' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: '/w/refused.txt', content: 'one\ntwo\n' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: "error (SANDBOX): '/w/refused.txt' is outside the sandbox root /elsewhere" }], toolCallId: 'c1' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c2', name: 'bash', arguments: JSON.stringify({ command: "sed -i '' 's/a/b/' /w/shell.txt" }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'error (SANDBOX): [sandbox: file access denied under workspace-write mode]' }], toolCallId: 'c2' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c3', name: 'write_file', arguments: JSON.stringify({ path: '/w/kept.txt', content: 'x\n' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'wrote 2 bytes to /w/kept.txt' }], toolCallId: 'c3' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'one of three' } },
  ])
  const answer = turns.find((turn) => turn.kind === 'assistant')
  assert.deepEqual(answer?.files, [{ path: '/w/kept.txt', added: 1 }], 'only the write that succeeded is listed')
  assert.equal(turns.find((turn) => turn.name === 'write_file')?.state, 'error', 'the refused call itself still reads as an error')
})

test('an exchange whose every write failed carries no panel at all', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'edit' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: '/w/a.txt', content: 'x' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'error: permission denied' }], toolCallId: 'c1' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'could not write' } },
  ])
  assert.equal(turns.find((turn) => turn.kind === 'assistant')?.files, undefined, 'nothing changed, so no Edited files panel')
})

test('a write still waiting for its result is not yet an edited file', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'edit' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'writing now' } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: '/w/a.txt', content: 'x' }) } },
  ])
  assert.equal(turns.find((turn) => turn.kind === 'assistant')?.files, undefined, 'a running call has changed nothing yet')
})

test('a path written twice keeps the lines of its last successful write', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'edit' }] } },
    // Results without ids pair with the newest open call, as a provider that sends no ids requires.
    { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'write_file', arguments: JSON.stringify({ path: '/w/a.txt', content: 'one\ntwo\nthree\n' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'wrote 14 bytes to /w/a.txt' }] } },
    { type: 'assistant/chunk', chunk: { type: 'tool-call', name: 'write_file', arguments: JSON.stringify({ path: '/w/a.txt', content: 'one\n' }) } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'Error: disk full' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'the second write failed' } },
  ])
  assert.deepEqual(turns.find((turn) => turn.kind === 'assistant')?.files, [{ path: '/w/a.txt', added: 3 }], 'the failed second write does not overwrite the first')
})

test('a stylesheet is served inline as CSS, so an HTML preview can apply it; a page or a script is still a download', () => {
  /**
   * DSH parity R-developer-twelve-14, measured 2026-10-29: an HTML preview's `<link rel="stylesheet">` is rewritten
   * to `/api/raw`, which served the CSS as a download type, and a standards-mode document refuses such a stylesheet,
   * so the preview showed unstyled.
   */
  assert.equal(inlineContentType('/w/style.css'), 'text/css; charset=utf-8')
  assert.equal(inlineContentType('/w/THEME.CSS'), 'text/css; charset=utf-8', 'the extension is matched case-insensitively')
  for (const path of ['/w/page.html', '/w/app.js', '/w/README.md', '/w/data.json', '/w/LICENSE', '/w/x.xhtml']) {
    assert.equal(inlineContentType(path), null, `${path} is still a download`)
  }
})

test('a turn stopped by the round limit keeps its reason on the answer', () => {
  /**
   * The reason used to live only in the loop's local list, so a stopped turn reached the page as an empty answer
   * with no trace. The completed event carries it now, and the fold attaches it to the answer it stopped.
   */
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'do a big thing' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'partial answer' } },
    { type: 'assistant/completed', text: 'partial answer', rounds: 32, ended: ['stopped after the round limit of 32'] },
  ])
  const answer = turns.find((turn) => turn.kind === 'assistant')
  assert.ok(answer !== undefined, 'the stopped turn still produces an answer row')
  assert.deepEqual(answer.ended, ['stopped after the round limit of 32'])
})

test('a stopped turn with no text still produces a row carrying the reason', () => {
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'nothing printed' }] } },
    { type: 'assistant/completed', text: '', rounds: 32, ended: ['stopped after the round limit of 32'] },
  ])
  const answer = turns.find((turn) => turn.kind === 'assistant')
  assert.ok(answer !== undefined, 'a settled row exists for the notice')
  assert.deepEqual(answer.ended, ['stopped after the round limit of 32'])
  assert.equal(answer.text, '')
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

test('a turn\'s usage adds up across rounds, and stays absent where no provider reported it', () => {
  /**
   * The composer's token rate needs one number for the whole turn, and a turn with tools is several model
   * calls. A field a provider never sent must stay absent rather than become a zero that looks measured.
   */
  assert.equal(mergeUsage(undefined, undefined), undefined, 'nothing reported, nothing claimed')
  assert.deepEqual(mergeUsage(undefined, { inputTokens: 10, outputTokens: 4 }), { inputTokens: 10, outputTokens: 4 })
  assert.deepEqual(
    mergeUsage({ inputTokens: 10, outputTokens: 4 }, { inputTokens: 30, outputTokens: 6 }),
    { inputTokens: 40, outputTokens: 10 },
    'rounds add up',
  )
  assert.deepEqual(
    mergeUsage({ inputTokens: 10 }, { outputTokens: 6 }),
    { inputTokens: 10, outputTokens: 6 },
    'a field only one round reported is kept without inventing the other',
  )
})

test('the served page states which build it is, from its own bytes', () => {
  /**
   * **A stale build and a missing feature look the same on screen.** The live daemon once served a deployment checkout
   * an hour behind the source, and a row's geometry read as "not implemented" while the source and the checks were
   * correct. The marker is the page file's own hash, so a probe can compare the served document with the build it
   * expects instead of guessing from pixels.
   */
  const html = '<head>\n<meta name="heddle-page" content="unbuilt" />\n</head>'
  const expected = createHash('sha256').update(html).digest('hex').slice(0, 12)
  assert.match(markedPage(html), new RegExp(`<meta name="heddle-page" content="${expected}">`))
  /** A different document is a different build. */
  assert.notEqual(markedPage(html), markedPage(html.replace('unbuilt', 'other')))
  /** The page shipped here carries the placeholder the server replaces, not a stale hand-written name. */
  const pageFile = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
  assert.match(pageFile, /<meta name="heddle-page" content="unbuilt" \/>/)
  assert.ok(markedPage(pageFile).includes(`content="${createHash('sha256').update(pageFile).digest('hex').slice(0, 12)}"`))
})

test('a user turn folds its attachment blocks into transcript cards', () => {
  /**
   * The stored reference becomes a URL on the uploads route; everything a person sees — the name, the kind and
   * the byte size — is the metadata the server measured when the message was recorded, never re-derived here.
   * A message with only text has no `attachments` field at all, so the page keeps drawing a plain bubble.
   */
  const turns = transcriptTurns([
    {
      type: 'message',
      at: '2026-10-18T05:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at these' },
          { type: 'image', name: 'red.png', path: '/tmp/uploads/2026-10-18-red.png', mimeType: 'image/png', bytes: 132, sha256: 'ab'.repeat(32) },
          { type: 'file', name: 'notes.md', path: '/tmp/uploads/2026-10-18-notes.md', bytes: 12, sha256: 'cd'.repeat(32) },
        ],
      },
    },
    { type: 'message', at: '2026-10-18T05:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'plain' }] } },
  ])
  assert.deepEqual(turns[0]?.attachments, [
    { kind: 'image', name: 'red.png', mimeType: 'image/png', bytes: 132, url: '/api/uploads/2026-10-18-red.png' },
    { kind: 'file', name: 'notes.md', mimeType: 'application/octet-stream', bytes: 12, url: '/api/uploads/2026-10-18-notes.md' },
  ])
  assert.equal(turns[0]?.text, 'look at these', 'the bubble keeps only the text parts')
  assert.equal(turns[1]?.attachments, undefined, 'a text-only message carries no attachment field')
})

test('a stream artifact of blank lines between tokens is not prose', () => {
  /**
   * Measured 2026-10-18 in the owner's transcript: a build of the server streamed content as `'检测'`, `'\\n\\n\\n'`,
   * `'器'`, … so the answer rendered with a blank line between every word. A real paragraph break follows
   * sentence-ending punctuation or whitespace; blank lines wedged between ordinary characters are dropped while the
   * rest of the text is kept verbatim.
   */
  const turns = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '这' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '\n\n\n' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '正' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '\n\n\n' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '是' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '\n\n\n' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '**' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '抓到' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '了' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '。\n\n' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '下一段' } },
    { type: 'assistant/completed', text: '', finishReason: 'stop', rounds: 1 },
  ])
  const answer = turns.find((turn) => turn.kind === 'assistant')
  assert.ok(answer !== undefined)
  assert.equal(answer.text, '这正是**抓到了。\n\n下一段', 'the artifact separators are dropped, the prose is kept')
  /** A paragraph break after punctuation is prose, and stays. */
  const legit = transcriptTurns([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '第一段。' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '\n\n' } },
    { type: 'assistant/chunk', chunk: { type: 'text-delta', text: '第二段。' } },
  ])
  assert.equal(legit.find((turn) => turn.kind === 'assistant')?.text, '第一段。\n\n第二段。')
})
