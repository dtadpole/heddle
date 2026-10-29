import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { GoalService, type GoalView } from '../src/goal/service.ts'
import { endOfRun, goalToolGuidance, goalTools, GoalToolConfig, openTurnEvents, UPDATE_ACTIONS } from '../src/goal/tool.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'
import type { ToolResult, ToolRunContext } from '../src/tools/service.ts'

/**
 * The goal tools' verbs and authority, against DSH's `dsh-tool-goal` (the DSH-parity spec `goals-todo-spec.md`,
 * section A; R-developer-nine-2, -3 and -4).
 *
 * Every refusal is pinned by its code **and** DSH's sentence, because the sentence is what the model reads back.
 * Authority is judged from the session's own log, so each test writes the messages a real turn would: a person's
 * message has no `source`; the harness's messages (goal rounds, reminders, team mail, a child's notice) carry one;
 * a turn ends with `turn/completed` or `turn/failed`.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-goal-tool-'))
after(() => rmSync(root, { recursive: true, force: true }))

const HUMAN_REQUIRED = 'this goal operation requires a direct human turn on a top-level agent'
const COMPLETION_AUTHORITY = 'complete and blocked require a direct human turn or the current goal round'

let counter = 0

/** One session with a goal service and the tools over it; helpers write the messages a turn would. */
function fixture(options: { readonly delegationDepth?: number; readonly config?: GoalToolConfig } = {}) {
  counter += 1
  const sessions = new SessionStore(join(root, `store-${counter}`))
  const handle: SessionHandle = sessions.create({
    cwd: root,
    ...(options.delegationDepth !== undefined ? { delegationDepth: options.delegationDepth, origin: 'subagent' as const, parentSession: 'session-parent' } : {}),
  })
  const goals = new GoalService(new Context(), sessions)
  const tools = goalTools(goals, options.config)
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = tools.find((definition) => definition.spec.name === name)
    assert.ok(tool !== undefined, `no tool ${name}`)
    return tool.run(args, { cwd: root, session: handle, mode: 'workspace-write', log: () => {} } as ToolRunContext)
  }
  const text = [{ type: 'text' as const, text: 'go' }]
  return {
    sessions,
    handle,
    goals,
    tools,
    call,
    /** A person's message: no source at all. */
    person: () => sessions.message(handle, { role: 'user', content: text }),
    /** A message the harness wrote, with its source. */
    sourced: (source: unknown) => sessions.message(handle, { role: 'user', content: text, source }),
    /** The end of the open turn. */
    endTurn: (type: 'turn/completed' | 'turn/failed' = 'turn/completed') => sessions.append(handle, { type, rounds: 1 }),
    /** Goal rounds 1..k for the goal's current revision, each in its own turn; round k is the open turn. */
    rounds: (goal: Pick<GoalView, 'id' | 'revision'>, count: number) => {
      for (let round = 1; round <= count; round += 1) {
        if (round > 1) sessions.append(handle, { type: 'turn/completed', rounds: 1 })
        sessions.message(handle, { role: 'user', content: text, source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round } })
      }
    },
    current: () => goals.get(handle),
  }
}

/** Assert a refusal by code and exact message, and that nothing was written. */
async function refusedWith(
  f: ReturnType<typeof fixture>,
  result: Promise<ToolResult> | ToolResult,
  code: string,
  message: string,
): Promise<void> {
  const changesBefore = f.sessions.read(f.handle).filter((event) => event.type === 'goal/change').length
  const settled = await result
  assert.deepEqual(settled.error, { code, message })
  assert.equal(settled.output, '')
  assert.equal(f.sessions.read(f.handle).filter((event) => event.type === 'goal/change').length, changesBefore, 'a refusal writes no goal change')
}

function ref(goal: Pick<GoalView, 'id' | 'revision'>): { goal_id: string; revision: number } {
  return { goal_id: goal.id, revision: goal.revision }
}

// --- A1: the schema ------------------------------------------------------------------------------------------------

