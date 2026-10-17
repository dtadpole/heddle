import type { ContentPart } from '../llm/types.ts'
import type { SessionEvent, SessionId } from '../session/store.ts'

/**
 * The team's durable state, folded from the **Lead session's** log.
 *
 * Modelled on DSH's Agent Teams layer (see
 * [`_context_/dsh-mechanisms/dsh-agent-teams.md`](../../_context_/dsh-mechanisms/dsh-agent-teams.md)): the team
 * belongs to the Lead's session, teammates are sessions of their own, and everything the team shares — members,
 * tasks, queued and delivered messages — is an event in that one log. This file is deliberately pure: no
 * service, no model, no filesystem. The log is the truth and the fold is the only reader, which is what makes
 * the state restartable and testable without a turn.
 *
 * Strictness is the contract: a snapshot whose phase and error disagree, a task revision that skips a step, a
 * message delivered twice, or a task graph with a cycle fails the fold loudly instead of producing a state that
 * silently means something else.
 */

export const TEAM_EVENT_VERSION = 2

export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'
export type TeamMemberContext = 'fresh' | 'fork'
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly context: TeamMemberContext
  readonly phase: TeamMemberPhase
  readonly error?: string
}

export interface TeamTaskSnapshot {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: readonly string[]
  readonly writeScopes: readonly string[]
}

export interface TeamMessageSnapshot {
  readonly id: string
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: readonly ContentPart[]
}

export interface TeamState {
  readonly id: SessionId
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly messages: readonly TeamMessageSnapshot[]
  readonly delivered: readonly string[]
  readonly nextTaskNumber: number
}

/** A task as a reader sees it: ownership by name, readiness, and advisory scope warnings. */
export interface TeamTaskView {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerName?: string
  readonly blockedBy: readonly string[]
  readonly writeScopes: readonly string[]
  readonly ready: boolean
  readonly writeScopeWarnings: readonly string[]
}

export type TeamErrorCode =
  | 'TEAM_VERSION_UNSUPPORTED'
  | 'TEAM_FOREIGN'
  | 'TEAM_INVALID_EVENT'
  | 'TEAM_MEMBER_INVALID'
  | 'TEAM_MEMBER_DUPLICATE'
  | 'TEAM_MEMBER_PHASE'
  | 'TEAM_TASK_INVALID'
  | 'TEAM_TASK_MISSING'
  | 'TEAM_TASK_REVISION'
  | 'TEAM_TASK_STALE'
  | 'TEAM_TASK_BLOCKED'
  | 'TEAM_TASK_STATUS'
  | 'TEAM_TASK_CYCLE'
  | 'TEAM_MESSAGE_INVALID'
  | 'TEAM_MESSAGE_UNKNOWN'
  | 'TEAM_MESSAGE_DELIVERED'
  | 'TEAM_LIMIT'
  | 'TEAM_LEAD_REQUIRED'
  | 'TEAM_UNAVAILABLE'
  | 'TEAM_MAILBOX_FULL'
  | 'TEAM_MESSAGE_TOO_LARGE'
  | 'TEAM_SELF_MESSAGE'

export class TeamError extends Error {
  readonly code: TeamErrorCode

  constructor(message: string, code: TeamErrorCode) {
    super(message)
    this.name = 'TeamError'
    this.code = code
  }
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const TASK_ID = /^task-([1-9][0-9]*)$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isText = (value: unknown): value is string => typeof value === 'string'
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText)

export function emptyTeamState(lead: SessionId): TeamState {
  return { id: lead, members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 }
}

/** The team's events, in log order. Anything that is not a team event is not the team's business. */
export function teamEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.type.startsWith('team/'))
}

/**
 * Fold the Lead session's log into the team state.
 *
 * Every team event carries the `teamId` it belongs to and the record version; both are checked against the
 * session being folded, so a copied or foreign event cannot be adopted silently.
 */
export function foldTeam(events: readonly SessionEvent[], lead: SessionId): TeamState {
  let state = emptyTeamState(lead)
  for (const event of teamEvents(events)) {
    if (event.version !== TEAM_EVENT_VERSION) {
      throw new TeamError(`team event version ${String(event.version)} is not ${TEAM_EVENT_VERSION}`, 'TEAM_VERSION_UNSUPPORTED')
    }
    if (event.teamId !== lead) {
      throw new TeamError(`team event names team '${String(event.teamId)}', not this session '${lead}'`, 'TEAM_FOREIGN')
    }
    switch (event.type) {
      case 'team/member':
        state = addMember(state, event.member as TeamMemberSnapshot)
        break
      case 'team/task':
        state = addTaskSnapshot(state, event.task as TeamTaskSnapshot)
        break
      case 'team/message/queued':
        state = queueMessage(state, event.message as TeamMessageSnapshot)
        break
      case 'team/message/delivered':
        state = markDelivered(state, String(event.messageId), String(event.targetId))
        break
      default:
        throw new TeamError(`unknown team event '${event.type}'`, 'TEAM_INVALID_EVENT')
    }
  }
  return state
}

