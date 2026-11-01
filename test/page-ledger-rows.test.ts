import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { projectLedger, projectRows, type LedgerEvent } from '../src/server/ledger.ts'

/**
 * S151 (R-developer-eleven-21): a record outside every turn is drawn where it happened, in DSH's Between turns section,
 * and the turn fold leaves such a section open. The page's fenced helpers are sliced out and judged against the shared
 * fixture the two projections are judged on.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* ledger-rows:begin */')
const end = page.indexOf('/* ledger-rows:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences ledger-rows')
type Row = { turn: number; step?: number; loose: boolean; turnStart: boolean; stepStart: boolean; record: { label: string; afterTurn?: number } }
const helpers = new Function(`${page.slice(begin, end)}; return { rowsOf, sectionLabel, rowFolded }`)() as {
  rowsOf: (data: unknown) => Row[]
  sectionLabel: (row: Partial<Row>) => string
  rowFolded: (row: Partial<Row>, collapsedTurns: boolean, expanded: Set<number>) => boolean
}

const fixture = new URL('../rust/crates/heddle-web-trajectory/tests/fixtures/', import.meta.url)
const ledger = projectLedger(
  readFileSync(new URL('between-turns.jsonl', fixture), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEvent),
)
const placement = (rows: readonly Row[]) => rows.map((row) => [row.turn, row.step, row.loose, row.turnStart, row.stepStart, row.record.label, row.record.afterTurn])

test("a server that sends no rows still gets the projection's placement, Between turns sections included", () => {
  assert.deepEqual(placement(helpers.rowsOf({ ledger })), placement(projectRows(ledger) as readonly Row[]))
  assert.deepEqual(placement(helpers.rowsOf(ledger)), placement(projectRows(ledger) as readonly Row[]), 'a bare ledger too')
})

test('a section head says Between turns, as DSH does, and a turn head says its turn', () => {
  assert.equal(helpers.sectionLabel({ loose: true, turn: 0 }), 'Between turns')
  assert.equal(helpers.sectionLabel({ loose: false, turn: 3 }), 'Turn 3')
})

test('the turn fold hides only a turn’s later rows, never a Between turns section', () => {
  const rows = helpers.rowsOf({ ledger })
  const shown = rows.filter((row) => !helpers.rowFolded(row, true, new Set()))
  assert.deepEqual(
    shown.map((row) => [row.turn, row.record.label]),
    [
      [0, 'command/run'],
      [0, 'command/done'],
      [1, 'user'],
      [0, 'command/run'],
      [0, 'compaction/start'],
      [0, 'compaction/failed'],
      [0, 'command/done'],
      [2, 'user'],
      [0, 'command/run'],
      [0, 'command/done'],
    ],
    'each turn folds to its head; the sections stay whole',
  )
  assert.equal(rows.filter((row) => !helpers.rowFolded(row, true, new Set([1]))).length, shown.length + 1, 'an expanded turn shows its rows again')
  assert.equal(rows.filter((row) => !helpers.rowFolded(row, false, new Set())).length, rows.length, 'and with the fold off nothing hides')
})
