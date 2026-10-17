import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addMember,
  applyTaskAction,
  createTask,
  emptyTeamState,
  foldTeam,
  isReady,
  markDelivered,
  queueMessage,
  resolveMember,
  taskView,
  TeamError,
  type TeamMessageSnapshot,
  type TeamState,
  type TeamTaskSnapshot,
} from '../src/team/state.ts'
import type { SessionEvent } from '../src/session/store.ts'

/**
 * The team's durable state: the fold, the member lifecycle, the task board's compare-and-set, and the mailbox's
 * delivery ledger. These are the claims the rest of the team layer will stand on, so they are tested with the
 * event sequences DSH's journal writes, including the ones that must be **refused**.
 */

const LEAD = 'session-lead'
const A = 'session-a'
const B = 'session-b'

const event = (fields: Record<string, unknown>): SessionEvent => ({ seq: 0, at: '', type: String(fields.type), ...fields })

function team(): TeamState {
  return emptyTeamState(LEAD)
}

function withMember(state: TeamState, id = A, name = 'alpha'): TeamState {
  return addMember({ ...state, members: state.members }, {
    id,
    name,
    description: 'a test teammate',
    context: 'fresh',
    phase: 'provisioning',
  })
}

function withActiveMember(state: TeamState, id = A, name = 'alpha'): TeamState {
  return addMember(withMember(state, id, name), {
    id,
    name,
    description: 'a test teammate',
    context: 'fresh',
    phase: 'active',
  })
}

const task = (state: TeamState): TeamTaskSnapshot => state.tasks[0] as TeamTaskSnapshot

const memberEvent = (fields: Record<string, unknown>) => event({ type: 'team/member', version: 2, teamId: LEAD, ...fields })

test('an empty team folds to empty state, and non-team events are not its business', () => {
  const state = foldTeam([event({ type: 'message', message: { role: 'user' } }), event({ type: 'turn/completed' })], LEAD)
  assert.deepEqual(state, emptyTeamState(LEAD))
})