test('update_goal offers exactly DSH’s five verbs, with DSH’s descriptions and a string blocked_reason', () => {
  const f = fixture()
  const update = f.tools.find((tool) => tool.spec.name === 'update_goal')
  assert.ok(update !== undefined)
  const parameters = update.spec.parameters as { properties: Record<string, { type: string; description: string; enum?: string[] }>; required: string[] }
  assert.deepEqual(parameters.properties.action?.enum, ['edit', 'pause', 'resume', 'complete', 'blocked'])
  assert.deepEqual([...UPDATE_ACTIONS], ['edit', 'pause', 'resume', 'complete', 'blocked'])
  assert.equal(update.spec.description, 'Update the current goal.')
  assert.equal(parameters.properties.goal_id?.description, 'Exact id returned by get_goal.')
  assert.equal(parameters.properties.revision?.description, 'Exact positive revision returned by get_goal.')
  assert.equal(
    parameters.properties.action?.description,
    'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.',
  )
  assert.equal(parameters.properties.objective?.description, 'Replacement objective; valid only with action edit.')
  assert.equal(parameters.properties.max_goal_rounds?.description, 'Replacement cap; valid only with action edit.')
  assert.equal(parameters.properties.blocked_reason?.type, 'string')
  assert.equal(
    parameters.properties.blocked_reason?.description,
    'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
  )
  assert.deepEqual(parameters.required, ['goal_id', 'revision', 'action'])
})

test('the legacy `update` verb still edits, as an undocumented alias of edit with edit’s authority', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const edited = await f.call('update_goal', { ...ref(goal), action: 'update', objective: 'one, sharper', max_goal_rounds: 9 })
  assert.equal(edited.error, undefined)
  assert.equal(f.current()?.objective, 'one, sharper')
  assert.equal(f.current()?.maxGoalRounds, 9)

  const g = fixture()
  const other = g.goals.create(g.handle, { objective: 'two' })
  g.rounds(other, 1)
  await refusedWith(g, g.call('update_goal', { ...ref(other), action: 'update', objective: 'x' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
})

test('a verb outside the enum is refused before anything runs', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'clear' }), 'GOAL_TOOL_UNKNOWN_ACTION', 'unknown goal action "clear"')
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'block', blocked_reason: 'x' }), 'GOAL_TOOL_UNKNOWN_ACTION', 'unknown goal action "block"')
  // The alias table is not an object whose prototype could answer for a verb.
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'toString' }), 'GOAL_TOOL_UNKNOWN_ACTION', 'unknown goal action "toString"')
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: '__proto__' }), 'GOAL_TOOL_UNKNOWN_ACTION', 'unknown goal action "__proto__"')
  await refusedWith(f, f.call('update_goal', { ...ref(goal) }), 'GOAL_TOOL_UNKNOWN_ACTION', 'unknown goal action ""')
})

test('a malformed ref is refused with DSH’s sentence, before authority', async () => {
  const f = fixture()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const bad = 'goal_id must be non-empty and revision must be a positive safe integer'
  // No human message at all: the ref is judged first, as in DSH.
  await refusedWith(f, f.call('update_goal', { goal_id: '', revision: 1, action: 'complete' }), 'GOAL_TOOL_INVALID_UPDATE', bad)
  await refusedWith(f, f.call('update_goal', { goal_id: ` ${goal.id}`, revision: 1, action: 'edit', objective: 'x' }), 'GOAL_TOOL_INVALID_UPDATE', bad)
  await refusedWith(f, f.call('update_goal', { goal_id: goal.id, revision: 0, action: 'pause' }), 'GOAL_TOOL_INVALID_UPDATE', bad)
  await refusedWith(f, f.call('update_goal', { goal_id: goal.id, revision: 1.5, action: 'pause' }), 'GOAL_TOOL_INVALID_UPDATE', bad)
  await refusedWith(f, f.call('update_goal', { goal_id: goal.id, action: 'pause' }), 'GOAL_TOOL_INVALID_UPDATE', bad)
})

// --- A1: filler and the per-action fields --------------------------------------------------------------------------

