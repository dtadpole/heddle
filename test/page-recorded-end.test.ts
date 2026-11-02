import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Unit tests for the reasons a page draws from a turn's recorded end (#201). Every page attached to a session gets the
 * turn's `assistant/completed` on the event stream, so the page draws the turn's early-end notice from it, whoever sent
 * the turn. A failed turn is drawn by its failure row and is left out here. The function is read out of page.html between
 * its markers, so the page and this test judge one source.
 */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* recorded-end:begin */')
const end = page.indexOf('/* recorded-end:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences recordedEnd with its markers')
const recordedEnd = new Function(`${page.slice(begin, end)}\nreturn recordedEnd`)() as (event: unknown) => string[] | null

test('a stopped turn and a turn cut by the round limit give their recorded reasons', () => {
  assert.deepEqual(recordedEnd({ type: 'assistant/completed', text: '', finishReason: 'aborted', ended: ['stopped by the caller'] }), ['stopped by the caller'])
  assert.deepEqual(
    recordedEnd({ type: 'assistant/completed', text: 'a', ended: ['stopped by the caller', 'stopped after the round limit of 32'] }),
    ['stopped by the caller', 'stopped after the round limit of 32'],
  )
})

test('a turn that ended on its own gives none', () => {
  assert.equal(recordedEnd({ type: 'assistant/completed', text: 'the answer', finishReason: 'stop', rounds: 1 }), null)
  assert.equal(recordedEnd({ type: 'assistant/completed', text: 'the answer', ended: [] }), null, 'an empty list is no reason')
  assert.equal(recordedEnd({ type: 'assistant/completed', ended: ['', 7] }), null, 'nor are blank or non-text reasons')
})

test('a failed turn gives none, since its failure row says it', () => {
  assert.equal(recordedEnd({ type: 'assistant/completed', finishReason: 'error', ended: ['failed: provider down'], error: 'provider down' }), null)
})

test('only a completed answer is read', () => {
  assert.equal(recordedEnd({ type: 'turn/completed', stopped: true, ended: ['stopped by the caller'] }), null)
  assert.equal(recordedEnd(null), null)
  assert.equal(recordedEnd('assistant/completed'), null)
})
