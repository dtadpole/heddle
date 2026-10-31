import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The model seat's record (#46), run as the page's own `recordSelection` with a scripted server.
 *
 * developer-ten's review of b8620d48, S1: once a turn into a session stopped carrying the seat, a refused or failed
 * record left the seat showing a selection the session does not have, and the next message ran on the old one.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

interface Seat {
  record(selection: { endpoint: string; model?: string; reasoningEffort?: string }): Promise<boolean>
  seat(): { endpoint: string | null; model: string | null; effort: string | null }
  recorded(id: string): boolean
  notes: string[]
}

function harness(answer: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>): Seat {
  const notes: string[] = []
  return runInNewContext(
    `
    let chosenEndpoint = 'double-one', chosenModel = 'model-one', chosenEffort = null;
    let current = 'X';
    let modelPending = false;
    const recordedSelections = new Set();
    let selectionSave = null;
    const modelTrigger = { setAttribute() {} };
    const modelSpinner = { hidden: true };
    const modelMenu = { hidden: true };
    function renderModelSeat() {}
    function renderModelPane() {}
    function placeModelMenu() {}
    function setNote(text) { if (text !== '') notes.push(text) }
    const fetch = () => answer();
    ${source('recordSelection')}
    ({
      record: recordSelection,
      seat: () => ({ endpoint: chosenEndpoint, model: chosenModel, effort: chosenEffort }),
      recorded: (id) => recordedSelections.has(id),
      notes,
    })
  `,
    { answer, notes },
  ) as Seat
}

test('#46: a refused record puts the seat back and says why', { timeout: 5000 }, async () => {
  const seat = harness(async () => ({ ok: false, json: async () => ({ error: 'no model model-z on double-two' }) }))
  assert.equal(await seat.record({ endpoint: 'double-two', model: 'model-z' }), false)
  assert.deepEqual({ ...seat.seat() }, { endpoint: 'double-one', model: 'model-one', effort: null }, 'the seat shows what the session has')
  assert.deepEqual(Array.from(seat.notes), ['no model model-z on double-two'], 'and the note says why')
  assert.equal(seat.recorded('X'), false)
})

test('#46: a record that fails in transit puts the seat back too', { timeout: 5000 }, async () => {
  const seat = harness(async () => {
    throw new Error('Failed to fetch')
  })
  assert.equal(await seat.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'high' }), false)
  assert.deepEqual({ ...seat.seat() }, { endpoint: 'double-one', model: 'model-one', effort: null })
  assert.match(seat.notes.join(' '), /Failed to fetch/)
})

test('#46: an accepted record keeps the choice and marks the session as recorded', { timeout: 5000 }, async () => {
  const seat = harness(async () => ({ ok: true, json: async () => ({}) }))
  assert.equal(await seat.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'high' }), true)
  assert.deepEqual({ ...seat.seat() }, { endpoint: 'double-two', model: 'model-two', effort: 'high' })
  assert.equal(seat.recorded('X'), true, 'so the next turn into it carries no model')
})
