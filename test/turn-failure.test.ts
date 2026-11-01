import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { transcriptTurns } from '../src/server/web.ts'

/** The page's rule for drawing a failed turn once (R-developer-six-2), read out of the page the browser runs. */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* turn-failure:begin */')
const end = page.indexOf('/* turn-failure:end */')

interface Rule {
  WINDOW_MS: number
  isRepeat: (last: { session: string; message: string; at: number } | null, session: string, message: string, now: number) => boolean
  text: (message: unknown) => string
  shows: (event: unknown) => boolean
}

const rule = new Function(`${page.slice(begin, end)}\nreturn TurnFailure`)() as Rule

test('the page carries the rule between its markers', () => {
  assert.ok(begin > 0 && end > begin)
})

test('the same failure arriving twice — the turn\'s own error and the recorded turn/failed — is drawn once', () => {
  const first = { session: 's1', message: 'upstream answered 502', at: 1000 }
  assert.equal(rule.isRepeat(first, 's1', 'upstream answered 502', 1200), true)
  assert.equal(rule.isRepeat(null, 's1', 'upstream answered 502', 1200), false, 'the first arrival is drawn')
})

test('a different session, a different message, or a later failure is a new one', () => {
  const first = { session: 's1', message: 'upstream answered 502', at: 1000 }
  assert.equal(rule.isRepeat(first, 's2', 'upstream answered 502', 1200), false)
  assert.equal(rule.isRepeat(first, 's1', 'timed out', 1200), false)
  assert.equal(rule.isRepeat(first, 's1', 'upstream answered 502', 1000 + rule.WINDOW_MS), false)
})

test('a failure without a message still says the turn failed', () => {
  assert.equal(rule.text(''), 'the turn failed')
  assert.equal(rule.text(undefined), 'the turn failed')
  assert.equal(rule.text('upstream answered 502'), 'upstream answered 502')
})

test('a failed turn is the answer\'s stop reason, so a reload says what the live page said', () => {
  const at = '2026-10-29T00:00:00.000Z'
  const turns = transcriptTurns([
    { seq: 0, at, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { seq: 1, at, type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'partial' } },
    { seq: 2, at, type: 'turn/failed', message: 'upstream answered 502' },
  ] as never)
  const last = turns.at(-1)
  assert.equal(last?.kind, 'assistant')
  assert.deepEqual(last?.ended, ['the turn failed: upstream answered 502'])
  const alone = transcriptTurns([{ seq: 0, at, type: 'turn/failed', message: '' }] as never)
  assert.equal(alone.length, 1, 'a failure with no answer gets a row of its own')
  assert.deepEqual(alone[0]?.ended, ['the turn failed: unknown error'])
})

test('a turn the archived-session gate blocked is no failure: nothing is drawn live or on a reload (#139)', () => {
  /**
   * The gate ends the turn `turn/failed { reason: { kind: 'blocked' } }` with no message (DSH's blocked end,
   * dsh-agent-loop lib/index.js:960-962). Measured on both builds (developer-four): a reload drew "The turn failed:
   * unknown error" under the previous, finished answer, and the live stream drew "the turn failed". DSH's chat shows a
   * failure only for an error, a sign-out abort or an interrupted end (endFailure, dsh-client-ui-chat
   * lib/client.js:10475-10487).
   */
  assert.equal(rule.shows({ type: 'turn/failed', reason: { kind: 'blocked' } }), false, 'the live stream draws nothing for it')
  assert.equal(rule.shows({ type: 'turn/failed', message: 'upstream answered 502' }), true, 'a real failure is still drawn')
  assert.equal(rule.shows({ type: 'turn/failed' }), true, 'and so is one without a message')
  const at = '2026-10-31T00:00:00.000Z'
  const answered = [
    { seq: 0, at, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'code word?' }] } },
    { seq: 1, at, type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'HERON-58' } },
    { seq: 2, at, type: 'assistant/completed', text: 'HERON-58', finishReason: 'stop', rounds: 1 },
    { seq: 3, at, type: 'turn/completed' },
  ]
  const blocked = transcriptTurns([...answered, { seq: 4, at, type: 'turn/failed', reason: { kind: 'blocked' } }] as never)
  assert.deepEqual(blocked, transcriptTurns(answered as never), 'a reload shows the session as if the blocked turn left no row')
  assert.equal(blocked.at(-1)?.ended, undefined, 'and the previous answer carries no failure')
  assert.deepEqual(transcriptTurns([{ seq: 0, at, type: 'turn/failed', reason: { kind: 'blocked' } }] as never), [], 'a blocked turn alone draws nothing')
})
