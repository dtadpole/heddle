import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { foldGoal, GoalError, GoalService, type GoalView } from '../src/goal/service.ts'
import { goalTools } from '../src/goal/tool.ts'
import { SessionStore } from '../src/session/store.ts'
import type { ToolContext } from '../src/tools/service.ts'

/**
 * Goal management: the fold, the transition table, and the tool the model uses.
 *
 * The state machine is the part worth pinning hardest, because its refusals are what keep a goal
 * trustworthy: a stale revision, a create while one is live, a resume past the round cap, or a model
 * un-pausing what a person paused are all *decisions*, and each one has a code a caller can branch on
 * (`_context_/dsh-mechanisms/dsh-goal.md` records the DSH table this mirrors).
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-goal-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function store(): SessionStore {
  counter += 1
  return new SessionStore(join(root, `store-${counter}`))
}

/** A service wired to a real store, so the tests exercise append + fold rather than a stub. */
async function service() {
  const { GoalService } = await import('../src/goal/service.ts')
  const sessions = store()
  const handle = sessions.create({ cwd: root })
  return { goals: new GoalService(new Context(), sessions), sessions, handle }
}

test('a goal lives in the log, and folds back to the same snapshot', async () => {
  const { goals, sessions, handle } = await service()
  const created = goals.create(handle, { objective: 'ship the goal feature', maxGoalRounds: 4 })

  assert.equal(created.objective, 'ship the goal feature')
  assert.equal(created.phase, 'active')
  assert.equal(created.activation, 'armed')
  assert.equal(created.revision, 1)
  assert.equal(created.roundsStarted, 0)
  assert.equal(created.maxGoalRounds, 4)

  const events = sessions.read(handle)
  const changes = events.filter((event) => event.type === 'goal/change')
  assert.equal(changes.length, 1, 'one mutation, one event')
  const folded = foldGoal(events)
  assert.deepEqual(folded.goal, {
    id: created.id,
    revision: 1,
    objective: 'ship the goal feature',
    phase: 'active',
    maxGoalRounds: 4,
  })
})

test('every mutation appends a full snapshot and advances the revision', async () => {
  const { goals, sessions, handle } = await service()
  const created = goals.create(handle, { objective: 'one' })
  const paused = goals.pause(handle, { id: created.id, revision: created.revision })
  assert.equal(paused.phase, 'paused')
  assert.equal(paused.activation, 'disarmed', 'pausing stops automatic continuation')
  assert.equal(paused.revision, 2)

  const resumed = goals.resume(handle, { id: paused.id, revision: paused.revision })
  assert.equal(resumed.phase, 'active')
  assert.equal(resumed.activation, 'armed')
  assert.equal(resumed.revision, 3)
  assert.equal(sessions.read(handle).filter((event) => event.type === 'goal/change').length, 3)
})

