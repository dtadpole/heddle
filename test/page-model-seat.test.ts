import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The model seat's records and the turns that follow them (#46), run as the page's own `recordSelection` and `runTurn`
 * with a scripted server: each `/model` record waits for the test to answer it, and the turn route refuses at once, so
 * `runTurn` ends right after the request it sends.
 *
 * The reviews of b8620d48 and 1ebfcbc9 (developer-ten, developer-twelve) named these:
 * - a refused or failed record left the seat showing a selection the session does not have;
 * - a late failure for session A, after a switch to B, rolled B's seat back to A's;
 * - two records in flight (a model, then an effort) let a turn sent between their answers overtake the second;
 * - a blank session's first turn dropped the seat, and a turn sent while a record was in flight overtook it.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
/** Functions an older page lacks, as that page behaved (its showSession published every view; its runTurn read the shown seat). */
const OPTIONAL = new Map([
  [
    'adoptViewSelection',
    `function adoptViewSelection(id, body) {
      applySessionModel(body.endpoint ?? null, body.model ?? null, body.reasoningEffort ?? null)
      if (typeof body.endpoint === 'string' && body.endpoint.length > 0) recordedSelections.add(id)
      else recordedSelections.delete(id)
    }`,
  ],
  ['selectionForSeat', 'function selectionForSeat() { return selectionForTurn() }'],
])
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0 && OPTIONAL.has(name)) return OPTIONAL.get(name) as string
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

type Reply = 'ok' | 'refuse' | 'throw'
interface Seat {
  endpoint: string | null
  model: string | null
  effort: string | null
}
interface Page {
  record(selection: { endpoint: string; model?: string; reasoningEffort?: string }): Promise<boolean>
  turn(text: string, key: string): Promise<void>
  /** Show another session, with the seat its view gives it. */
  show(id: string, seat: Seat): void
  /** The shown session changes (before its view arrives). */
  setCurrent(id: string): void
  setFolder(folder: string): void
  /** A view request is issued now: the choice count it carries. */
  viewAsk(): number
  /** A view arrives for a session, asked for at that count. */
  view(id: string, body: Record<string, unknown>, askedAt: number): void
  seat(): Seat
  recorded(id: string): boolean
  recordSession(id: string): void
  /** The /model records sent so far, in order, with the session each named. */
  records: { session: string; endpoint: string; model?: string; reasoningEffort?: string }[]
  sends: Record<string, unknown>[]
  notes: string[]
}

