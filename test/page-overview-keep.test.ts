import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21), developer-ten's note on the overview's keys: a live refetch draws the strip again, and its
 * zoom and focus window keep their records, as DSH keeps its viewport and range in the domain's own units. The page's
 * fenced helpers are sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* overview-keep:begin */')
const end = page.indexOf('/* overview-keep:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences overview-keep')
type Stretch = { from: number; to: number }
const { overviewDomainSize, rescaleStretch } = new Function(`${page.slice(begin, end)}; return { overviewDomainSize, rescaleStretch }`)() as {
  overviewDomainSize: (durationActual: boolean, totalMs: number, records: number, spans: number) => number
  rescaleStretch: (stretch: Stretch | null, scale: number) => Stretch | null
}

const close = (actual: Stretch | null, expected: Stretch) => {
  assert.ok(actual !== null, 'a stretch')
  assert.ok(Math.abs(actual.from - expected.from) < 1e-9 && Math.abs(actual.to - expected.to) < 1e-9, `${JSON.stringify(actual)} is ${JSON.stringify(expected)}`)
}

test('the domain is recorded milliseconds in the actual mode and record slots in the equal mode, turn slots without records', () => {
  assert.equal(overviewDomainSize(true, 12_000, 8, 3), 12_000)
  assert.equal(overviewDomainSize(true, 0, 8, 3), 0, 'no clock, nothing to rescale by')
  assert.equal(overviewDomainSize(false, 12_000, 8, 3), 8)
  assert.equal(overviewDomainSize(false, 12_000, 0, 3), 3, "an older server's ticks, one slot per turn")
})

test('a stretch over the third and fourth of 10 slots is the same slots once 2 more are added', () => {
  const kept = rescaleStretch({ from: 0.2, to: 0.4 }, 10 / 12)
  close(kept, { from: 2 / 12, to: 4 / 12 })
  /** Slot i is drawn over [i, i + 0.9] of the domain's units, whatever their number. */
  assert.ok(kept !== null && Math.abs(kept.from * 12 - 2) < 1e-9 && Math.abs(kept.to * 12 - 4) < 1e-9)
})

test('a stretch of recorded time keeps its milliseconds as a running turn lengthens the domain', () => {
  close(rescaleStretch({ from: 0.5, to: 0.75 }, 8_000 / 10_000), { from: 0.4, to: 0.6 })
})

test('a domain that shrank keeps the stretch inside it at its width, and no stretch stays none', () => {
  close(rescaleStretch({ from: 0.6, to: 0.9 }, 1.5), { from: 0.55, to: 1 })
  close(rescaleStretch({ from: 0.2, to: 0.9 }, 2), { from: 0, to: 1 })
  assert.equal(rescaleStretch(null, 0.5), null)
  const same = { from: 0.1, to: 0.3 }
  assert.equal(rescaleStretch(same, 1), same, 'an unchanged domain keeps the very stretch')
  assert.equal(rescaleStretch(same, Number.NaN), same, 'and so does an unknown one')
})
