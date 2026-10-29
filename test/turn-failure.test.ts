import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/** The page's rule for drawing a failed turn once (R-developer-six-2), read out of the page the browser runs. */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* turn-failure:begin */')
const end = page.indexOf('/* turn-failure:end */')

interface Rule {
  WINDOW_MS: number
  isRepeat: (last: { session: string; message: string; at: number } | null, session: string, message: string, now: number) => boolean
  text: (message: unknown) => string
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