/** Record one member snapshot, validating the lifecycle it describes. */
export function addMember(state: TeamState, member: TeamMemberSnapshot, limits: { readonly maxMembers?: number } = {}): TeamState {
  if (!isRecord(member) || !isText(member.id) || member.id.length === 0 || member.id === state.id) {
    throw new TeamError('a member needs its own session id, not the Lead session', 'TEAM_MEMBER_INVALID')
  }
  if (!isText(member.name) || !KEBAB.test(member.name)) {
    throw new TeamError(`a member name must be lower-kebab-case, saw '${String(member.name)}'`, 'TEAM_MEMBER_INVALID')
  }
  if (!isText(member.description) || member.description.trim().length === 0) {
    throw new TeamError(`member '${member.name}' needs a description`, 'TEAM_MEMBER_INVALID')
  }
  if (member.context !== 'fresh' && member.context !== 'fork') {
    throw new TeamError(`member '${member.name}' has context '${String(member.context)}'`, 'TEAM_MEMBER_INVALID')
  }
  if (member.phase !== 'provisioning' && member.phase !== 'active' && member.phase !== 'failed') {
    throw new TeamError(`member '${member.name}' has phase '${String(member.phase)}'`, 'TEAM_MEMBER_INVALID')
  }
  if (member.phase === 'failed' ? !isText(member.error) || member.error.length === 0 : member.error !== undefined) {
    throw new TeamError(`member '${member.name}' has a phase and error that disagree`, 'TEAM_MEMBER_INVALID')
  }

  const existing = state.members.find((one) => one.id === member.id)
  if (existing !== undefined && existing.name !== member.name) {
    throw new TeamError(`member session ${member.id} was '${existing.name}' and became '${member.name}'`, 'TEAM_MEMBER_INVALID')
  }
  if (existing === undefined) {
    if (member.phase !== 'provisioning') {
      throw new TeamError(`member '${member.name}' must start provisioning`, 'TEAM_MEMBER_PHASE')
    }
    if (state.members.some((one) => one.name === member.name)) {
      throw new TeamError(`a member named '${member.name}' already exists`, 'TEAM_MEMBER_DUPLICATE')
    }
    const maxMembers = limits.maxMembers ?? 8
    if (state.members.length >= maxMembers) {
      throw new TeamError(`the team already has ${state.members.length} members; maxMembers is ${maxMembers}`, 'TEAM_LIMIT')
    }
    return { ...state, members: [...state.members, member] }
  }
  if (existing.phase !== 'provisioning') {
    throw new TeamError(`member '${member.name}' is already ${existing.phase} and cannot change again`, 'TEAM_MEMBER_PHASE')
  }
  if (member.phase === 'provisioning') {
    throw new TeamError(`member '${member.name}' is already provisioning`, 'TEAM_MEMBER_PHASE')
  }
  return { ...state, members: state.members.map((one) => (one.id === member.id ? member : one)) }
}

/** Apply one queued message, validating sender, target and content. */
export function queueMessage(state: TeamState, message: TeamMessageSnapshot): TeamState {
  if (!isRecord(message) || !isText(message.id) || message.id.length === 0) {
    throw new TeamError('a queued message needs an id', 'TEAM_MESSAGE_INVALID')
  }
  if (state.messages.some((one) => one.id === message.id)) {
    throw new TeamError(`message '${message.id}' was queued twice`, 'TEAM_MESSAGE_INVALID')
  }
  const sender = message.senderId === state.id ? undefined : memberById(state, message.senderId)
  if (message.senderId !== state.id && (sender === undefined || sender.phase !== 'active')) {
    throw new TeamError(`message '${message.id}' has an unknown or inactive sender`, 'TEAM_MESSAGE_INVALID')
  }
  /**
   * The target may still be provisioning: mail to it waits in the durable queue and is delivered once
   * `recover` (or the spawn's own activation) settles the member. A failed target is refused, because nothing
   * will ever take that mail.
   */
  const target = message.targetId === state.id ? undefined : memberById(state, message.targetId)
  if (message.targetId !== state.id && (target === undefined || target.phase === 'failed')) {
    throw new TeamError(`message '${message.id}' has an unknown or failed target`, 'TEAM_MESSAGE_INVALID')
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new TeamError(`message '${message.id}' has no content`, 'TEAM_MESSAGE_INVALID')
  }
  if (!isText(message.senderName) || !KEBAB.test(message.senderName)) {
    throw new TeamError(`message '${message.id}' needs a lower-kebab-case sender name`, 'TEAM_MESSAGE_INVALID')
  }
  return { ...state, messages: [...state.messages, message] }
}

