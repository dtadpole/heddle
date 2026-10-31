import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * Parity S151 (R-developer-eleven-21): an overview tick's hover details, as DSH's overview shows them after 500 ms:
 * its turn and kinds, then the clock it started at and how long it lasted, with no invented duration for a running
 * span. The page's fenced helper is sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')

type Span = { turn: number; start: number; end: number; kinds?: string[]; running?: boolean }
function extract(): (span: Span, totalMs: number, startsAtMs: number) => { label: string; when: string } {
  const begin = page.indexOf('/* timeline-tip:begin */')
  const end = page.indexOf('/* timeline-tip:end */')
  assert.ok(begin !== -1 && end > begin, 'page.html fences timelineTickText with its markers')
  return new Function(`${page.slice(begin, end)}; return timelineTickText`)() as (span: Span, totalMs: number, startsAtMs: number) => { label: string; when: string }
}

function clockOf(ms: number): string {
  const at = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

const startsAt = Date.parse('2026-10-31T06:00:00.000Z')

test('a finished span names its turn and kinds, then the clock it started at and how long it lasted', () => {
  const text = extract()({ turn: 2, start: 0.1, end: 0.25, kinds: ['assistant', 'tool'] }, 10_000, startsAt)
  assert.equal(text.label, 'turn 2 · assistant, tool')
  assert.equal(text.when, `${clockOf(startsAt + 1000)} · 1.50 s`)
})

test('a running span shows where it started and that it is running, with no invented duration', () => {
  const text = extract()({ turn: 3, start: 0.5, end: 0.5, kinds: ['model'], running: true }, 8000, startsAt)
  assert.equal(text.when, `${clockOf(startsAt + 4000)} · running`)
})

test('without a known start the duration still reads, and short and long spans read in ms and minutes', () => {
  const tick = extract()
  assert.equal(tick({ turn: 1, start: 0, end: 0.25 }, 1000, Number.NaN).when, '250 ms')
  assert.equal(tick({ turn: 1, start: 0, end: 1 }, 90_000, Number.NaN).when, '1m 30s')
  assert.equal(tick({ turn: 1, start: 0, end: 1 }, 1000, Number.NaN).label, 'turn 1 · records')
})
