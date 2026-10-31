import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * When the page reads the tree's baselines again after a cut (#91), judged out of the page that runs it.
 *
 * DSH re-acquires the Workspace and Session baselines on every new connection, after the stream's `ready` item
 * (dsh-client-connection lib/client.browser.js:1094-1100), and a browser `offline` then `online` reconnects at the 500 ms
 * tier (:989-999, :1359-1376). The page follows its stream with an `EventSource`, so the decision of when to read again
 * — not on the load's own `ready`, at once on a later one, 500 ms after an `online` that followed an `offline` — lives in
 * `page.html` between two markers and is loaded here.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* stream-baseline:begin */')
const end = page.indexOf('/* stream-baseline:end */')

interface FollowState {
  generations: number
  offline: boolean
}
interface Step {
  state: FollowState
  reread: number | null
}
interface StreamBaseline {
  ONLINE_DELAY_MS: number
  initial: () => FollowState
  next: (state: FollowState, signal: string) => Step
}

function load(): StreamBaseline {
  assert.ok(begin !== -1 && end > begin, 'the page carries the stream-baseline block between its markers')
  return new Function(`${page.slice(begin, end)}\nreturn StreamBaseline`)() as StreamBaseline
}

/** Feed signals in order; answer each step's `reread`. */
function run(baseline: StreamBaseline, signals: string[]): (number | null)[] {
  let state = baseline.initial()
  return signals.map((signal) => {
    const step = baseline.next(state, signal)
    state = step.state
    return step.reread
  })
}

test("the load's own ready reads nothing more: the boot draws the tree itself", () => {
  const baseline = load()
  assert.deepEqual(baseline.initial(), { generations: 0, offline: false })
  assert.deepEqual(run(baseline, ['ready']), [null])
})

test('every later ready is a reconnect and reads the baselines again at once, as onConnected does', () => {
  const baseline = load()
  assert.deepEqual(run(baseline, ['ready', 'ready', 'ready']), [null, 0, 0])
})

test("offline reads nothing; the online after it reads again after DSH's 500 ms first tier", () => {
  const baseline = load()
  assert.equal(baseline.ONLINE_DELAY_MS, 500)
  assert.deepEqual(run(baseline, ['ready', 'offline', 'online']), [null, null, 500])
})

test('an online with no offline before it reads nothing, and a second online reads nothing more', () => {
  const baseline = load()
  assert.deepEqual(run(baseline, ['ready', 'online']), [null, null])
  assert.deepEqual(run(baseline, ['ready', 'offline', 'online', 'online']), [null, null, 500, null])
})

test('a cut the stream also saw reads on online and again on its ready, and before the first ready the online still reads', () => {
  const baseline = load()
  assert.deepEqual(run(baseline, ['ready', 'offline', 'online', 'ready']), [null, null, 500, 0])
  assert.deepEqual(run(baseline, ['offline', 'online', 'ready', 'ready']), [null, 500, null, 0])
})

test('an unknown signal changes nothing', () => {
  const baseline = load()
  const state = { generations: 2, offline: true }
  assert.deepEqual(baseline.next(state, 'error'), { state, reread: null })
})

test('the page wires the block to its stream and to the browser network events', () => {
  for (const wiring of [
    "events.addEventListener('ready', () => followConnection('ready'))",
    "window.addEventListener('offline', () => followConnection('offline'))",
    "window.addEventListener('online', () => followConnection('online'))",
  ]) {
    assert.ok(page.includes(wiring), `the page carries ${wiring}`)
  }
})