function harness(): { page: Page; answer: (reply: Reply) => void } {
  const waiting: ((reply: Reply) => void)[] = []
  const page = runInNewContext(
    `
    let chosenEndpoint = 'double-one', chosenModel = 'model-one', chosenEffort = null;
    let current = 'X';
    let modelPending = false;
    const recordedSelections = new Set();
    // State of the page this test runs against: both generations are declared, each uses its own.
    let selectionSave = null;
    const pendingSaves = new Set();
    let saveChain = Promise.resolve();
    let selectionSeq = 0;
    const latestSelection = new Map();
    const serverSeats = new Map();
    const heldSeats = new Map();
    let liveTurns = 0;
    const QUEUE_KEY_NONE = '';
    let activeFolder = null;
    const firstTreeReady = Promise.resolve(), workspaceRoutes = 'absent';
    function newConversationTarget() { return null }
    const modelTrigger = { setAttribute() {} };
    const modelSpinner = { hidden: true };
    const modelMenu = { hidden: true };
    const performance = { now: () => 0 };
    const records = [], sends = [], notes = [];
    function renderModelSeat() {}
    function renderModelPane() {}
    function placeModelMenu() {}
    function setNote(text) { if (text !== '') notes.push(text) }
    function updateStatusBar() {}
    function selectionForTurn() { return { endpoint: chosenEndpoint, ...(chosenModel !== null ? { model: chosenModel } : {}) } }
    async function sendTurn(body) { sends.push(body); return { ok: false, status: 400, text: async () => 'stop here' } }
    const fetch = (url, init) => {
      records.push({ session: decodeURIComponent(url.split('/')[3]), ...JSON.parse(init.body) });
      return new Promise((resolve, reject) => {
        queueAnswer((reply) => {
          if (reply === 'throw') reject(new Error('Failed to fetch'));
          else resolve({ ok: reply === 'ok', json: async () => (reply === 'ok' ? {} : { error: 'refused by the server' }) });
        });
      });
    };
    ${source('applySessionModel')}
    ${source('selectionForSeat')}
    ${source('adoptViewSelection')}
    ${source('recordSelection')}
    ${source('runTurn')}
    ({
      record: recordSelection,
      turn: (text, key) => runTurn(text, key).catch(() => {}),
      show(id, seat) {
        current = id;
        chosenEndpoint = seat.endpoint; chosenModel = seat.model; chosenEffort = seat.effort;
        serverSeats.set(id, seat);
        heldSeats.set(id, seat);
        recordedSelections.add(id);
      },
      setCurrent(id) { current = id },
      setFolder(folder) { activeFolder = folder },
      viewAsk: () => selectionSeq,
      view: (id, body, askedAt) => adoptViewSelection(id, body, askedAt),
      seat: () => ({ endpoint: chosenEndpoint, model: chosenModel, effort: chosenEffort }),
      recorded: (id) => recordedSelections.has(id),
      recordSession: (id) => recordedSelections.add(id),
      records, sends, notes,
    })
  `,
    { queueAnswer: (answer: (reply: Reply) => void) => waiting.push(answer) },
  ) as Page
  return {
    page,
    answer: (reply) => {
      const next = waiting.shift()
      assert.ok(next !== undefined, 'a record is in flight')
      next(reply)
    },
  }
}

const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
const plain = (seat: Seat) => ({ endpoint: seat.endpoint, model: seat.model, effort: seat.effort })

test('#46: a refused record puts the seat back and says why', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const recording = page.record({ endpoint: 'double-two', model: 'model-z' })
  await tick()
  answer('refuse')
  assert.equal(await recording, false)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-one', model: 'model-one', effort: null }, 'the seat shows what the session has')
  assert.deepEqual(Array.from(page.notes), ['refused by the server'], 'and the note says why')
  assert.equal(page.recorded('X'), false)
})

test('#46: a record that fails in transit puts the seat back too', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const recording = page.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'high' })
  await tick()
  answer('throw')
  assert.equal(await recording, false)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-one', model: 'model-one', effort: null })
  assert.match(page.notes.join(' '), /Failed to fetch/)
})

test('#46: an accepted record keeps the choice and marks the session as recorded', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const recording = page.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'high' })
  await tick()
  answer('ok')
  assert.equal(await recording, true)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-two', model: 'model-two', effort: 'high' })
  assert.equal(page.recorded('X'), true, 'so the next turn into it carries no model')
})

test('#46: a late failure for a session switched away from leaves the shown session’s seat alone', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const recording = page.record({ endpoint: 'double-two', model: 'model-two' })
  await tick()
  page.show('Y', { endpoint: 'double-three', model: 'model-three', effort: 'low' })
  answer('refuse')
  assert.equal(await recording, false)
  assert.equal(page.records[0]?.session, 'X', 'the record named the session it was chosen in')
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-three', model: 'model-three', effort: 'low' }, 'Y’s seat is untouched')
  assert.deepEqual(Array.from(page.notes), [], 'and Y shows no note about X')
})

test('#46: two records in flight reach the server in order, and a turn sent between their answers waits for both', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  page.recordSession('X')
  const model = page.record({ endpoint: 'double-two', model: 'model-two' })
  const effort = page.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'max' })
  await tick()
  assert.equal(page.records.length, 1, 'the second record waits for the first to be answered')
  answer('ok')
  await model
  await tick()
  assert.equal(page.records.length, 2, 'then it is sent')
  const turn = page.turn('sent between the answers', 'X')
  await tick()
  assert.equal(page.sends.length, 0, 'the turn waits for the second record')
  answer('ok')
  await effort
  await turn
  assert.equal(page.sends.length, 1, 'then it is sent')
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-two', model: 'model-two', effort: 'max' })
})