/** Record that the target's own log accepted the message. Idempotent by construction: the fold refuses a repeat. */
export function markDelivered(state: TeamState, messageId: string, targetId: string): TeamState {
  const message = state.messages.find((one) => one.id === messageId)
  if (message === undefined) {
    throw new TeamError(`delivery of unknown message '${messageId}'`, 'TEAM_MESSAGE_UNKNOWN')
  }
  if (message.targetId !== targetId) {
    throw new TeamError(`message '${messageId}' targets ${message.targetId}, not ${targetId}`, 'TEAM_MESSAGE_INVALID')
  }
  if (state.delivered.includes(messageId)) {
    throw new TeamError(`message '${messageId}' was delivered twice`, 'TEAM_MESSAGE_DELIVERED')
  }
  return { ...state, delivered: [...state.delivered, messageId] }
}

/** Record one complete task snapshot, checking revision continuity and graph validity. */
export function addTaskSnapshot(state: TeamState, task: TeamTaskSnapshot): TeamState {
  assertTaskSnapshot(task)
  const existing = state.tasks.find((one) => one.id === task.id)
  if (existing === undefined) {
    const expected = `task-${state.nextTaskNumber}`
    if (task.id !== expected) throw new TeamError(`new task '${task.id}' must be '${expected}'`, 'TEAM_TASK_INVALID')
    if (task.revision !== 1) throw new TeamError(`new task '${task.id}' must be revision 1`, 'TEAM_TASK_REVISION')
  } else if (task.revision !== existing.revision + 1) {
    throw new TeamError(`task '${task.id}' revision ${task.revision} does not follow ${existing.revision}`, 'TEAM_TASK_REVISION')
  }
  const next = state.tasks.some((one) => one.id === task.id) ? state.tasks.map((one) => (one.id === task.id ? task : one)) : [...state.tasks, task]
  assertTaskGraph(next)
  const number = Math.max(state.nextTaskNumber, Number(TASK_ID.exec(task.id)?.[1] ?? 0) + 1)
  return { ...state, tasks: next, nextTaskNumber: number }
}

function assertTaskSnapshot(task: TeamTaskSnapshot): void {
  if (!isRecord(task) || !isText(task.id) || !TASK_ID.test(task.id)) {
    throw new TeamError(`a task needs a 'task-<n>' id, saw '${String(isRecord(task) ? task.id : task)}'`, 'TEAM_TASK_INVALID')
  }
  if (!isText(task.subject) || task.subject.trim().length === 0) {
    throw new TeamError(`task '${task.id}' needs a subject`, 'TEAM_TASK_INVALID')
  }
  if (!isText(task.description)) {
    throw new TeamError(`task '${task.id}' needs a description field`, 'TEAM_TASK_INVALID')
  }
  if (!['pending', 'in_progress', 'completed', 'deleted'].includes(task.status)) {
    throw new TeamError(`task '${task.id}' has status '${String(task.status)}'`, 'TEAM_TASK_INVALID')
  }
  if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
    throw new TeamError(`task '${task.id}' has revision ${String(task.revision)}`, 'TEAM_TASK_INVALID')
  }
  /**
   * Ownership is part of the status: work in progress must have an owner, and a pending or deleted task must
   * not. A completed task keeps its owner, because "who did it" is worth reading afterwards.
   */
  if (task.status === 'in_progress' && (!isText(task.ownerId) || task.ownerId.length === 0)) {
    throw new TeamError(`task '${task.id}' is in progress without an owner`, 'TEAM_TASK_INVALID')
  }
  if ((task.status === 'pending' || task.status === 'deleted') && task.ownerId !== undefined) {
    throw new TeamError(`task '${task.id}' is ${task.status} but still owned`, 'TEAM_TASK_INVALID')
  }
  if (!isStringArray(task.blockedBy) || new Set(task.blockedBy).size !== task.blockedBy.length) {
    throw new TeamError(`task '${task.id}' has a malformed blocker list`, 'TEAM_TASK_INVALID')
  }
  if (task.blockedBy.includes(task.id)) {
    throw new TeamError(`task '${task.id}' blocks itself`, 'TEAM_TASK_CYCLE')
  }
  if (!isStringArray(task.writeScopes)) {
    throw new TeamError(`task '${task.id}' has malformed write scopes`, 'TEAM_TASK_INVALID')
  }
}

