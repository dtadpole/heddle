import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * Live-testing draft developer-eleven-1: events the stream delivers while a session's history is being read wait, and
 * only those past the answer's `seq` are drawn, so an event in both reads once. The page's fenced helper is sliced out
 * and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')

function extract(): (kept: readonly unknown[], upTo: number | null) => readonly unknown[] {
  const begin = page.indexOf('/* kept-events:begin */')
  const end = page.indexOf('/* kept-events:end */')
  assert.ok(begin !== -1 && end > begin, 'page.html fences keptToDraw with its markers')
  return new Function(`${page.slice(begin, end)}; return keptToDraw`)() as (kept: readonly unknown[], upTo: number | null) => readonly unknown[]
}

const at = (seq: number | undefined, type = 'assistant/chunk') => ({ session: 's', event: seq === undefined ? { type } : { seq, type } })

test('the events the history already holds are dropped, and the later ones drawn in order', () => {
  const keptToDraw = extract()
  const kept = [at(4), at(5), at(6), at(7)]
  assert.deepEqual(keptToDraw(kept, 5), [at(6), at(7)])
})

test('an answer that reaches past every kept event leaves nothing to draw', () => {
  const keptToDraw = extract()
  assert.deepEqual(keptToDraw([at(1), at(2)], 9), [])
})

test('a live-only fragment without a seq is dropped once the history said how far it reaches', () => {
  const keptToDraw = extract()
  assert.deepEqual(keptToDraw([at(undefined, 'assistant/chunk'), at(8)], 7), [at(8)])
})

test('without an answer to measure against, every kept event is drawn, as the stream would have', () => {
  const keptToDraw = extract()
  const kept = [at(1), at(undefined), at(3)]
  assert.deepEqual(keptToDraw(kept, null), kept)
})
