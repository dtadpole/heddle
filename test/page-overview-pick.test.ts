import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21), developer-ten's N8: a pick on the overview reaches a record's row, as a click on DSH's
 * span selects its record; an empty-track click centres DSH's narrowest window and finds the nearest record. The
 * page's fenced helpers are sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* overview-pick:begin */')
const end = page.indexOf('/* overview-pick:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences overview-pick')
type Row = { turn: number; kind: string; loose?: boolean; record?: { startedAt?: string } }
const { laneOfKind, overviewRecordRow, centredWindow, nearestItem } = new Function(`${page.slice(begin, end)}; return { laneOfKind, overviewRecordRow, centredWindow, nearestItem }`)() as {
  laneOfKind: (kind: string) => string
  overviewRecordRow: (rows: Row[], turn: number, lane: string, rank: number) => number
  centredWindow: (center: number, width: number) => { from: number; to: number }
  nearestItem: (items: { x0: number; x1: number }[], x: number) => number
}

const at = (ms: number) => new Date(Date.parse('2026-10-31T12:00:00.000Z') + ms).toISOString()
const row = (turn: number, kind: string, ms?: number, extra: Partial<Row> = {}): Row => ({ turn, kind, record: ms === undefined ? {} : { startedAt: at(ms) }, ...extra })

test('a record finds its row by its turn, its lane and its rank there, as both projections list them', () => {
  const rows = [
    row(0, 'system', 0, { loose: true }),
    row(1, 'user', 10),
    row(1, 'assistant', 20),
    row(1, 'tool', 30),
    row(1, 'tool', 30),
    row(1, 'reasoning', 25),
    row(1, 'assistant', 40),
    row(2, 'user', 50),
    row(2, 'context'),
    row(2, 'tool', 60),
  ]
  assert.equal(overviewRecordRow(rows, 1, 'input', 0), 1, 'the user record')
  assert.equal(overviewRecordRow(rows, 1, 'tools', 0), 3, 'two calls that started together keep their ledger order')
  assert.equal(overviewRecordRow(rows, 1, 'tools', 1), 4)
  assert.deepEqual([0, 1, 2].map((rank) => overviewRecordRow(rows, 1, 'model', rank)), [2, 5, 6], 'the model lane in time order: the reasoning before the last answer')
  assert.equal(overviewRecordRow(rows, 2, 'input', 1), -1, 'a record with no start is on no timeline')
  assert.equal(overviewRecordRow(rows, 0, 'input', 0), -1, 'nor is a row outside every turn')
  assert.equal(overviewRecordRow(rows, 2, 'tools', 0), 9)
})

test('a kind is in the lane the projections put it in', () => {
  assert.deepEqual(['user', 'context', 'system', 'tool', 'assistant', 'reasoning', 'compaction'].map(laneOfKind), ['input', 'input', 'input', 'tools', 'model', 'model', 'model'])
})

test("DSH's narrowest window is centred where it is asked for and kept inside the domain", () => {
  const close = (actual: { from: number; to: number }, from: number, to: number) => assert.ok(Math.abs(actual.from - from) < 1e-9 && Math.abs(actual.to - to) < 1e-9, JSON.stringify(actual))
  close(centredWindow(0.5, 0.1), 0.45, 0.55)
  close(centredWindow(0.02, 0.1), 0, 0.1)
  close(centredWindow(0.99, 0.1), 0.9, 1)
  close(centredWindow(0.3, 2), 0, 1)
})

test('the nearest item to a point is the one it is on, else the one whose edge is nearest; the first wins a tie', () => {
  const items = [{ x0: 0.1, x1: 0.2 }, { x0: 0.3, x1: 0.3 }, { x0: 0.5, x1: 0.7 }]
  assert.equal(nearestItem(items, 0.15), 0)
  assert.equal(nearestItem(items, 0.26), 1)
  assert.equal(nearestItem(items, 0.42), 2)
  assert.equal(nearestItem(items, 0.25), 0, 'equally far from the first and the second')
  assert.equal(nearestItem([], 0.5), -1)
})
