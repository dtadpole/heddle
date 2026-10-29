import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  goalCommand,
  parseGoalCommand,
  type GoalCommandContext,
  type GoalFollowup,
  type GoalHost,
} from '../src/commands/goal.ts'
import { CommandRegistry, parseCommandLine, type CommandLog, type CommandResult } from '../src/commands/registry.ts'
import { GoalService } from '../src/goal/service.ts'
import type { ContentPart } from '../src/llm/types.ts'
import { SessionStore, type SessionHandle } from '../src/session/store.ts'

/**
 * `/goal`'s semantics: DSH's forms and sentences, word for word.
 *
 * The reference is DSH 0.2.1-rc.2's `dsh-command-goal/lib/index.js`, extracted in
 * `_projects_/heddle/_designs_/dsh-parity/goals-todo-spec.md` section B1. Every expected text below is written out
 * rather than imported from the module, so a changed sentence fails here instead of agreeing with itself. The goal
 * service is the real one over a real session store, so each refusal is the service's own and each write is a
 * `goal/change` in the log; the doubles appear only where a state cannot be reached honestly (a stale read).
 */

const USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'
const STATE_ERROR = 'The goal command is not valid for the current state. Run /goal to view available commands.'
const ATTACHMENTS_REFUSED = 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.'
const HINT_ARMED = '/goal edit <objective>, /goal pause, /goal clear'
const HINT_STOPPED = '/goal edit <objective>, /goal resume, /goal clear'
const HINT_COMPLETE = '/goal <objective>, /goal clear'