test('filler: an empty string or 0 counts as omitted in update_goal', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one', maxGoalRounds: 4 })

  // Nothing but filler is an edit with no replacement: the domain's refusal, in DSH's words.
  await refusedWith(
    f,
    f.call('update_goal', { ...ref(goal), action: 'edit', objective: '', max_goal_rounds: 0, blocked_reason: '' }),
    'GOAL_INVALID_EDIT',
    'goal edit requires objective and/or maxGoalRounds',
  )
  // A real objective beside a zero cap changes only the objective.
  const edited = await f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'one, sharper', max_goal_rounds: 0, blocked_reason: '' })
  assert.equal(edited.error, undefined)
  assert.equal(f.current()?.objective, 'one, sharper')
  assert.equal(f.current()?.maxGoalRounds, 4)

  const paused = await f.call('update_goal', { ...ref(f.current()!), action: 'pause', objective: '', max_goal_rounds: 0, blocked_reason: '' })
  assert.equal(paused.error, undefined)
  assert.equal(f.current()?.phase, 'paused')

  const completed = await f.call('update_goal', { ...ref(f.current()!), action: 'complete', objective: '', max_goal_rounds: 0, blocked_reason: '' })
  assert.equal(completed.error, undefined)
  assert.equal(f.current()?.phase, 'complete')
})

test('filler: blocked with an empty objective and a zero cap is still a block', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const blocked = await f.call('update_goal', { ...ref(goal), action: 'blocked', objective: '', max_goal_rounds: 0, blocked_reason: 'no key' })
  assert.equal(blocked.error, undefined)
  assert.equal(f.current()?.phase, 'blocked')
})

test('each verb refuses the fields that belong to another, with DSH’s sentences', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const code = 'GOAL_TOOL_INVALID_UPDATE'
  const reasonOnly = 'blocked_reason is valid only with action blocked'
  const editOnly = 'objective and max_goal_rounds are valid only with action edit'
  const pauseResume = 'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked'

  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'x', blocked_reason: 'y' }), code, reasonOnly)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'x', blocked_reason: '   ' }), code, reasonOnly)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'pause', objective: 'x' }), code, pauseResume)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'pause', blocked_reason: 'y' }), code, pauseResume)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'resume', max_goal_rounds: 5 }), code, pauseResume)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'complete', objective: 'x' }), code, editOnly)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'blocked', max_goal_rounds: 5, blocked_reason: 'y' }), code, editOnly)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'complete', blocked_reason: 'y' }), code, reasonOnly)
})

test('blocked needs a reason, as a non-blank string', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const required = 'blocked_reason is required with action blocked'
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'blocked' }), 'GOAL_TOOL_INVALID_UPDATE', required)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: '' }), 'GOAL_TOOL_INVALID_UPDATE', required)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: '  \n ' }), 'GOAL_TOOL_INVALID_UPDATE', required)
  // The old object shape is no longer the schema: it is refused rather than half-read.
  await refusedWith(
    f,
    f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: { code: 'missing-input', message: 'needs a key' } }),
    'GOAL_TOOL_INVALID_UPDATE',
    required,
  )
})

test('a model’s blocked reason is stored as { code: model-reported, message: <trimmed> }', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  const result = await f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: '  the API key is missing  ' })
  assert.equal(result.error, undefined)
  assert.deepEqual(f.current()?.blockedReason, { code: 'model-reported', message: 'the API key is missing' })
  assert.equal(f.current()?.phase, 'blocked')
  assert.deepEqual((JSON.parse(result.output) as GoalView).blockedReason, { code: 'model-reported', message: 'the API key is missing' })
})

// --- A2: the block threshold ---------------------------------------------------------------------------------------

test('a goal round may not block before round N (default 3): N-1 is refused, N is accepted', async () => {
  const early = fixture()
  const goal = early.goals.create(early.handle, { objective: 'one' })
  early.rounds(goal, 2)
  assert.equal(early.current()?.roundsStarted, 2)
  await refusedWith(
    early,
    early.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: 'no key' }),
    'GOAL_TOOL_BLOCK_THRESHOLD',
    'blocked requires at least 3 consecutive goal rounds; current round is 2',
  )
  assert.equal(early.current()?.phase, 'active')

  const onTime = fixture()
  const other = onTime.goals.create(onTime.handle, { objective: 'two' })
  onTime.rounds(other, 3)
  const result = await onTime.call('update_goal', { ...ref(other), action: 'blocked', blocked_reason: 'no key' })
  assert.equal(result.error, undefined)
  assert.equal(onTime.current()?.phase, 'blocked')
  assert.equal(result.data?.authority, 'goal-round')
})