/** Refuse a task graph that is missing a blocker, names a duplicate, or contains a cycle. */
export function assertTaskGraph(tasks: readonly TeamTaskSnapshot[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): void => {
    if (done.has(id)) return
    if (visiting.has(id)) throw new TeamError(`task '${id}' is part of a blocker cycle`, 'TEAM_TASK_CYCLE')
    const task = byId.get(id)
    if (task === undefined) throw new TeamError(`task '${id}' is named as a blocker but does not exist`, 'TEAM_TASK_INVALID')
    visiting.add(id)
    for (const blocker of task.blockedBy) visit(blocker)
    visiting.delete(id)
    done.add(id)
  }
  for (const task of tasks) visit(task.id)
}

/** Create a task, taking the next id. The board is the Lead's shared work list, so ids are sequential. */
export function createTask(
  state: TeamState,
  input: { readonly subject: string; readonly description?: string; readonly blockedBy?: readonly string[]; readonly writeScopes?: readonly string[] },
  limits: { readonly maxTasks?: number } = {},
): { readonly state: TeamState; readonly task: TeamTaskSnapshot } {
  const maxTasks = limits.maxTasks ?? 256
  const live = state.tasks.filter((task) => task.status !== 'deleted').length
  if (live >= maxTasks) throw new TeamError(`the board already has ${live} live tasks; maxTasks is ${maxTasks}`, 'TEAM_LIMIT')
  const task: TeamTaskSnapshot = {
    id: `task-${state.nextTaskNumber}`,
    revision: 1,
    subject: input.subject,
    description: input.description ?? '',
    status: 'pending',
    blockedBy: [...(input.blockedBy ?? [])],
    writeScopes: [...(input.writeScopes ?? [])],
  }
  return { state: addTaskSnapshot(state, task), task }
}

/** A task is ready when it is pending and every blocker is completed. Readiness never starts anyone. */
export function isReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  if (task.status !== 'pending') return false
  return task.blockedBy.every((id) => state.tasks.find((one) => one.id === id)?.status === 'completed')
}

export interface TaskActionRequest {
  readonly callerId: SessionId
  readonly taskId: string
  readonly revision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly string[]
  readonly writeScopes?: readonly string[]
  readonly ownerId?: SessionId
}

/**
 * Apply one compare-and-set task action.
 *
 * The revision is the caller's precondition: a stale revision is refused rather than merged, which is what
 * turns "I read it, then I act" into a safe pattern for several members. The Lead may act on any task; a
 * teammate may act on its own and on unowned work, never on another member's claim.
 */