const root = mkdtempSync(join(tmpdir(), 'heddle-commands-goal-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0

/** The goal service wired straight to the session store, as the goal service's own tests do. */
function hostOf(goals: GoalService): GoalHost {
  return {
    get: (handle) => goals.get(handle),
    create: (handle, request) => goals.create(handle, request),
    edit: (handle, ref, request) => goals.edit(handle, ref, request),
    pause: (handle, ref) => goals.pause(handle, ref),
    resume: (handle, ref) => goals.resume(handle, ref),
    clear: (handle, ref) => goals.clear(handle, ref),
  }
}

/**
 * One session, its goal service and `/goal` over them. `run` takes a whole line, splits it as the layer does and
 * passes attachments the way the layer will once it carries them.
 */
function harness(options: { readonly host?: (goals: GoalService) => GoalHost; readonly sink?: boolean } = {}) {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const handle = store.create({ cwd: root })
  const goals = new GoalService(new Context(), store)
  const followups: { readonly session: SessionHandle; readonly message: GoalFollowup }[] = []
  const host = (options.host ?? hostOf)(goals)
  const command = options.sink === false ? goalCommand(host) : goalCommand(host, (session, message) => followups.push({ session, message }))
  const run = (line: string, attachments?: readonly ContentPart[]) => {
    const parsed = parseCommandLine(line)
    assert.ok(parsed !== undefined && parsed.name === 'goal', `${JSON.stringify(line)} is a /goal line`)
    const context: GoalCommandContext = {
      session: handle,
      commandId: 'cmd-0000abcd-1',
      rawInput: parsed.rawInput,
      args: parsed.rawInput.trim(),
      ...(attachments !== undefined ? { attachments } : {}),
    }
    return command.handler(context)
  }
  const changes = () => store.read(handle).filter((event) => event.type === 'goal/change').length
  return { store, handle, goals, command, run, followups, changes }
}

/** The goal card DSH renders: title, status, an optional blocker, objective, rounds, activation, a gap, commands. */
function card(fields: {
  readonly title: string
  readonly phase: string
  readonly objective: string
  readonly rounds: string
  readonly activation: string
  readonly hint: string
  readonly blocker?: string
}): string {
  return [
    fields.title,
    `Status: ${fields.phase}`,
    ...(fields.blocker !== undefined ? [`Blocker: ${fields.blocker}`] : []),
    `Objective: ${fields.objective}`,
    `Rounds: ${fields.rounds}`,
    `Activation: ${fields.activation}`,
    '',
    `Commands: ${fields.hint}`,
  ].join('\n')
}

/** A result's text, whichever kind it is. */
function textOf(result: CommandResult): string {
  return result.text ?? ''
}

const image: ContentPart = { type: 'image', name: 'plan.png', mimeType: 'image/png', path: '/uploads/plan.png', bytes: 10, sha256: 'sha256:aa' }
const file: ContentPart = { type: 'file', name: 'spec.md', path: '/uploads/spec.md', bytes: 34, sha256: 'sha256:bb' }

// ---- registration and the parse ----

test('/goal registers with DSH name, description and input, attachments allowed', () => {
  const { command } = harness()
  assert.equal(command.name, 'goal')
  assert.equal(command.description, 'Set or view the goal for a long-running task')
  assert.deepEqual(command.input, { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true })
  assert.equal(command.recordInput, undefined, 'the objective is recorded in command/run')
  const registry = new CommandRegistry()
  registry.register(command)
  assert.deepEqual(registry.list(), [
    {
      name: 'goal',
      label: 'Goal',
      description: 'Set or view the goal for a long-running task',
      section: 'add',
      input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
    },
  ])
})

test('the parse: trimmed, empty shows, whole-word controls in any case, edit needs whitespace, the rest creates', () => {
  const cases: [string, ReturnType<typeof parseGoalCommand>][] = [
    ['', { kind: 'show' }],
    ['  \n\t ', { kind: 'show' }],
    ['clear', { kind: 'clear' }],
    [' CLEAR ', { kind: 'clear' }],
    ['Pause', { kind: 'pause' }],
    ['rEsUmE', { kind: 'resume' }],
    ['edit', { kind: 'invalid-edit' }],
    ['  EDIT  ', { kind: 'invalid-edit' }],
    ['edit ship it', { kind: 'edit', objective: 'ship it' }],
    ['Edit\t  ship   it  ', { kind: 'edit', objective: 'ship   it' }],
    ['\nedit\nship it', { kind: 'edit', objective: 'ship it' }],
    ['editorial pass', { kind: 'create', objective: 'editorial pass' }],
    ['edit:ship', { kind: 'create', objective: 'edit:ship' }],
    ['pause after verification', { kind: 'create', objective: 'pause after verification' }],
    ['clear the cache', { kind: 'create', objective: 'clear the cache' }],
    ['  ship the parity table  ', { kind: 'create', objective: 'ship the parity table' }],
    ['ship it 5', { kind: 'create', objective: 'ship it 5' }],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseGoalCommand(input), expected, JSON.stringify(input))
})

// ---- show ----

test('/goal with no goal says so and gives the usage', () => {
  const { run, changes } = harness()
  assert.deepEqual(run('/goal'), { kind: 'success', text: `No goal is currently set.\n${USAGE}` })
  assert.deepEqual(run('/goal   '), { kind: 'success', text: `No goal is currently set.\n${USAGE}` })
  assert.equal(changes(), 0)
})

test('/goal shows an active, armed goal with its rounds and the pause hint', () => {
  const { run, goals, handle, store } = harness()
  const goal = goals.create(handle, { objective: 'ship the parity table', maxGoalRounds: 5 })
  store.append(handle, {
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: '<goal_round>' }], source: { kind: 'goal', goalId: goal.id, revision: 1, round: 1 } },
  })
  assert.deepEqual(run('/goal'), {
    kind: 'success',
    text: card({ title: 'Goal', phase: 'active', objective: 'ship the parity table', rounds: '1/5', activation: 'armed', hint: HINT_ARMED }),
  })
})

test('/goal shows an active but disarmed goal with the resume hint', () => {
  const { run, goals, handle } = harness()
  goals.create(handle, { objective: 'o' })
  goals.disarm(handle)
  assert.deepEqual(run('/goal'), {
    kind: 'success',
    text: card({ title: 'Goal', phase: 'active', objective: 'o', rounds: '0/100', activation: 'disarmed', hint: HINT_STOPPED }),
  })
})

test('/goal shows a paused goal with the resume hint', () => {
  const { run, goals, handle } = harness()
  const goal = goals.create(handle, { objective: 'o' })
  goals.pause(handle, goal)
  assert.deepEqual(run('/goal'), {
    kind: 'success',
    text: card({ title: 'Goal', phase: 'paused', objective: 'o', rounds: '0/100', activation: 'disarmed', hint: HINT_STOPPED }),
  })
})