test('the threshold binds only goal rounds: a person may block at round 0, and a steered person’s message counts', async () => {
  const f = fixture()
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  assert.equal(f.current()?.roundsStarted, 0)
  const result = await f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: 'no key' })
  assert.equal(result.error, undefined)
  assert.equal(result.data?.authority, 'direct-human')

  // A person steering into goal round 1 makes the turn a direct human turn, so the threshold does not apply.
  const g = fixture()
  const other = g.goals.create(g.handle, { objective: 'two' })
  g.rounds(other, 1)
  g.person()
  const steered = await g.call('update_goal', { ...ref(other), action: 'blocked', blocked_reason: 'no key' })
  assert.equal(steered.error, undefined)
  assert.equal(steered.data?.authority, 'direct-human')
  assert.ok(!steered.output.includes('<goal_blocked>'), 'a direct human turn is not told to end its run')
})

test('blockedAfterConsecutiveRounds is configurable, and validated as a positive safe integer', async () => {
  const five = fixture({ config: { blockedAfterConsecutiveRounds: 5 } })
  const goal = five.goals.create(five.handle, { objective: 'one' })
  five.rounds(goal, 4)
  await refusedWith(
    five,
    five.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: 'no key' }),
    'GOAL_TOOL_BLOCK_THRESHOLD',
    'blocked requires at least 5 consecutive goal rounds; current round is 4',
  )
  five.endTurn()
  five.sourced({ kind: 'goal', goalId: goal.id, revision: goal.revision, round: 5 })
  assert.equal((await five.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: 'no key' })).error, undefined)

  const one = fixture({ config: { blockedAfterConsecutiveRounds: 1 } })
  const first = one.goals.create(one.handle, { objective: 'one' })
  one.rounds(first, 1)
  assert.equal((await one.call('update_goal', { ...ref(first), action: 'blocked', blocked_reason: 'no key' })).error, undefined)

  const goals = new GoalService(new Context(), new SessionStore(join(root, 'config')))
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    assert.throws(() => goalTools(goals, { blockedAfterConsecutiveRounds: bad }), (error: unknown) => {
      return error instanceof TypeError && error.message === 'blockedAfterConsecutiveRounds must be a positive safe integer'
    })
  }
  assert.deepEqual(GoalToolConfig({}), { blockedAfterConsecutiveRounds: 3 })
  assert.throws(() => GoalToolConfig({ blockedAfterConsecutiveRounds: 0 }))
})

// --- A3: authority -------------------------------------------------------------------------------------------------

test('a direct human turn may create, edit, pause, complete — and resume a blocked goal, but not a paused one', async () => {
  const f = fixture()
  f.person()
  const created = await f.call('create_goal', { objective: 'one', max_goal_rounds: 5 })
  assert.equal(created.error, undefined)
  const goal = f.current()!
  assert.equal((await f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'one, sharper' })).error, undefined)
  assert.equal((await f.call('update_goal', { ...ref(f.current()!), action: 'pause' })).error, undefined)
  await refusedWith(
    f,
    f.call('update_goal', { ...ref(f.current()!), action: 'resume' }),
    'GOAL_TOOL_RESUME_PAUSED',
    'the model cannot resume a paused goal; the user must resume it',
  )
  assert.equal((await f.call('update_goal', { ...ref(f.current()!), action: 'complete' })).error, undefined)

  const g = fixture()
  g.person()
  const other = g.goals.create(g.handle, { objective: 'two' })
  const blocked = g.goals.block(g.handle, { id: other.id, revision: other.revision }, { code: 'missing-input', message: 'needs a key' })
  const resumed = await g.call('update_goal', { ...ref(blocked), action: 'resume' })
  assert.equal(resumed.error, undefined)
  assert.equal(g.current()?.phase, 'active')
})

test('DSH’s explicit { kind: user } source is a person too', async () => {
  const f = fixture()
  f.sourced({ kind: 'user' })
  assert.equal((await f.call('create_goal', { objective: 'one' })).error, undefined)
})

test('a goal round may complete or block its goal, and nothing else', async () => {
  const f = fixture()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  f.rounds(goal, 1)
  const code = 'GOAL_TOOL_AUTHORITY_REQUIRED'
  await refusedWith(f, f.call('create_goal', { objective: 'two' }), code, HUMAN_REQUIRED)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'x' }), code, HUMAN_REQUIRED)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'pause' }), code, HUMAN_REQUIRED)
  f.goals.disarm(f.handle)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'resume' }), code, HUMAN_REQUIRED)

  const completed = await f.call('update_goal', { ...ref(goal), action: 'complete' })
  assert.equal(completed.error, undefined)
  assert.equal(f.current()?.phase, 'complete')
  assert.equal(completed.data?.authority, 'goal-round')
})

