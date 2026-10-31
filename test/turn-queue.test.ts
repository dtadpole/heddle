import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { test } from 'node:test'

import { TurnRegistry, type LiveTurn } from '../src/agent/turns.ts'

/**
 * One turn at a time per session (#28).
 *
 * Measured before on both builds: two `POST /api/turn` for one session 300 ms apart both ran, interleaved their writes
 * in one log, and the first turn's next request carried the second's exchange, which the provider refused. DSH admits
 * a prompt sent to a busy session as a follow-up and claims it after the running turn. `enqueue` is that queue.
 */

const registry = (): TurnRegistry => new TurnRegistry(new Context())

/** The turn a ticket stands for, at once or after the queue. */
const turnOf = async (ticket: { readonly live: LiveTurn } | { readonly wait: Promise<LiveTurn> }): Promise<LiveTurn> =>
  'live' in ticket ? ticket.live : await ticket.wait

/** Let every pending continuation run. */
const settleMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

test('an idle session registers at once, with no await, so a caller’s prompt is still written synchronously', () => {
  const turns = registry()
  const ticket = turns.enqueue('s')
  assert.ok('live' in ticket, 'no wait on an idle session')
  assert.equal(turns.isRunning('s'), true)
  ticket.live.settle()
  assert.equal(turns.isRunning('s'), false)
})

test('a turn sent to a busy session waits for the running one, and the queue keeps arrival order', async () => {
  const turns = registry()
  const running = await turnOf(turns.enqueue('s'))
  const order: string[] = []
  const queued = ['second', 'third'].map((name) => {
    const ticket = turns.enqueue('s')
    assert.ok('wait' in ticket, `${name} waits`)
    return ticket.wait.then(async (turn) => {
      order.push(name)
      await settleMicrotasks()
      assert.equal(order.at(-1), name, 'no other turn of the session began while this one ran')
      turn.settle()
    })
  })
  await settleMicrotasks()
  assert.deepEqual(order, [], 'nothing ran beside the running turn')
  running.settle()
  await Promise.all(queued)
  assert.deepEqual(order, ['second', 'third'])
  assert.equal(turns.isRunning('s'), false)
  assert.ok('live' in turns.enqueue('t'), 'and the queue leaves nothing behind for the next idle turn')
})

test('a turn registered without queueing is waited for, and other sessions never wait', async () => {
  const turns = registry()
  const unqueued = turns.begin('s')
  const ticket = turns.enqueue('s')
  assert.ok('wait' in ticket)
  const other = turns.enqueue('other')
  assert.ok('live' in other, 'another session begins at once')
  let begun = false
  const waiting = ticket.wait.then((turn) => {
    begun = true
    return turn
  })
  await settleMicrotasks()
  assert.equal(begun, false, 'the queued turn waits for the unqueued one')
  unqueued.settle()
  ;(await waiting).settle()
  other.live.settle()
  assert.deepEqual(turns.running(), [])
})
