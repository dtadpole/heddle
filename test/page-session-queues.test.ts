import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) return ''
  const end = page.indexOf('\n}', start)
  assert.ok(end > start, name)
  return page.slice(start, end + 2)
}
function harness() {
  const pending: Array<() => void> = []
  const calls: Array<{ text: string; key: string }> = []
  const context = {
    calls, pending,
    runTurn: async (text: string, key: string, _attachments: unknown, accepted?: () => void) => {
      calls.push({ text, key })
      accepted?.()
      await new Promise<void>((resolve) => pending.push(resolve))
    },
    fetch: async () => ({ ok: true }),
    stopButton: { disabled: false },
    setTimeout: () => 1, clearTimeout: () => {},
    renderQueue: () => {}, renderComposerState: () => {}, growComposer: () => {},
    add: () => {},
    field: { value: '' },
  }
  return runInNewContext(`
    const QUEUE_KEY_NONE = '';
    let composerKey = 'X';
    const queues = new Map();
    const runningSessions = new Set();
    let directTurnPending = 0;
    const directTurnsByQueue = new WeakMap();
    let directPendingSince = null, directPendingKey = null, pendingWatchdog = null;
    const queueTurnOut = new WeakSet(), pumping = new WeakSet(), stoppedQueues = new WeakSet();
    let stopRequested = false;
    function sessionRunning() { return runningSessions.has(composerKey) }
    ${['queueOf', 'directTurnsFor', 'keyOfQueue', 'turnInFlight', 'anyRunning', 'sendNow', 'pumpQueue', 'stopTurn'].map(source).join('\n')}
    ({
      setKey(key) { composerKey = key },
      queue(key, text) { queueOf(key).push({ id: text, text, status: 'pending', attachments: [] }) },
      anyRunning, sendNow, pumpQueue, stopTurn,
      resume() { stoppedQueues.delete(queueOf()) },
      calls, pending,
    })
  `, context) as {
    setKey(key: string): void; queue(key: string, text: string): void;
    anyRunning(): boolean; sendNow(text: string): Promise<void>;
    pumpQueue(key: string): Promise<void>; stopTurn(): Promise<void>; resume(): void;
    calls: Array<{ text: string; key: string }>; pending: Array<() => void>;
  }
}

test('Refs #73: a direct turn in X does not make idle Y running', async () => {
  const state = harness()
  const sent = state.sendNow('FIRST-X')
  assert.equal(state.anyRunning(), true)
  state.setKey('Y')
  assert.equal(state.anyRunning(), false, 'Y must offer Send, not Stop or queue because of X')
  state.pending.shift()!()
  await sent
})

test('Refs #72: finishing a direct turn drains its own queued messages after switching sessions', async () => {
  const state = harness()
  const sent = state.sendNow('FIRST-X')
  state.queue('X', 'QUEUED-X')
  state.setKey('Y')
  state.pending.shift()!()
  await sent
  assert.equal(state.calls.length, 2, 'the queued message must not be stranded')
  assert.equal(state.calls[1]?.text, 'QUEUED-X')
  assert.equal(state.calls[1]?.key, 'X', 'navigation must not redirect X messages to Y')
  state.pending.shift()!()
  await Promise.resolve()
})


test('Refs #75: Stop preserves queued rows until an explicit new submission wakes them', async () => {
  const state = harness()
  const sent = state.sendNow('FIRST-X')
  state.queue('X', 'KEPT-X')
  await state.stopTurn()
  state.pending.shift()!()
  await sent
  await state.pumpQueue('X')
  assert.equal(state.calls.length, 1, 'Stop must not automatically send the queued message')
  state.resume()
  const pumping = state.pumpQueue('X')
  assert.equal(state.calls[1]?.text, 'KEPT-X', 'explicit wake-up retains the queued message')
  state.pending.shift()!()
  await pumping
})