test('the human check comes before the paused check: a goal round resuming a paused goal is an authority refusal', async () => {
  const f = fixture()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  f.rounds(goal, 1)
  const paused = f.goals.pause(f.handle, { id: goal.id, revision: goal.revision })
  await refusedWith(f, f.call('update_goal', { ...ref(paused), action: 'resume' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
})

test('only the current round has authority: a revision edited mid-round, or another goal’s round, has none', async () => {
  const f = fixture()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  f.rounds(goal, 1)
  const edited = f.goals.edit(f.handle, { id: goal.id, revision: goal.revision }, { objective: 'one, sharper' })
  await refusedWith(f, f.call('update_goal', { ...ref(edited), action: 'complete' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', COMPLETION_AUTHORITY)

  const g = fixture()
  const first = g.goals.create(g.handle, { objective: 'first' })
  g.rounds(first, 1)
  g.goals.complete(g.handle, { id: first.id, revision: first.revision })
  const second = g.goals.create(g.handle, { objective: 'second' })
  // The open turn is the first goal's round; the second goal has had none.
  await refusedWith(g, g.call('update_goal', { ...ref(second), action: 'complete' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', COMPLETION_AUTHORITY)
})

test('a turn the harness started for a reminder, team mail or a child’s notice has no authority', async () => {
  const sources = [
    { kind: 'schedule', scheduleId: 'sched-1' },
    { kind: 'team-message', teamId: 'session-lead', messageId: 'm-1', senderId: 'a', senderName: 'A' },
    { kind: 'team-prompt', teamId: 'session-lead', memberId: 'session-member' },
    { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'session-child' },
    null,
  ]
  for (const source of sources) {
    const f = fixture()
    const goal = f.goals.create(f.handle, { objective: 'one' })
    f.sourced(source)
    const code = 'GOAL_TOOL_AUTHORITY_REQUIRED'
    await refusedWith(f, f.call('create_goal', { objective: 'two' }), code, HUMAN_REQUIRED)
    await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'edit', objective: 'x' }), code, HUMAN_REQUIRED)
    await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'pause' }), code, HUMAN_REQUIRED)
    await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'complete' }), code, COMPLETION_AUTHORITY)
    await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'blocked', blocked_reason: 'x' }), code, COMPLETION_AUTHORITY)
  }
})

