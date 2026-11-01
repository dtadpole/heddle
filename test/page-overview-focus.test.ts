import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21), developer-ten's zoom N7: a focus window is a stretch of the strip's domain, which is the
 * timeline's clock only in the actual mode; in the default equal mode it is record slots. The page's fenced helper is
 * sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* overview-focus:begin */')
const end = page.indexOf('/* overview-focus:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences overview-focus')
type Item = { x0: number; x1: number; start: number; last?: number }
const { focusWindowTime } = new Function(`${page.slice(begin, end)}; return { focusWindowTime }`)() as {
  focusWindowTime: (from: number, to: number, items: Item[], durationActual: boolean, startsAtMs: number, totalMs: number) => { from: number; to: number } | null
}

const startsAt = Date.parse('2026-10-31T12:00:00.000Z')
/**
 * Three turns of two records each over 10 s: the first two close together, then a long pause before the third. In the
 * equal mode each record takes a slot of 1/6 (drawn 0.9 of it wide).
 */
const times = [0, 100, 300, 400, 9_000, 9_500]
const slots: Item[] = times.map((at, index) => ({ x0: index / 6, x1: (index + 0.9) / 6, start: at / 10_000 }))

test('in the equal mode a window lights the records whose slots it touches, by their recorded starts', () => {
  const window = focusWindowTime(2 / 6 + 0.01, 4 / 6 - 0.01, slots, false, startsAt, 10_000)
  assert.ok(window !== null)
  const lit = times.filter((at) => startsAt + at >= window.from && startsAt + at <= window.to)
  assert.deepEqual(lit, [300, 400], 'the middle turn, the third and fourth slots')
  assert.ok(startsAt + 400 >= window.from && startsAt + 9_000 > window.to, 'not the third turn, which the time reading (33% to 67% of 10 s) would have taken whole')
})

test('a window that touches no slot lights nothing, and one over every slot lights every record', () => {
  const gap = focusWindowTime(0.9 / 6 + 0.001, 1 / 6 - 0.001, slots, false, startsAt, 10_000)
  assert.ok(gap !== null)
  assert.ok(times.every((at) => startsAt + at < gap.from || startsAt + at > gap.to), 'the gap between two slots')
  const all = focusWindowTime(0, 1, slots, false, startsAt, 10_000)
  assert.ok(all !== null && times.every((at) => startsAt + at >= all.from && startsAt + at <= all.to))
})

test("a turn's tick (an older server's per-turn strip) lights to the turn's end, not only its first start", () => {
  const turns: Item[] = [{ x0: 0, x1: 0.45, start: 0, last: 0.04 }, { x0: 0.5, x1: 0.95, start: 0.9, last: 0.95 }]
  const window = focusWindowTime(0.1, 0.3, turns, false, startsAt, 10_000)
  assert.ok(window !== null)
  assert.ok(startsAt + 400 <= window.to && startsAt + 9_000 > window.to, "the first turn's records up to its end, none of the second's")
})

test('in the actual mode the window is the timeline clock, which runs to the latest end', () => {
  const window = focusWindowTime(0.5, 1, slots, true, startsAt, 10_000)
  assert.deepEqual(window, { from: startsAt + 5_000, to: startsAt + 10_000 })
})

test('with no clock there is nothing to judge rows by', () => {
  assert.equal(focusWindowTime(0, 1, slots, false, Number.NaN, 10_000), null)
  assert.equal(focusWindowTime(0, 1, slots, true, startsAt, 0), null)
})
