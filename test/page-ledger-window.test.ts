import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21), DSH's Virtual rows: a long ledger opens at the tail with 50 records, and a first-row
 * control draws one earlier page. The page's fenced window helpers are judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* ledger-window:begin */')
const end = page.indexOf('/* ledger-window:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences ledger-window')
type Row = { turnStart?: boolean }
const helpers = new Function(`${page.slice(begin, end)}; return { LEDGER_WINDOW, sectionHeadAt, tailWindowStart, earlierWindowStart }`)() as {
  LEDGER_WINDOW: number
  sectionHeadAt: (rows: Row[], index: number) => number
  tailWindowStart: (rows: Row[], size: number) => number
  earlierWindowStart: (rows: Row[], start: number, size: number) => number
}

/** Turns of the given sizes, each a head row then plain rows. */
const turns = (...sizes: number[]): Row[] => sizes.flatMap((size) => Array.from({ length: size }, (_, at) => (at === 0 ? { turnStart: true } : {})))

test("DSH's window is 50 records", () => {
  assert.equal(helpers.LEDGER_WINDOW, 50)
})

test('a short ledger opens whole, and a long one at its last rows snapped back to their section head', () => {
  assert.equal(helpers.tailWindowStart(turns(10, 10), 50), 0, 'a ledger of 50 rows or fewer opens whole')
  const rows = turns(30, 30, 30) // heads at 0, 30, 60; 90 rows
  assert.equal(helpers.tailWindowStart(rows, 50), 30, 'the last 50 start at row 40, inside the turn that starts at 30')
  assert.equal(helpers.sectionHeadAt(rows, 40), 30)
})

test('a section longer than the window opens inside it, rather than drawing the whole section', () => {
  const rows = turns(300) // one turn of 300 rows
  assert.equal(helpers.tailWindowStart(rows, 50), 250, 'snapping back would add 250 rows, more than a window, so it starts at 250')
})

test('one "Load earlier" draws the previous page, snapped the same way, and stops at the first row', () => {
  const rows = turns(30, 30, 30, 30) // heads at 0, 30, 60, 90; 120 rows
  const first = helpers.tailWindowStart(rows, 50)
  assert.equal(first, 60)
  assert.equal(helpers.earlierWindowStart(rows, first, 50), 0, '50 before 60 is 10, inside the first turn, whose head is 0')
  assert.equal(helpers.earlierWindowStart(rows, 0, 50), 0, 'nothing is before the first row')
  const long = turns(300)
  assert.equal(helpers.earlierWindowStart(long, 250, 50), 200, 'inside a long section a page is 50 rows')
})