test('/goal shows a blocked goal with its Blocker line, code then message', () => {
  const { run, goals, handle } = harness()
  const goal = goals.create(handle, { objective: 'o' })
  goals.block(handle, goal, { code: 'model-reported', message: 'the API key is missing' })
  assert.deepEqual(run('/goal'), {
    kind: 'success',
    text: card({
      title: 'Goal',
      phase: 'blocked',
      blocker: 'model-reported: the API key is missing',
      objective: 'o',
      rounds: '0/100',
      activation: 'disarmed',
      hint: HINT_STOPPED,
    }),
  })
})

test('/goal shows a complete goal with the create hint', () => {
  const { run, goals, handle } = harness()
  const goal = goals.create(handle, { objective: 'o' })
  goals.complete(handle, goal)
  assert.deepEqual(run('/goal'), {
    kind: 'success',
    text: card({ title: 'Goal', phase: 'complete', objective: 'o', rounds: '0/100', activation: 'disarmed', hint: HINT_COMPLETE }),
  })
})

// ---- create ----

test('/goal <objective> creates the goal, armed at once, with the whole input as its objective', () => {
  const { run, goals, handle, changes } = harness()
  assert.deepEqual(run('/goal   ship the parity table  '), {
    kind: 'success',
    text: card({ title: 'Goal created', phase: 'active', objective: 'ship the parity table', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.equal(goals.get(handle)?.objective, 'ship the parity table')
  assert.equal(goals.get(handle)?.activation, 'armed')
  assert.equal(changes(), 1, 'one goal/change, written by the goal service')
})

test('/goal <objective> while a goal is active, paused or blocked is refused and changes nothing', () => {
  for (const phase of ['active', 'paused', 'blocked'] as const) {
    const { run, goals, handle, changes } = harness()
    const goal = goals.create(handle, { objective: 'first' })
    if (phase === 'paused') goals.pause(handle, goal)
    if (phase === 'blocked') goals.block(handle, goal, { code: 'model-reported', message: 'stuck' })
    const before = changes()
    assert.deepEqual(run('/goal second'), {
      kind: 'error',
      text: `A goal is already ${phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
    })
    assert.equal(changes(), before, phase)
    assert.equal(goals.get(handle)?.objective, 'first')
  }
})

test('/goal <objective> over a complete goal replaces it with a new, armed one', () => {
  const { run, goals, handle } = harness()
  const first = goals.create(handle, { objective: 'first' })
  goals.complete(handle, first)
  assert.deepEqual(run('/goal second'), {
    kind: 'success',
    text: card({ title: 'Goal created', phase: 'active', objective: 'second', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.notEqual(goals.get(handle)?.id, first.id)
})

test('/goal pause after verification is an objective, not a pause', () => {
  const { run, goals, handle } = harness()
  assert.deepEqual(run('/goal pause after verification'), {
    kind: 'success',
    text: card({ title: 'Goal created', phase: 'active', objective: 'pause after verification', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.equal(goals.get(handle)?.phase, 'active')
  assert.deepEqual(run('/goal clear the cache first'), {
    kind: 'error',
    text: 'A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.',
  })
  assert.equal(run('/goal editorial pass').kind, 'error', '"editorial" is not "edit": it is a create, refused while a goal is active')
})

// ---- edit ----

test('/goal edit <objective> replaces the objective and keeps the phase', () => {
  const { run, goals, handle } = harness()
  const goal = goals.create(handle, { objective: 'first' })
  assert.deepEqual(run('/goal edit   second  '), {
    kind: 'success',
    text: card({ title: 'Goal updated', phase: 'active', objective: 'second', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.equal(goals.get(handle)?.id, goal.id, 'the same goal, a new revision')
  assert.equal(goals.get(handle)?.revision, 2)
  goals.pause(handle, { id: goal.id, revision: 2 })
  assert.deepEqual(run('/goal edit third'), {
    kind: 'success',
    text: card({ title: 'Goal updated', phase: 'paused', objective: 'third', rounds: '0/100', activation: 'disarmed', hint: HINT_STOPPED }),
  })
})

test('/goal edit with no objective is refused, with or without a goal', () => {
  const { run, goals, handle, changes } = harness()
  const refusal = { kind: 'error', text: `Goal editing requires a replacement objective.\n${USAGE}` }
  assert.deepEqual(run('/goal edit'), refusal)
  goals.create(handle, { objective: 'o' })
  assert.deepEqual(run('/goal edit   '), refusal)
  assert.equal(changes(), 1)
})

test('/goal edit on a complete goal creates a new one', () => {
  const { run, goals, handle } = harness()
  const first = goals.create(handle, { objective: 'first' })
  goals.complete(handle, first)
  assert.deepEqual(run('/goal edit second'), {
    kind: 'success',
    text: card({ title: 'Goal created', phase: 'active', objective: 'second', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.notEqual(goals.get(handle)?.id, first.id)
  assert.equal(goals.get(handle)?.revision, 1)
})

// ---- pause, resume, clear ----

test('/goal pause pauses the goal and disarms it', () => {
  const { run, goals, handle } = harness()
  goals.create(handle, { objective: 'o' })
  assert.deepEqual(run('/goal pause'), {
    kind: 'success',
    text: card({ title: 'Goal paused', phase: 'paused', objective: 'o', rounds: '0/100', activation: 'disarmed', hint: HINT_STOPPED }),
  })
  assert.equal(goals.get(handle)?.phase, 'paused')
})

test('/goal resume needs no authority: it resumes a paused goal, a disarmed one and a blocked one, and arms it', () => {
  const resumed = card({ title: 'Goal resumed', phase: 'active', objective: 'o', rounds: '0/100', activation: 'armed', hint: HINT_ARMED })

  const paused = harness()
  paused.goals.pause(paused.handle, paused.goals.create(paused.handle, { objective: 'o' }))
  assert.deepEqual(paused.run('/goal resume'), { kind: 'success', text: resumed }, 'a person resumes what a person paused')

  const disarmed = harness()
  disarmed.goals.create(disarmed.handle, { objective: 'o' })
  disarmed.goals.disarm(disarmed.handle)
  assert.deepEqual(disarmed.run('/goal resume'), { kind: 'success', text: resumed })

  const blocked = harness()
  blocked.goals.block(blocked.handle, blocked.goals.create(blocked.handle, { objective: 'o' }), { code: 'model-reported', message: 'stuck' })
  assert.deepEqual(blocked.run('/goal resume'), { kind: 'success', text: resumed }, 'resuming drops the Blocker line')
  assert.equal(blocked.goals.get(blocked.handle)?.blockedReason, undefined)
})

test('/goal clear clears the goal; with none it says there is nothing to clear and writes nothing', () => {
  const { run, goals, handle, changes } = harness()
  assert.deepEqual(run('/goal clear'), { kind: 'success', text: 'No goal to clear.' })
  assert.equal(changes(), 0)
  goals.create(handle, { objective: 'o' })
  assert.deepEqual(run('/goal clear'), { kind: 'success', text: 'Goal cleared.' })
  assert.equal(goals.get(handle), undefined)
  assert.equal(changes(), 2, 'the create and the clear tombstone')
})

test('edit, pause and resume with no goal name the action, then a space, then the usage', () => {
  const { run, changes } = harness()
  assert.deepEqual(run('/goal edit ship it'), { kind: 'error', text: `No goal is currently set; /goal edit requires one. ${USAGE}` })
  assert.deepEqual(run('/goal pause'), { kind: 'error', text: `No goal is currently set; /goal pause requires one. ${USAGE}` })
  assert.deepEqual(run('/goal resume'), { kind: 'error', text: `No goal is currently set; /goal resume requires one. ${USAGE}` })
  assert.equal(changes(), 0)
})

test('the controls are case-insensitive', () => {
  const { run, goals, handle } = harness()
  goals.create(handle, { objective: 'o' })
  assert.match(textOf(run('/goal PAUSE')), /^Goal paused\nStatus: paused\n/)
  assert.match(textOf(run('/goal Resume')), /^Goal resumed\nStatus: active\n/)
  assert.match(textOf(run('/goal EDIT second')), /^Goal updated\nStatus: active\nObjective: second\n/)
  assert.deepEqual(run('/goal Edit'), { kind: 'error', text: `Goal editing requires a replacement objective.\n${USAGE}` })
  assert.deepEqual(run('/goal CLEAR'), { kind: 'success', text: 'Goal cleared.' })
  assert.equal(goals.get(handle), undefined)
})

// ---- the goal service's refusals ----

test("every refusal from the goal service is DSH's one generic sentence", () => {
  // GOAL_INVALID_TRANSITION: resuming a goal that is already active and armed.
  const armed = harness()
  armed.goals.create(armed.handle, { objective: 'o' })
  assert.deepEqual(armed.run('/goal resume'), { kind: 'error', text: STATE_ERROR })

  // GOAL_INVALID_TRANSITION: pausing a paused goal, and pausing a blocked one.
  const paused = harness()
  paused.goals.pause(paused.handle, paused.goals.create(paused.handle, { objective: 'o' }))
  assert.deepEqual(paused.run('/goal pause'), { kind: 'error', text: STATE_ERROR })
  const blocked = harness()
  blocked.goals.block(blocked.handle, blocked.goals.create(blocked.handle, { objective: 'o' }), { code: 'model-reported', message: 'stuck' })
  assert.deepEqual(blocked.run('/goal pause'), { kind: 'error', text: STATE_ERROR })

  // GOAL_INVALID_TRANSITION: resuming a goal whose round cap is spent.
  const spent = harness()
  const goal = spent.goals.create(spent.handle, { objective: 'o', maxGoalRounds: 1 })
  spent.store.append(spent.handle, {
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: '<goal_round>' }], source: { kind: 'goal', goalId: goal.id, revision: 1, round: 1 } },
  })
  spent.goals.pause(spent.handle, goal)
  assert.deepEqual(spent.run('/goal resume'), { kind: 'error', text: STATE_ERROR })

  // GOAL_INVALID_OBJECTIVE: an objective over the service's limit.
  const long = harness()
  assert.deepEqual(long.run(`/goal ${'x'.repeat(8001)}`), { kind: 'error', text: STATE_ERROR })
  assert.equal(long.changes(), 0)
})

test('a stale read and a vanished goal are the generic sentence too (GOAL_STALE_REVISION, GOAL_NOT_FOUND)', () => {
  const stale = harness({
    host: (goals) => ({
      ...hostOf(goals),
      get: (handle) => {
        const goal = goals.get(handle)
        return goal === undefined ? undefined : { ...goal, revision: goal.revision - 1 }
      },
    }),
  })
  const goal = stale.goals.create(stale.handle, { objective: 'o' })
  stale.goals.edit(stale.handle, goal, { objective: 'p' })
  for (const line of ['/goal pause', '/goal edit q', '/goal clear']) {
    assert.deepEqual(stale.run(line), { kind: 'error', text: STATE_ERROR }, line)
  }

  const vanished = harness({
    host: (goals) => ({
      ...hostOf(goals),
      get: (handle) => {
        const current = goals.get(handle)
        return current === undefined ? undefined : { ...current, id: 'goal-someone-else' }
      },
    }),
  })
  vanished.goals.create(vanished.handle, { objective: 'o' })
  assert.deepEqual(vanished.run('/goal pause'), { kind: 'error', text: STATE_ERROR })
})

test('a GoalError from another copy of the goal module is recognised; any other error is thrown on', async () => {
  const foreign = harness({
    host: (goals) => ({
      ...hostOf(goals),
      get: () => {
        throw Object.assign(new Error('stale goal ref'), { name: 'GoalError', code: 'GOAL_STALE_REVISION' })
      },
    }),
  })
  assert.deepEqual(foreign.run('/goal'), { kind: 'error', text: STATE_ERROR })

  const broken = harness({
    host: (goals) => ({
      ...hostOf(goals),
      get: () => {
        throw new Error('the goal service is not loaded in this profile')
      },
    }),
  })
  assert.throws(() => broken.run('/goal'), /the goal service is not loaded in this profile/)
  const registry = new CommandRegistry()
  registry.register(broken.command)
  const log: CommandLog = { append: (handle, event) => broken.store.append(handle, event) }
  assert.deepEqual((await registry.execute(log, broken.handle, '/goal pause'))?.result, {
    kind: 'error',
    text: 'the goal service is not loaded in this profile',
  })
})

// ---- attachments ----

test('attachments on a form that sets no objective are refused before anything is read or written', () => {
  const { run, goals, handle, changes, followups } = harness()
  for (const line of ['/goal', '/goal clear', '/goal pause', '/goal resume', '/goal edit', '/goal EDIT  ']) {
    assert.deepEqual(run(line, [file]), { kind: 'error', text: ATTACHMENTS_REFUSED }, `${line} with no goal`)
  }
  goals.create(handle, { objective: 'o' })
  for (const line of ['/goal', '/goal clear', '/goal Pause', '/goal resume']) {
    assert.deepEqual(run(line, [image, file]), { kind: 'error', text: ATTACHMENTS_REFUSED }, `${line} with a goal`)
  }
  assert.equal(goals.get(handle)?.phase, 'active', 'the refused pause did not pause')
  assert.equal(changes(), 1)
  assert.deepEqual(followups, [])
  assert.deepEqual(run('/goal', []), {
    kind: 'success',
    text: card({ title: 'Goal', phase: 'active', objective: 'o', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  }, 'an empty list is no attachments')
})

test('attachments on a create go on, after the goal is set, as one follow-up message from the person', () => {
  const { run, goals, handle, followups } = harness()
  assert.deepEqual(run('/goal ship the parity table', [image, file]), {
    kind: 'success',
    text: card({ title: 'Goal created', phase: 'active', objective: 'ship the parity table', rounds: '0/100', activation: 'armed', hint: HINT_ARMED }),
  })
  assert.equal(goals.get(handle)?.objective, 'ship the parity table', 'the objective is the text alone')
  assert.deepEqual(followups, [
    {
      session: handle,
      message: {
        role: 'user',
        content: [image, file, { type: 'text', text: 'Reference attachments for the goal objective.' }],
        source: { kind: 'user' },
      },
    },
  ])
})

test('attachments on an edit, and on an edit that replaces a complete goal, follow up the same way', () => {
  const { run, goals, handle, followups } = harness()
  const goal = goals.create(handle, { objective: 'first' })
  assert.match(textOf(run('/goal edit second', [file])), /^Goal updated\n/)
  goals.complete(handle, { id: goal.id, revision: 2 })
  assert.match(textOf(run('/goal edit third', [image])), /^Goal created\n/)
  assert.deepEqual(
    followups.map((entry) => entry.message.content),
    [
      [file, { type: 'text', text: 'Reference attachments for the goal objective.' }],
      [image, { type: 'text', text: 'Reference attachments for the goal objective.' }],
    ],
  )
})

test('no follow-up without attachments, or when the create or edit itself is refused', () => {
  const { run, followups } = harness()
  run('/goal first')
  run('/goal edit second')
  assert.deepEqual(followups, [], 'no attachments, no message')
  assert.equal(run('/goal another', [file]).kind, 'error', 'a goal is already active')
  const stale = harness({
    host: (inner) => ({
      ...hostOf(inner),
      get: (session) => {
        const current = inner.get(session)
        return current === undefined ? undefined : { ...current, revision: current.revision + 1 }
      },
    }),
  })
  stale.goals.create(stale.handle, { objective: 'o' })
  assert.deepEqual(stale.run('/goal edit p', [file]), { kind: 'error', text: STATE_ERROR })
  assert.deepEqual([...followups, ...stale.followups], [], 'a refused change carries nothing on')
})

test('without a follow-up sink a create with attachments still sets the goal (the layer delivers nothing yet)', () => {
  const { run, goals, handle } = harness({ sink: false })
  assert.match(textOf(run('/goal ship it', [file])), /^Goal created\n/)
  assert.equal(goals.get(handle)?.objective, 'ship it')
})