test('a member starts provisioning and settles once; a settled member cannot change again', () => {
  let state = withActiveMember(team())
  assert.equal(state.members[0]?.phase, 'active')

  assert.throws(
    () => addMember(state, { id: A, name: 'alpha', description: 'x', context: 'fresh', phase: 'failed', error: 'boom' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_PHASE',
  )
  // A member that never provisioned cannot appear directly active.
  assert.throws(
    () => addMember(team(), { id: B, name: 'beta', description: 'x', context: 'fresh', phase: 'active' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_PHASE',
  )
})

test('a member snapshot whose phase and error disagree is refused, as is a duplicate name', () => {
  assert.throws(
    () => addMember(team(), { id: A, name: 'alpha', description: 'x', context: 'fresh', phase: 'failed' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_INVALID',
  )
  assert.throws(
    () => addMember(team(), { id: A, name: 'alpha', description: 'x', context: 'fresh', phase: 'active', error: 'boom' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_INVALID',
  )
  const state = withActiveMember(team())
  assert.throws(
    () => addMember(state, { id: B, name: 'alpha', description: 'x', context: 'fresh', phase: 'provisioning' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MEMBER_DUPLICATE',
  )
})

test('fold refuses a foreign team, an unsupported version and a delivery for a message it never saw', () => {
  const foreign = memberEvent({ teamId: 'session-other', member: { id: A, name: 'alpha', description: 'x', context: 'fresh', phase: 'provisioning' } })
  assert.throws(
    () => foldTeam([foreign], LEAD),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_FOREIGN',
  )
  assert.throws(
    () => foldTeam([{ ...foreign, teamId: LEAD, version: 3 }], LEAD),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => foldTeam([event({ type: 'team/message/delivered', version: 2, teamId: LEAD, messageId: 'team-message-1', targetId: A })], LEAD),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_MESSAGE_UNKNOWN',
  )
})

test('the fold replays a member, a task, a queued message and its delivery', () => {
  let state = withActiveMember(team())
  const created = createTask(state, { subject: 'do the thing', description: 'detail' })
  state = created.state
  const message: TeamMessageSnapshot = { id: 'team-message-1', senderId: LEAD, senderName: 'lead', targetId: A, content: [{ type: 'text', text: 'go' }] }
  state = queueMessage(state, message)
  state = markDelivered(state, message.id, A)

  const events: SessionEvent[] = [
    memberEvent({ member: { id: A, name: 'alpha', description: 'a test teammate', context: 'fresh', phase: 'provisioning' } }),
    memberEvent({ member: { id: A, name: 'alpha', description: 'a test teammate', context: 'fresh', phase: 'active' } }),
    event({ type: 'team/task', version: 2, teamId: LEAD, task: created.task }),
    event({ type: 'team/message/queued', version: 2, teamId: LEAD, message }),
    event({ type: 'team/message/delivered', version: 2, teamId: LEAD, messageId: message.id, targetId: A }),
  ]
  assert.deepEqual(foldTeam(events, LEAD), state)
  assert.deepEqual(state.delivered, [message.id])
})

test('the task board is compare-and-set: a stale revision, a blocked claim and a double completion are refused', () => {
  let state = withActiveMember(team())
  const first = createTask(state, { subject: 'one' })
  state = first.state
  const second = createTask(state, { subject: 'two', blockedBy: [first.task.id] })
  state = second.state
  assert.equal(second.task.id, 'task-2')
  assert.equal(isReady(state, second.task), false, 'a blocked task is not ready')
  assert.equal(isReady(state, first.task), true)

  assert.throws(
    () => applyTaskAction(state, { callerId: A, taskId: second.task.id, revision: 1, action: 'claim' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_BLOCKED',
  )
  const claimed = applyTaskAction(state, { callerId: A, taskId: first.task.id, revision: 1, action: 'claim' })
  state = claimed.state
  assert.equal(claimed.task.status, 'in_progress')
  assert.equal(claimed.task.ownerId, A)
  assert.equal(claimed.task.revision, 2)

  assert.throws(
    () => applyTaskAction(state, { callerId: A, taskId: first.task.id, revision: 1, action: 'complete' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_STALE',
  )
  assert.throws(
    () => applyTaskAction(state, { callerId: A, taskId: second.task.id, revision: 1, action: 'complete' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_STATUS',
  )
  const completed = applyTaskAction(state, { callerId: A, taskId: first.task.id, revision: 2, action: 'complete' })
  state = completed.state
  assert.equal(completed.task.status, 'completed')
  assert.equal(isReady(state, second.task), true, 'completing the blocker made the dependent ready')
})

test('a teammate cannot touch another member’s claimed task, and only the Lead may reassign', () => {
  let state = withActiveMember(team())
  state = withActiveMember(state, B, 'beta')
  let created = createTask(state, { subject: 'shared' })
  state = created.state
  state = applyTaskAction(state, { callerId: A, taskId: created.task.id, revision: 1, action: 'claim' }).state

  assert.throws(
    () => applyTaskAction(state, { callerId: B, taskId: created.task.id, revision: 2, action: 'complete' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_STATUS',
  )
  assert.throws(
    () => applyTaskAction(state, { callerId: A, taskId: created.task.id, revision: 2, action: 'reassign', ownerId: B }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LEAD_REQUIRED',
  )
  const reassigned = applyTaskAction(state, { callerId: LEAD, taskId: created.task.id, revision: 2, action: 'reassign', ownerId: B })
  assert.equal(reassigned.task.ownerId, B)
  assert.equal(reassigned.task.status, 'in_progress')
})

test('task statuses move through release, reopen and delete, and a deleted task clears its owner', () => {
  let state = withActiveMember(team())
  let created = createTask(state, { subject: 'lifecycle' })
  state = created.state
  state = applyTaskAction(state, { callerId: A, taskId: created.task.id, revision: 1, action: 'claim' }).state
  const released = applyTaskAction(state, { callerId: A, taskId: created.task.id, revision: 2, action: 'release' })
  assert.equal(released.task.status, 'pending')
  assert.equal(released.task.ownerId, undefined)
  const deleted = applyTaskAction(released.state, { callerId: A, taskId: created.task.id, revision: 3, action: 'delete' })
  assert.equal(deleted.task.status, 'deleted')
  assert.equal(deleted.task.ownerId, undefined)

  // A deleted or completed task can be reopened; a pending one has nothing to reopen.
  assert.throws(
    () => applyTaskAction(released.state, { callerId: A, taskId: created.task.id, revision: 3, action: 'reopen' }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_STATUS',
  )
  const reopened = applyTaskAction(deleted.state, { callerId: A, taskId: created.task.id, revision: 4, action: 'reopen' })
  assert.equal(reopened.task.status, 'pending')
  const claimedAgain = applyTaskAction(reopened.state, { callerId: A, taskId: created.task.id, revision: 5, action: 'claim' })
  const completed = applyTaskAction(claimedAgain.state, { callerId: A, taskId: created.task.id, revision: 6, action: 'complete' })
  assert.equal(completed.task.status, 'completed')
  assert.equal(completed.task.ownerId, A, 'a completed task keeps who did it')
})

test('a blocker cycle is refused, and a cycle cannot be introduced by set_dependencies', () => {
  let state = withActiveMember(team())
  const one = createTask(state, { subject: 'one' })
  state = one.state
  const two = createTask(state, { subject: 'two', blockedBy: [one.task.id] })
  state = two.state
  assert.throws(
    () => createTask(state, { subject: 'three', blockedBy: ['task-404'] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_INVALID',
  )
  assert.throws(
    () => applyTaskAction(state, { callerId: LEAD, taskId: one.task.id, revision: 1, action: 'set_dependencies', blockedBy: [two.task.id] }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_TASK_CYCLE',
  )
})

test('the view names the owner, reports readiness, and warns about overlapping advisory write scopes', () => {
  let state = withActiveMember(team())
  let created = createTask(state, { subject: 'one', writeScopes: ['src/team'] })
  state = created.state
  created = createTask(state, { subject: 'two', writeScopes: ['src/team'] })
  state = created.state
  state = applyTaskAction(state, { callerId: A, taskId: 'task-1', revision: 1, action: 'claim' }).state
  const view = taskView(state, task(state))
  assert.equal(view.ownerName, 'alpha')
  assert.equal(view.ready, false)
  const warnings = taskView(state, state.tasks[1] as TeamTaskSnapshot).writeScopeWarnings
  assert.deepEqual(warnings, ['src/team is also written by task-1'])
})

test('membership resolution addresses the Lead by name and refuses an inactive teammate', () => {
  let state = withActiveMember(team())
  assert.deepEqual(resolveMember(state, 'lead'), { id: LEAD, name: 'lead', phase: 'active' })
  assert.equal(resolveMember(state, 'alpha')?.id, A)
  assert.equal(resolveMember(state, 'nobody'), undefined)
  state = addMember(state, { id: B, name: 'beta', description: 'x', context: 'fresh', phase: 'provisioning' })
  assert.equal(resolveMember(state, 'beta'), undefined, 'a provisioning member is not addressable yet')
})

test('member and task caps are refusals with their own codes', () => {
  const state = withActiveMember(team())
  assert.throws(
    () => addMember(state, { id: B, name: 'beta', description: 'x', context: 'fresh', phase: 'provisioning' }, { maxMembers: 1 }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LIMIT',
  )
  assert.throws(
    () => createTask(state, { subject: 'x' }, { maxTasks: 0 }),
    (error: unknown) => error instanceof TeamError && error.code === 'TEAM_LIMIT',
  )
})