export function applyTaskAction(
  state: TeamState,
  request: TaskActionRequest,
): { readonly state: TeamState; readonly task: TeamTaskSnapshot } {
  const task = state.tasks.find((one) => one.id === request.taskId)
  if (task === undefined) throw new TeamError(`no task '${request.taskId}'`, 'TEAM_TASK_MISSING')
  if (task.revision !== request.revision) {
    throw new TeamError(`task '${task.id}' is at revision ${task.revision}, not ${request.revision}`, 'TEAM_TASK_STALE')
  }
  const isLead = request.callerId === state.id
  const owns = task.ownerId === request.callerId
  /**
   * A claimed or finished task is its owner's (or the Lead's). Unowned work — a pending task, or a task whose
   * owner was cleared by release/delete — is the board's, so any member may act on it.
   */
  if (!isLead && !owns && task.ownerId !== undefined && task.status !== 'pending' && task.status !== 'deleted') {
    throw new TeamError(`task '${task.id}' belongs to another member`, 'TEAM_TASK_STATUS')
  }
  const patch: { -readonly [K in keyof TeamTaskSnapshot]?: TeamTaskSnapshot[K] } = {
    ...task,
    revision: task.revision + 1,
    blockedBy: task.blockedBy,
    writeScopes: task.writeScopes,
  }
  switch (request.action) {
    case 'claim': {
      if (task.status !== 'pending') throw new TeamError(`task '${task.id}' is ${task.status}, not pending`, 'TEAM_TASK_STATUS')
      if (!isReady(state, task)) throw new TeamError(`task '${task.id}' is blocked by ${task.blockedBy.join(', ')}`, 'TEAM_TASK_BLOCKED')
      patch.status = 'in_progress'
      patch.ownerId = request.callerId
      break
    }
    case 'release': {
      if (task.status !== 'in_progress') throw new TeamError(`task '${task.id}' is ${task.status}, not in progress`, 'TEAM_TASK_STATUS')
      patch.status = 'pending'
      delete patch.ownerId
      break
    }
    case 'edit': {
      if (task.status === 'deleted') throw new TeamError(`task '${task.id}' is deleted`, 'TEAM_TASK_STATUS')
      if (request.subject !== undefined) {
        if (request.subject.trim().length === 0) throw new TeamError('an edited task needs a subject', 'TEAM_TASK_INVALID')
        patch.subject = request.subject
      }
      if (request.description !== undefined) patch.description = request.description
      if (request.writeScopes !== undefined) patch.writeScopes = [...request.writeScopes]
      break
    }
    case 'set_dependencies': {
      if (task.status === 'deleted') throw new TeamError(`task '${task.id}' is deleted`, 'TEAM_TASK_STATUS')
      patch.blockedBy = [...(request.blockedBy ?? [])]
      break
    }
    case 'complete': {
      if (task.status !== 'in_progress') throw new TeamError(`task '${task.id}' is ${task.status}, not in progress`, 'TEAM_TASK_STATUS')
      if (!isLead && !owns) throw new TeamError(`task '${task.id}' is not yours to complete`, 'TEAM_TASK_STATUS')
      patch.status = 'completed'
      break
    }
    case 'reopen': {
      if (task.status !== 'completed' && task.status !== 'deleted') {
        throw new TeamError(`task '${task.id}' is ${task.status}, not completed or deleted`, 'TEAM_TASK_STATUS')
      }
      patch.status = 'pending'
      delete patch.ownerId
      break
    }
    case 'reassign': {
      if (!isLead) throw new TeamError('only the Lead can reassign a task', 'TEAM_LEAD_REQUIRED')
      if (request.ownerId !== undefined) {
        const owner = memberById(state, request.ownerId)
        if (owner === undefined || owner.phase !== 'active') throw new TeamError(`no active member ${request.ownerId}`, 'TEAM_MEMBER_INVALID')
        patch.status = 'in_progress'
        patch.ownerId = request.ownerId
      } else {
        patch.status = 'pending'
        delete patch.ownerId
      }
      break
    }
    case 'delete': {
      /** Unowned pending work is the board's, not one member's; a claimed task is its owner's or the Lead's. */
      if (!isLead && task.ownerId !== undefined && !owns) throw new TeamError(`task '${task.id}' is not yours to delete`, 'TEAM_TASK_STATUS')
      patch.status = 'deleted'
      delete patch.ownerId
      break
    }
    default:
      throw new TeamError(`unknown task action '${String((request as { action?: unknown }).action)}'`, 'TEAM_TASK_INVALID')
  }
  const next = addTaskSnapshot(state, { ...(patch as TeamTaskSnapshot) })
  return { state: next, task: next.tasks.find((one) => one.id === task.id) as TeamTaskSnapshot }
}

/** The task as a reader sees it, with readiness and advisory write-scope overlaps. */
export function taskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const owner = task.ownerId === undefined ? undefined : state.members.find((one) => one.id === task.ownerId)
  /** The Lead owns work as 'lead' rather than as a member snapshot. */
  const ownerName = owner?.name ?? (task.ownerId === state.id ? 'lead' : undefined)
  const warnings = task.writeScopes.flatMap((scope) =>
    state.tasks
      .filter((other) => other.id !== task.id && other.status !== 'deleted' && other.status !== 'completed' && other.writeScopes.includes(scope))
      .map((other) => `${scope} is also written by ${other.id}`),
  )
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(ownerName !== undefined ? { ownerName } : {}),
    blockedBy: task.blockedBy,
    writeScopes: task.writeScopes,
    ready: isReady(state, task),
    writeScopeWarnings: [...new Set(warnings)],
  }
}

export function memberById(state: TeamState, id: SessionId | undefined): TeamMemberSnapshot | undefined {
  return id === undefined ? undefined : state.members.find((one) => one.id === id)
}

/** Resolve a member target by name. The Lead is addressable as 'lead' and is never a member snapshot. */
export function resolveMember(state: TeamState, name: string): { readonly id: SessionId; readonly name: string; readonly phase: 'active' } | undefined {
  if (name === 'lead') return { id: state.id, name: 'lead', phase: 'active' }
  const member = state.members.find((one) => one.name === name)
  return member === undefined || member.phase !== 'active' ? undefined : { id: member.id, name: member.name, phase: 'active' }
}

/** Members that are active or still being provisioned — the set a wait can make progress on. */
export function activeOrProvisioning(state: TeamState): readonly TeamMemberSnapshot[] {
  return state.members.filter((member) => member.phase === 'active' || member.phase === 'provisioning')
}