test('a stale revision is refused rather than overwriting a newer one', async () => {
  const { goals, handle } = await service()
  const created = goals.create(handle, { objective: 'one' })
  goals.pause(handle, { id: created.id, revision: 1 })

  assert.throws(
    () => goals.complete(handle, { id: created.id, revision: 1 }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_STALE_REVISION',
  )
})

test('a goal cannot be created while another is live, but may replace a completed one', async () => {
  const { goals, handle } = await service()
  const first = goals.create(handle, { objective: 'one' })
  assert.throws(() => goals.create(handle, { objective: 'two' }), (error: unknown) => error instanceof GoalError && error.code === 'GOAL_ALREADY_EXISTS')

  const done = goals.complete(handle, { id: first.id, revision: first.revision })
  assert.equal(done.phase, 'complete')
  const second = goals.create(handle, { objective: 'two' })
  assert.notEqual(second.id, first.id, 'a replacement is a new identity')
  assert.equal(second.revision, 1)
})

test('the transition table refuses what DSH refuses', async () => {
  const { goals, handle } = await service()
  const created = goals.create(handle, { objective: 'one' })
  const ref = { id: created.id, revision: created.revision }

  // pause is allowed from active, and only from active
  const paused = goals.pause(handle, ref)
  assert.equal(paused.phase, 'paused')
  assert.throws(
    () => goals.pause(handle, { id: paused.id, revision: paused.revision }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_INVALID_TRANSITION',
    'a paused goal cannot be paused again',
  )

  // resume is refused while the goal is already active and armed
  const resumed = goals.resume(handle, { id: paused.id, revision: paused.revision })
  assert.equal(resumed.phase, 'active')
  assert.throws(
    () => goals.resume(handle, { id: resumed.id, revision: resumed.revision }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_INVALID_TRANSITION',
  )

  // block is allowed from active, not from paused
  const pausedAgain = goals.pause(handle, { id: resumed.id, revision: resumed.revision })
  assert.throws(
    () => goals.block(handle, { id: pausedAgain.id, revision: pausedAgain.revision }, { code: 'missing-input', message: 'needs a key' }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_INVALID_TRANSITION',
    'a paused goal must be resumed or completed, not blocked',
  )

  // complete is allowed from paused
  const done = goals.complete(handle, { id: pausedAgain.id, revision: pausedAgain.revision })
  assert.equal(done.phase, 'complete')
  assert.equal(done.activation, 'disarmed')
})

test('resume refuses an exhausted round budget', async () => {
  const { goals, sessions, handle } = await service()
  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 1 })
  // One admitted continuation round is a user message whose source names the goal.
  sessions.append(handle, {
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'goal', goalId: created.id, revision: created.revision, round: 1 } },
  })
  const paused = goals.pause(handle, { id: created.id, revision: created.revision })
  assert.equal(paused.roundsStarted, 1, 'the fold counts the admitted round')
  assert.throws(
    () => goals.resume(handle, { id: paused.id, revision: paused.revision }),
    (error: unknown) => error instanceof GoalError && error.message.includes('exhausted'),
  )
})

test('a block needs a lower-kebab code and a message, and exists exactly while blocked', async () => {
  const { goals, handle } = await service()
  const created = goals.create(handle, { objective: 'one' })
  const ref = { id: created.id, revision: created.revision }
  assert.throws(
    () => goals.block(handle, ref, { code: 'Not A Code', message: 'x' }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_INVALID_BLOCK_REASON',
  )
  assert.throws(
    () => goals.block(handle, ref, { code: 'missing-input', message: '   ' }),
    (error: unknown) => error instanceof GoalError && error.code === 'GOAL_INVALID_BLOCK_REASON',
  )
  const blocked = goals.block(handle, ref, { code: 'missing-input', message: 'needs a key' })
  assert.deepEqual(blocked.blockedReason, { code: 'missing-input', message: 'needs a key' })
  assert.equal(blocked.phase, 'blocked')
})

test('only edit may change the definition, and clear leaves a tombstone', async () => {
  const { goals, sessions, handle } = await service()
  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 3 })
  const edited = goals.edit(handle, { id: created.id, revision: 1 }, { objective: 'one, better', maxGoalRounds: 5 })
  assert.equal(edited.objective, 'one, better')
  assert.equal(edited.maxGoalRounds, 5)
  assert.equal(edited.revision, 2)

  const cleared = goals.clear(handle, { id: edited.id, revision: edited.revision })
  assert.deepEqual(cleared, { id: edited.id, revision: 3 })
  const folded = foldGoal(sessions.read(handle))
  assert.equal(folded.goal, undefined, 'the goal is gone')
  assert.deepEqual(folded.lastRef, cleared, 'but the tombstone survives')
  assert.equal(goals.get(handle), undefined)
})

test('the model cannot resume a goal a person paused', async () => {
  const { goals, handle } = await service()
  const created = goals.create(handle, { objective: 'one' })
  const paused = goals.pause(handle, { id: created.id, revision: 1 })
  const tool = goalTools(goals).find((definition) => definition.spec.name === 'update_goal')
  assert.ok(tool !== undefined)
  const result = await tool.run(
    { goal_id: paused.id, revision: paused.revision, action: 'resume' },
    { cwd: root, session: handle } as ToolContext,
  )
  assert.equal(result.error?.code, 'GOAL_TOOL_RESUME_PAUSED')
})

