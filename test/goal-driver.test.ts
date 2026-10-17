import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { decideGoalRound, GoalDriver, renderGoalRoundPrompt, ROUND_LIMIT_CODE, type GoalDriverDeps } from '../src/goal/driver.ts'
import { foldGoal, GoalService, type GoalView } from '../src/goal/service.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'

/**
 * The goal round driver: what it decides, and what a chain of rounds actually does.
 *
 * The decision is judged as a pure function because its refusals are the design — a driver that ran a
 * paused goal, ran past the cap, or continued a goal this process is neither armed for would undo the
 * state machine's whole point. The chain is judged against a **real** session store and goal service with
 * a fake turn, because the claim "a round is an admitted message in the log" is only true if the driver
 * and the fold agree about the same events.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-driver-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function setup(): { store: SessionStore; goals: GoalService; handle: SessionHandle } {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const handle = store.create({ cwd: root })
  const goals = new GoalService(new Context(), store)
  return { store, goals, handle }
}

/** A turn that records the round it answered, the way `runTurn` records a prompt. */
function recordingRun(store: SessionStore, calls: { round: number; prompt: string }[]): GoalDriverDeps {
  return {
    run: async (handle, prompt, source) => {
      calls.push({ round: Number(source.round), prompt })
      store.message(handle, { role: 'user', content: [{ type: 'text', text: prompt }], source })
      return { text: 'round done' }
    },
  }
}

const view = (overrides: Partial<GoalView> = {}): GoalView => ({
  id: 'goal-1',
  revision: 1,
  objective: 'ship the driver',
  phase: 'active',
  maxGoalRounds: 4,
  roundsStarted: 0,
  activation: 'armed',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...overrides,
})

test('the continuation prompt restates the objective and the round', () => {
  const prompt = renderGoalRoundPrompt(view({ objective: 'ship "it"' }), 3)
  assert.match(prompt, /^Objective: "ship \\"it\\""\nRound: 3\/4\n/)
  assert.match(prompt, /Continue working toward the objective in this same session/)
  assert.match(prompt, /leave the goal active for the next round/)
})

test('the decision refuses every non-runnable goal, and blocks at the cap', () => {
  assert.deepEqual(decideGoalRound(undefined), { kind: 'stop', why: 'no-goal' })
  for (const phase of ['paused', 'blocked', 'complete'] as const) {
    assert.deepEqual(decideGoalRound(view({ phase })), { kind: 'stop', why: `phase-${phase}` })
  }
  assert.deepEqual(decideGoalRound(view({ activation: 'disarmed' })), { kind: 'stop', why: 'disarmed' })

  const round = decideGoalRound(view({ roundsStarted: 2 }))
  assert.equal(round.kind, 'round')
  assert.equal(round.kind === 'round' ? round.round : 0, 3)
  assert.match(round.kind === 'round' ? round.prompt : '', /Round: 3\/4/)

  const capped = decideGoalRound(view({ roundsStarted: 4 }))
  assert.equal(capped.kind, 'block')
  assert.equal(capped.kind === 'block' ? capped.reason.code : '', ROUND_LIMIT_CODE)
  assert.match(capped.kind === 'block' ? capped.reason.message : '', /limit of 4 rounds/)
})

test('a chain runs one round at a time, and the fold counts each admitted round', async () => {
  const { store, goals, handle } = setup()
  const created = goals.create(handle, { objective: 'do three things', maxGoalRounds: 3 })
  const calls: { round: number; prompt: string }[] = []
  const driver = new GoalDriver(new Context(), goals, recordingRun(store, calls))

  const outcome = await driver.advance(handle)
  assert.equal(outcome.rounds, 3)
  assert.equal(outcome.stopped, 'round-limit')
  assert.equal(outcome.blocked?.code, ROUND_LIMIT_CODE)

  assert.deepEqual(calls.map((call) => call.round), [1, 2, 3], 'each round number is used once, in order')
  assert.match(calls[0]?.prompt ?? '', /Round: 1\/3/)

  // The rounds are in the log as goal-attributed user messages, which is what the fold counts.
  const folded = foldGoal(store.read(handle))
  assert.equal(folded.roundsStarted, 3)
  assert.equal(folded.goal?.phase, 'blocked')
  assert.deepEqual(folded.goal?.blockedReason, { code: ROUND_LIMIT_CODE, message: 'Goal reached its configured limit of 3 rounds.' })
  assert.equal(folded.goal?.id, created.id)
})