test('a person’s message in an earlier turn grants nothing to the open one', async () => {
  for (const end of ['turn/completed', 'turn/failed'] as const) {
    const f = fixture()
    const goal = f.goals.create(f.handle, { objective: 'one' })
    f.person()
    f.endTurn(end)
    f.sourced({ kind: 'schedule' })
    await refusedWith(f, f.call('create_goal', { objective: 'two' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
    await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'complete' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', COMPLETION_AUTHORITY)
  }
  // And a goal round after a person's turn has the goal round's authority only.
  const g = fixture()
  g.person()
  g.endTurn()
  const goal = g.goals.create(g.handle, { objective: 'one' })
  g.rounds(goal, 1)
  await refusedWith(g, g.call('update_goal', { ...ref(goal), action: 'edit', objective: 'x' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
  assert.equal((await g.call('update_goal', { ...ref(goal), action: 'complete' })).data?.authority, 'goal-round')
})

test('the open turn is everything after the last turn/completed or turn/failed', () => {
  const event = (seq: number, type: string) => ({ seq, at: '', type })
  assert.deepEqual(openTurnEvents([event(0, 'message'), event(1, 'turn/completed'), event(2, 'message'), event(3, 'goal/change')]).map((one) => one.seq), [2, 3])
  assert.deepEqual(openTurnEvents([event(0, 'turn/completed'), event(1, 'message'), event(2, 'turn/failed'), event(3, 'message')]).map((one) => one.seq), [3])
  assert.deepEqual(openTurnEvents([event(0, 'session/created'), event(1, 'message')]).map((one) => one.seq), [0, 1], 'no turn has ended yet')
  assert.deepEqual(openTurnEvents([event(0, 'message'), event(1, 'turn/completed')]), [], 'between turns nothing is open')
})

test('a delegated session is never a direct human turn, though its own goal round still counts', async () => {
  const f = fixture({ delegationDepth: 1 })
  f.person()
  const goal = f.goals.create(f.handle, { objective: 'one' })
  await refusedWith(f, f.call('create_goal', { objective: 'two' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'pause' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
  await refusedWith(f, f.call('update_goal', { ...ref(goal), action: 'complete' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', COMPLETION_AUTHORITY)

  // DSH checks the root only for human input; the exact goal round is authority on any agent.
  f.endTurn()
  f.rounds(goal, 1)
  assert.equal((await f.call('update_goal', { ...ref(goal), action: 'complete' })).data?.authority, 'goal-round')

  const top = fixture({ delegationDepth: 0 })
  top.person()
  assert.equal((await top.call('create_goal', { objective: 'one' })).error, undefined, 'depth 0 is top level')
})

test('a fresh session with no message in its open turn has no authority', async () => {
  const f = fixture()
  await refusedWith(f, f.call('create_goal', { objective: 'one' }), 'GOAL_TOOL_AUTHORITY_REQUIRED', HUMAN_REQUIRED)
})

test('get_goal needs no authority, and create_goal keeps refusing a zero cap', async () => {
  const f = fixture({ delegationDepth: 2 })
  const goal = f.goals.create(f.handle, { objective: 'one' })
  f.sourced({ kind: 'schedule' })
  const read = await f.call('get_goal', {})
  assert.equal((JSON.parse(read.output) as GoalView).id, goal.id)

  const g = fixture()
  g.person()
  await refusedWith(g, g.call('create_goal', { objective: 'one', max_goal_rounds: 0 }), 'GOAL_INVALID_MAX_ROUNDS', 'maxGoalRounds must be a positive safe integer')
})

// --- A4: the end of the run ----------------------------------------------------------------------------------------

test('only a goal round is told to end its run, with DSH’s closing text', async () => {
  const human = fixture()
  human.person()
  const goal = human.goals.create(human.handle, { objective: 'ship it' })
  const done = await human.call('update_goal', { ...ref(goal), action: 'complete' })
  assert.equal(done.error, undefined)
  assert.equal(done.output, JSON.stringify(JSON.parse(done.output)), 'a person’s complete answers the goal and nothing else')
  assert.ok(!done.output.includes('<goal_complete>'))

  const round = fixture()
  const other = round.goals.create(round.handle, { objective: 'ship it' })
  round.rounds(other, 1)
  const completed = await round.call('update_goal', { ...ref(other), action: 'complete' })
  const [json, closing] = completed.output.split('\n\n<goal_complete>')
  assert.equal((JSON.parse(json ?? '') as GoalView).phase, 'complete')
  assert.ok(closing !== undefined)
  assert.ok(completed.output.endsWith(`\n\n${endOfRun('ship it')}`))
  assert.ok(endOfRun('ship it').startsWith('<goal_complete>\nObjective: "ship it"\nThe goal is marked complete and this autonomous run is ending.'))
  assert.ok(endOfRun('ship it').endsWith("Do not call any more tools in this run; further work waits for the user's next instruction.\n</goal_complete>"))

  const blocked = fixture()
  const third = blocked.goals.create(blocked.handle, { objective: 'ship it' })
  blocked.rounds(third, 3)
  const result = await blocked.call('update_goal', { ...ref(third), action: 'blocked', blocked_reason: ' no key ' })
  assert.ok(result.output.endsWith(`\n\n${endOfRun('ship it', 'no key')}`))
  assert.ok(endOfRun('ship it', 'no key').startsWith('<goal_blocked>\nObjective: "ship it"\nBlocked: "no key"\nThe goal is marked blocked and this autonomous run is ending.'))
  assert.ok(endOfRun('ship it', 'no key').endsWith('</goal_blocked>'))
})

test('the tool:goal guidance is DSH’s sentence with the configured threshold', () => {
  assert.equal(
    goalToolGuidance(3),
    'create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.',
  )
  assert.ok(goalToolGuidance(5).includes('for at least 5 consecutive goal rounds'))
  assert.equal(goalToolGuidance(), goalToolGuidance(3))
})