test('the model creates a goal through the tool, and reads it back', async () => {
  const { goals, handle } = await service()
  const tools = goalTools(goals)
  const create = tools.find((definition) => definition.spec.name === 'create_goal')
  const get = tools.find((definition) => definition.spec.name === 'get_goal')
  assert.ok(create !== undefined && get !== undefined)

  const created = await create.run({ objective: 'finish the goal feature', max_goal_rounds: 6 }, { cwd: root, session: handle } as ToolContext)
  assert.equal(created.error, undefined)
  const view = JSON.parse(created.output) as GoalView
  assert.equal(view.phase, 'active')
  assert.equal(view.maxGoalRounds, 6)
  assert.equal(view.activation, 'armed')

  const read = await get.run({}, { cwd: root, session: handle } as ToolContext)
  assert.equal((JSON.parse(read.output) as GoalView).id, view.id)
})

test('a goal tool call with no session is refused rather than guessed', async () => {
  const { goals } = await service()
  const tool = goalTools(goals).find((definition) => definition.spec.name === 'create_goal')
  assert.ok(tool !== undefined)
  const result = await tool.run({ objective: 'x' }, { cwd: root } as ToolContext)
  assert.equal(result.error?.code, 'GOAL_TOOL_NO_SESSION')
})

test('an active goal is armed again in a new process, because pushing survives a restart', () => {
  /**
   * The owner's rule. DSH disarms a reopened goal so a restarted process cannot spend rounds unsupervised;
   * heddle keeps pushing, so an `active` goal is armed by default when a new process folds it. The durable
   * phase is the authority — a **paused** goal is still not runnable, and the process-local override still
   * exists for an in-process lifecycle owner.
   */
  const store = new SessionStore(join(root, 'restart'))
  const goals = new GoalService(new Context(), store)
  const handle = store.create({ cwd: root })
  const created = goals.create(handle, { objective: 'one', maxGoalRounds: 2 })
  const pausedStore = new SessionStore(join(root, 'restart-paused'))
  const pausedGoals = new GoalService(new Context(), pausedStore)
  const pausedHandle = pausedStore.create({ cwd: root })
  const pausedGoal = pausedGoals.create(pausedHandle, { objective: 'two', maxGoalRounds: 2 })
  pausedGoals.pause(pausedHandle, { id: pausedGoal.id, revision: pausedGoal.revision })

  // A new service over the same log is what a reopened harness is.
  const reopened = new GoalService(new Context(), store)
  const view = reopened.get(handle)
  assert.equal(view?.id, created.id, 'the durable goal is there')
  assert.equal(view?.activation, 'armed', 'and an active goal is armed again')

  const reopenedPaused = new GoalService(new Context(), pausedStore)
  assert.equal(reopenedPaused.get(pausedHandle)?.activation, 'disarmed', 'a paused goal is not runnable after a restart')
})

test('a goal created without a cap gets the default, and the default is 100', async () => {
  /**
   * The default is a **decision**, so it is asserted rather than left to the constructor. It was 256 — DSH's own
   * default, copied when this subsystem mirrored theirs — and the owner set it to 100 on 2026-10-17: a goal that has
   * not converged after a hundred rounds will not be converged by the hundred-and-first, and the cap is what makes
   * the driver block loudly rather than spend a night on one objective.
   *
   * A caller that names a number still wins, which is the other half of "unless the owner overrides it".
   */
  /** Two sessions, because a create is refused while another goal is live in the same one. */
  const { goals, sessions, handle } = await service()
  const implicit = goals.create(handle, { objective: 'no cap named' })
  assert.equal(implicit.maxGoalRounds, 100, 'the default is 100')

  const second = sessions.create({ cwd: root })
  const named = goals.create(second, { objective: 'a cap named', maxGoalRounds: 7 })
  assert.equal(named.maxGoalRounds, 7, 'an explicit cap is kept')
})