test('a chain stops when the goal is not runnable', async () => {
  const { store, goals, handle } = setup()
  const calls: { round: number; prompt: string }[] = []
  const driver = new GoalDriver(new Context(), goals, recordingRun(store, calls))

  assert.equal((await driver.advance(handle)).stopped, 'no-goal')

  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  goals.pause(handle, { id: created.id, revision: created.revision })
  assert.equal((await driver.advance(handle)).stopped, 'phase-paused')
  assert.equal(calls.length, 0, 'a paused goal runs no round')
})

test('a goal disarmed by a new process runs no round', async () => {
  const { store, goals, handle } = setup()
  goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  const reopened = new GoalService(new Context(), store)
  const driver = new GoalDriver(new Context(), reopened, { run: async () => ({}) })
  assert.equal((await driver.advance(handle)).stopped, 'disarmed')
})

test('a round that was not admitted stops the chain instead of repeating forever', async () => {
  const { goals, handle } = setup()
  goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  let turns = 0
  const driver = new GoalDriver(new Context(), goals, {
    run: async () => {
      turns += 1
      return {}
    },
  })
  const outcome = await driver.advance(handle)
  assert.equal(turns, 1, 'the broken round was run once')
  assert.equal(outcome.stopped, 'round-not-admitted')
})

test('a goal moved during its round stops the chain and keeps the round attributed to the old revision', async () => {
  const { store, goals, handle } = setup()
  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  const driver = new GoalDriver(new Context(), goals, {
    run: async (session, prompt, source) => {
      store.message(session, { role: 'user', content: [{ type: 'text', text: prompt }], source })
      /**
       * The model itself edits the goal mid-round, which is exactly the race DSH's attempt lifecycle
       * guards against: the round belongs to the revision it started under.
       */
      goals.edit(session, { id: created.id, revision: created.revision }, { objective: 'a better objective' })
      return {}
    },
  })
  const outcome = await driver.advance(handle)
  assert.equal(outcome.rounds, 1)
  assert.equal(outcome.stopped, 'goal-moved')
})

test('a goal completed during its round stops the chain', async () => {
  const { store, goals, handle } = setup()
  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  const driver = new GoalDriver(new Context(), goals, {
    run: async (session, prompt, source) => {
      store.message(session, { role: 'user', content: [{ type: 'text', text: prompt }], source })
      goals.complete(session, { id: created.id, revision: created.revision })
      return {}
    },
  })
  const outcome = await driver.advance(handle)
  assert.equal(outcome.stopped, 'goal-moved')
  assert.equal(goals.get(handle)?.phase, 'complete', 'the completion stayed, and no further round ran')
})

test('a second trigger joins the running chain instead of starting a concurrent one', async () => {
  const { store, goals, handle } = setup()
  goals.create(handle, { objective: 'one', maxGoalRounds: 2 })
  const calls: { round: number; prompt: string }[] = []
  const deps = recordingRun(store, calls)
  const slow: GoalDriverDeps = {
    run: async (session, prompt, source) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return await deps.run(session, prompt, source)
    },
  }
  const driver = new GoalDriver(new Context(), goals, slow)
  const [first, second] = await Promise.all([driver.advance(handle), driver.advance(handle)])
  assert.deepEqual(first, second, 'both callers saw the same chain')
  assert.deepEqual(calls.map((call) => call.round), [1, 2], 'and it ran each round once')
})

test('a turn that throws leaves the goal runnable for a later trigger', async () => {
  const { goals, handle } = setup()
  goals.create(handle, { objective: 'one', maxGoalRounds: 4 })
  const driver = new GoalDriver(new Context(), goals, { run: async () => { throw new Error('provider down') } })
  const outcome = await driver.advance(handle)
  assert.equal(outcome.stopped, 'turn-failed')
  assert.equal(outcome.error, 'provider down')
  assert.equal(goals.get(handle)?.phase, 'active', 'a failed turn does not block the goal')
  assert.equal(goals.get(handle)?.activation, 'armed')
})