test('#46: when the newest record is refused after an older one was accepted, the seat shows the accepted one', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const model = page.record({ endpoint: 'double-two', model: 'model-two' })
  const effort = page.record({ endpoint: 'double-two', model: 'model-two', reasoningEffort: 'ghost' })
  await tick()
  answer('ok')
  await model
  await tick()
  answer('refuse')
  assert.equal(await effort, false)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-two', model: 'model-two', effort: null }, 'what the server holds, not the refused level')
})

test('#46: a message sent while the seat’s record is in flight waits for it', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  const recording = page.record({ endpoint: 'double-two', model: 'model-two' })
  const turn = page.turn('sent during the record', 'X')
  await tick()
  assert.equal(page.sends.length, 0, 'the turn is not sent before the record is answered')
  answer('ok')
  await recording
  await turn
  assert.equal(page.sends.length, 1, 'then it is sent')
  assert.equal(page.sends[0]?.endpoint, undefined, 'and, the session now recorded, it carries no model')
})

test('#46: a turn into a session with no recorded selection carries the seat; one with a record carries none', { timeout: 5000 }, async () => {
  const { page } = harness()
  page.setCurrent('BLANK')
  await page.turn('first in a blank session', 'BLANK')
  assert.equal(page.sends[0]?.endpoint, 'double-one', 'the blank session’s first turn carries the seat')
  assert.equal(page.sends[0]?.model, 'model-one')
  page.recordSession('RECORDED')
  await page.turn('into a recorded session', 'RECORDED')
  assert.equal(page.sends[1]?.endpoint, undefined, 'a recorded session runs on its own selection')
  await page.turn('a new conversation', '')
  assert.equal(page.sends[2]?.endpoint, 'double-one', 'a turn that creates its session carries the seat')
})

test('#46: a late view of a session switched away from, or one a newer choice overtook, does not move the seat', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  page.setCurrent('A')
  const askedA = page.viewAsk()
  page.setCurrent('B')
  page.view('B', { endpoint: 'double-three', model: 'model-three', reasoningEffort: 'low' }, page.viewAsk())
  page.view('A', { endpoint: 'double-two', model: 'model-two' }, askedA)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-three', model: 'model-three', effort: 'low' }, 'B’s seat stays B’s')
  assert.equal(page.recorded('A'), true, 'A’s record is still noted for A’s next turn')

  const asked = page.viewAsk()
  const recording = page.record({ endpoint: 'double-two', model: 'model-two' })
  page.view('B', { endpoint: 'double-three', model: 'model-three', reasoningEffort: 'low' }, asked)
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-two', model: 'model-two', effort: null }, 'a view asked before the choice does not undo it')
  await tick()
  answer('ok')
  await recording
})

test('#46: a blank session’s turn, after its record was refused and another session was shown, carries its own seat and folder', { timeout: 5000 }, async () => {
  const { page, answer } = harness()
  page.setFolder('/work/A')
  page.setCurrent('A')
  page.view('A', {}, page.viewAsk())
  const recording = page.record({ endpoint: 'double-two', model: 'model-z' })
  const turn = page.turn('first in blank A', 'A')
  await tick()
  page.setFolder('/work/B')
  page.setCurrent('B')
  page.view('B', { endpoint: 'double-three', model: 'model-three' }, page.viewAsk())
  answer('refuse')
  await recording
  await turn
  assert.equal(page.sends.length, 1)
  assert.equal(page.sends[0]?.endpoint, 'double-one', 'A’s turn carries A’s seat as its refusal restored it, not B’s')
  assert.equal(page.sends[0]?.model, 'model-one')
  assert.equal(page.sends[0]?.folder, '/work/A', 'and the folder it was sent from')
  assert.deepEqual(plain(page.seat()), { endpoint: 'double-three', model: 'model-three', effort: null }, 'B’s seat is untouched')
})
