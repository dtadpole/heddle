import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { test } from 'node:test'

import { TurnRegistry } from '../src/agent/turns.ts'
import TurnsPlugin from '../src/plugins/turns.ts'

/**
 * The live-turn registry: the half of "is this session running" that the durable log cannot answer.
 *
 * Its contract is small and load-bearing: a turn registers, its signal is abortable, the entry disappears when
 * the turn settles, and one interruption stops every turn of that session without pretending the turns ended.
 */

const registry = (): TurnRegistry => new TurnRegistry(new Context())

test('a begun turn is running, its signal is live, and settling clears it once', () => {
  const turns = registry()
  const turn = turns.begin('session-a')
  assert.equal(turns.isRunning('session-a'), true)
  assert.deepEqual(turns.running(), ['session-a'])
  assert.equal(turn.signal.aborted, false)
  turn.settle()
  assert.equal(turns.isRunning('session-a'), false)
  turn.settle()
  assert.equal(turns.isRunning('session-a'), false, 'settling twice is safe')
})

test('abort stops the signal and reports whether there was a turn, but the entry stays until it settles', () => {
  const turns = registry()
  const turn = turns.begin('session-a')
  assert.equal(turns.abort('session-a', 'interrupted by the Lead'), true)
  assert.equal(turn.signal.aborted, true)
  assert.equal(turn.signal.reason, 'interrupted by the Lead')
  assert.equal(turns.isRunning('session-a'), true, 'a turn winding down is still running until it settles')
  turn.settle()
  assert.equal(turns.isRunning('session-a'), false)
  assert.equal(turns.abort('session-a'), false, 'nothing left to interrupt')
})

test('a session may have several turns, and one interruption stops all of them', () => {
  const turns = registry()
  const first = turns.begin('session-a')
  const second = turns.begin('session-a')
  const other = turns.begin('session-b')
  assert.equal(turns.isRunning('session-a'), true)

  turns.abort('session-a')
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, true)
  assert.equal(other.signal.aborted, false, 'another session is untouched')

  first.settle()
  assert.equal(turns.isRunning('session-a'), true, 'the second turn keeps the session running')
  second.settle()
  assert.equal(turns.isRunning('session-a'), false)
  other.settle()
  assert.deepEqual(turns.running(), [])
})

test('the registry is a service a profile can provide, and turns see it as ctx.turns', async () => {
  const ctx = new Context()
  await ctx.plugin(TurnsPlugin)
  assert.equal(ctx.turns.isRunning('session-a'), false)
  const turn = ctx.turns.begin('session-a')
  assert.equal(ctx.turns.isRunning('session-a'), true)
  turn.settle()
  await ctx.fiber.dispose()
})
