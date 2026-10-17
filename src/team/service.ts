import { randomUUID } from 'node:crypto'

import type { ContentPart } from '../llm/types.ts'
import type { SessionEvent, SessionHandle, SessionId, SessionMeta, SessionStore } from '../session/store.ts'
import {
  addMember,
  applyTaskAction,
  createTask as createTaskState,
  foldTeam,
  memberById,
  queueMessage,
  resolveMember,
  taskView,
  TeamError,
  TEAM_EVENT_VERSION,
  type TaskActionRequest,
  type TeamMemberContext,
  type TeamMemberSnapshot,
  type TeamMessageSnapshot,
  type TeamState,
  type TeamTaskSnapshot,
  type TeamTaskView,
} from './state.ts'

/**
 * The Agent Teams service: durable teammates, a durable mailbox and a shared task board, over the Lead's
 * session log.
 *
 * The shape is DSH's (`ctx.agentTeams`), with heddle's constraints made explicit:
 *
 * - the **Lead is a session**; a teammate is a session of its own whose metadata names the team (`teamId`) and
 *   its parent, so a tool called inside a teammate's turn can find the report;
 * - every mutation is a `team/*` event appended to the Lead's log, folded on read — nothing lives only in memory;
 * - a queued message is delivered by writing it into the **target's own log** (as a steered user message when the
 *   target is mid-turn, or as the prompt of a new turn when it is idle) and by confirming that write before
 *   `team/message/delivered` is journaled: the target's log is the proof, not the call returning;
 * - delivery is serialized per target, and a member being provisioned has its mail queued until it is active;
 * - interruption is the Lead's, and only stops the target's current turn — queued mail is untouched.
 *
 * The service is a plain class over injected dependencies so it can be tested without a model, a clock or a
 * Cordis context; the plugin wires `run` to `runTurn` and `turns` to the live-turn registry.
 */

export interface TeamLimits {
  readonly maxMembers?: number
  readonly maxTasks?: number
  readonly maxPendingMessagesPerMember?: number
  readonly maxMessageBytes?: number
}

/** The live half of status and interruption: what only the process knows. */
export interface TeamTurns {
  isRunning(sessionId: SessionId): boolean
  /** Stop one session's current turn. Returns whether a turn was running. */
  abort(sessionId: SessionId): boolean
}

export interface TeamDeps {
  readonly store: SessionStore
  /** Run one turn in a session; wired to `runTurn` in production and to a recorder in tests. */
  readonly run: (child: SessionHandle, prompt: string, source?: unknown, signal?: AbortSignal) => Promise<void>
  readonly turns?: TeamTurns
  readonly limits?: TeamLimits
  /** Called after every journal write, so a Web UI or a waiter can refresh. */
  readonly notify?: (lead: SessionId) => void
}

export type TeamMemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: TeamMemberStatus
  readonly description?: string
  readonly context?: TeamMemberContext
  readonly diagnostics: readonly string[]
}

export interface SpawnRequest {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly context?: TeamMemberContext
  readonly signal?: AbortSignal
}

export interface SendRequest {
  readonly target: string
  readonly content: readonly ContentPart[]
  readonly signal?: AbortSignal
}

export interface WaitResult {
  readonly changed?: true
  readonly timedOut?: true
  readonly noProgress?: true
}

const textOf = (content: readonly ContentPart[]): string =>
  content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')

export class TeamService {
  private readonly deps: TeamDeps
  private readonly limits: Required<TeamLimits>
  private readonly waiters = new Set<() => void>()
  private readonly dispatchTails = new Map<SessionId, Promise<void>>()

  constructor(deps: TeamDeps) {
    this.deps = deps
    this.limits = {
      maxMembers: deps.limits?.maxMembers ?? 8,
      maxTasks: deps.limits?.maxTasks ?? 256,
      maxPendingMessagesPerMember: deps.limits?.maxPendingMessagesPerMember ?? 64,
      maxMessageBytes: deps.limits?.maxMessageBytes ?? 65_536,
    }
  }

  /** The folded team state of the Lead the caller belongs to. */
  state(caller: SessionHandle): TeamState {
    return foldTeam(this.deps.store.read(this.leadOf(caller)), this.leadOf(caller).id)
  }

  /** The Lead session a caller belongs to: itself when it is a Lead, its team's Lead when it is a teammate. */
  leadOf(caller: SessionHandle): SessionHandle {
    const meta = this.deps.store.list().find((one) => one.id === caller.id)
    if (meta?.teamId === undefined) return caller
    const lead = this.deps.store.open(meta.teamId)
    if (lead === null) throw new TeamError(`team session '${meta.teamId}' is missing`, 'TEAM_INVALID_EVENT')
    return lead
  }

  /** The Lead plus every teammate, with the live status only this process can answer. */
  list(caller: SessionHandle): readonly TeamMemberView[] {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    return [
      {
        id: lead.id,
        name: 'lead',
        role: 'lead',
        status: this.isRunning(lead.id) ? 'running' : 'inactive',
        diagnostics: [],
      },
      ...state.members.map((member) => this.view(member)),
    ]
  }

  /**
   * Create one durable teammate: journal it as provisioning, create its own session, start its first turn, then
   * mark it active.
   *
   * The journal is written **before** the session exists, so a crash between the two leaves a provisioning member
   * that `recover` can settle from the durable child session rather than a member nobody knows about. The first
   * turn is started rather than awaited: a Lead that spawned a teammate keeps working while it does.
   */
  spawn(caller: SessionHandle, request: SpawnRequest): TeamMemberView {
    const lead = this.leadOf(caller)
    this.requireLead(caller, lead)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    const id = `session-${randomUUID()}`
    const member: TeamMemberSnapshot = {
      id,
      name: request.name,
      description: request.description,
      context: request.context ?? 'fresh',
      phase: 'provisioning',
    }
    addMember(state, member, { maxMembers: this.limits.maxMembers })
    this.journal(lead, { type: 'team/member', member })

    const leadMeta = this.meta(lead.id)
    let child: SessionHandle | null
    try {
      child =
        member.context === 'fork'
          ? this.deps.store.fork(lead.id, {
              id,
              parentSession: lead.id,
              origin: 'subagent',
              delegationDepth: 1,
              teamId: lead.id,
              title: `teammate ${member.name}`,
            })
          : this.deps.store.create({
              id,
              ...(leadMeta?.cwd !== undefined ? { cwd: leadMeta.cwd } : {}),
              ...(leadMeta?.endpoint !== undefined ? { endpoint: leadMeta.endpoint } : {}),
              ...(leadMeta?.model !== undefined ? { model: leadMeta.model } : {}),
              parentSession: lead.id,
              origin: 'subagent',
              delegationDepth: 1,
              teamId: lead.id,
              title: `teammate ${member.name}`,
            })
      if (child === null) throw new TeamError(`the Lead session '${lead.id}' could not be read to fork from`, 'TEAM_INVALID_EVENT')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.journal(lead, { type: 'team/member', member: { ...member, phase: 'failed', error: message } })
      throw error
    }

    this.startTurn(child, request.prompt, { kind: 'team-prompt', teamId: lead.id, memberId: child.id }, request.signal)
    this.journal(lead, { type: 'team/member', member: { ...member, phase: 'active' } })
    return this.view(memberByLast(this.state(lead), id))
  }

  /**
   * Queue one durable message and attempt delivery.
   *
   * `queued` means the message is durable but not yet in the target's log — a member still provisioning is the
   * normal case. `accepted` means it is in the target's log, which is the only delivery this service believes.
   */
  async send(caller: SessionHandle, request: SendRequest): Promise<{ readonly messageId: string; readonly status: 'accepted' | 'queued' }> {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    /**
     * A provisioning member is a valid target: its mail waits in the durable queue until it is active. A
     * failed member is not addressable, because nothing will ever take its mail.
     */
    const member = request.target === 'lead' ? { id: lead.id, name: 'lead', phase: 'active' as const } : state.members.find((one) => one.name === request.target)
    if (member === undefined || member.phase === 'failed') {
      throw new TeamError(`no team member named '${request.target}' can receive mail`, 'TEAM_MEMBER_INVALID')
    }
    const target = member
    if (target.id === caller.id) throw new TeamError('a team member cannot message itself', 'TEAM_SELF_MESSAGE')
    const sender = caller.id === lead.id ? undefined : memberById(state, caller.id)
    if (caller.id !== lead.id && sender === undefined) {
      throw new TeamError(`session '${caller.id}' is not part of this team`, 'TEAM_MEMBER_INVALID')
    }
    const pending = state.messages.filter((message) => message.targetId === target.id && !state.delivered.includes(message.id)).length
    if (pending >= this.limits.maxPendingMessagesPerMember) {
      throw new TeamError(`member '${target.name}' has ${pending} pending messages; max is ${this.limits.maxPendingMessagesPerMember}`, 'TEAM_MAILBOX_FULL')
    }
    if (Buffer.byteLength(JSON.stringify(request.content), 'utf8') > this.limits.maxMessageBytes) {
      throw new TeamError(`the message exceeds ${this.limits.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
    }
    const message: TeamMessageSnapshot = {
      id: `team-message-${randomUUID()}`,
      senderId: caller.id,
      senderName: caller.id === lead.id ? 'lead' : (sender as TeamMemberSnapshot).name,
      targetId: target.id,
      content: request.content.map((part) => ({ ...part })),
    }
    this.journal(lead, { type: 'team/message/queued', message })

    if (target.phase === 'provisioning') {
      return { messageId: message.id, status: 'queued' }
    }
    const accepted = await this.serialize(target.id, () => this.deliver(lead, message))
    return { messageId: message.id, status: accepted ? 'accepted' : 'queued' }
  }

  /** The Lead's shared task board, as views with readiness and advisory scope warnings. */
  tasks(caller: SessionHandle): readonly TeamTaskView[] {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    return state.tasks.map((task) => taskView(state, task))
  }

  createTask(caller: SessionHandle, input: { readonly subject: string; readonly description?: string; readonly blockedBy?: readonly string[]; readonly writeScopes?: readonly string[] }): TeamTaskView {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    const created = createTaskState(state, input, { maxTasks: this.limits.maxTasks })
    this.journal(lead, { type: 'team/task', task: created.task })
    return taskView(created.state, created.task)
  }

  updateTask(caller: SessionHandle, request: Omit<TaskActionRequest, 'callerId'>): TeamTaskView {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    const applied = applyTaskAction(state, { ...request, callerId: caller.id })
    this.journal(lead, { type: 'team/task', task: applied.task })
    return taskView(applied.state, applied.task)
  }

  /**
   * Wait for the next team change, a timeout, or the honest answer that nothing can change.
   *
   * `noProgress` is the level-triggered half: when no other member is running or provisioning, no amount of
   * waiting will produce a change, and the caller is told so immediately instead of sleeping for its timeout.
   */
  async waitForChange(caller: SessionHandle, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const lead = this.leadOf(caller)
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    const others = state.members.filter(
      (member) => member.id !== caller.id && (member.phase === 'provisioning' || this.isRunning(member.id)),
    )
    if (others.length === 0) return { noProgress: true }
    const changed = await this.waitForSignal(Math.max(0, timeoutMs), signal)
    return changed ? { changed: true } : { timedOut: true }
  }

  /**
   * Interrupt one teammate's current turn. The pending inbox is untouched: interruption stops a turn, not mail.
   */
  interrupt(caller: SessionHandle, targetName: string): { readonly previousStatus: TeamMemberStatus } {
    const lead = this.leadOf(caller)
    this.requireLead(caller, lead)
    if (this.deps.turns === undefined) throw new TeamError('this profile has no live-turn registry, so nothing can be interrupted', 'TEAM_UNAVAILABLE')
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    const target = state.members.find((member) => member.name === targetName)
    if (target === undefined) throw new TeamError(`no team member named '${targetName}'`, 'TEAM_MEMBER_INVALID')
    if (target.phase !== 'active') throw new TeamError(`member '${target.name}' is ${target.phase}, not running a turn`, 'TEAM_MEMBER_INVALID')
    const previousStatus = this.isRunning(target.id) ? 'running' : 'inactive'
    this.deps.turns.abort(target.id)
    return { previousStatus }
  }

  /**
   * Reconcile what a previous process left behind: every provisioning member is settled from its durable child
   * session (active if that session exists and accepted a prompt, failed otherwise), and every undelivered
   * message is offered to its target again. This is the startup edge of the reentrant team.
   */
  async recover(caller: SessionHandle): Promise<{ readonly settled: number; readonly delivered: number }> {
    const lead = this.leadOf(caller)
    let state = foldTeam(this.deps.store.read(lead), lead.id)
    let settled = 0
    for (const member of state.members.filter((one) => one.phase === 'provisioning')) {
      const child = this.deps.store.open(member.id)
      const accepted = child !== null && this.deps.store.read(child).some((event) => event.type === 'message' && (event.message as { role?: string } | undefined)?.role === 'user')
      if (accepted) {
        this.journal(lead, { type: 'team/member', member: { ...member, phase: 'active' } })
      } else {
        this.journal(lead, { type: 'team/member', member: { ...member, phase: 'failed', error: 'provisioning did not leave a resumable child session' } })
      }
      settled += 1
    }
    state = foldTeam(this.deps.store.read(lead), lead.id)
    let delivered = 0
    for (const message of state.messages.filter((one) => !state.delivered.includes(one.id))) {
      const member = state.members.find((one) => one.id === message.targetId)
      if (member !== undefined && member.phase !== 'active') continue
      if (await this.serialize(message.targetId, () => this.deliver(lead, message))) delivered += 1
    }
    return { settled, delivered }
  }

  /**
   * Recover every session that carries team state.
   *
   * The server calls this at boot; it is the startup edge of the reentrant team. Sessions with no team events are
   * skipped, so a large store costs one scan of the session metadata and one fold per actual team.
   */
  async recoverAll(leads: readonly SessionHandle[]): Promise<{ readonly recovered: number; readonly settled: number; readonly delivered: number }> {
    let recovered = 0
    let settled = 0
    let delivered = 0
    for (const lead of leads) {
      const events = this.deps.store.read(lead)
      if (!events.some((event) => event.type.startsWith('team/'))) continue
      const result = await this.recover(lead)
      recovered += 1
      settled += result.settled
      delivered += result.delivered
    }
    return { recovered, settled, delivered }
  }

  /** The status of one member, from durable phase and the live registry. */
  statusOf(member: TeamMemberSnapshot): TeamMemberStatus {
    if (member.phase === 'failed') return 'failed'
    if (member.phase === 'provisioning') return 'provisioning'
    return this.isRunning(member.id) ? 'running' : 'inactive'
  }

  private view(member: TeamMemberSnapshot): TeamMemberView {
    return {
      id: member.id,
      name: member.name,
      role: 'teammate',
      status: this.statusOf(member),
      description: member.description,
      context: member.context,
      diagnostics: member.error === undefined ? [] : [member.error],
    }
  }

  private meta(id: SessionId): SessionMeta | undefined {
    return this.deps.store.list().find((one) => one.id === id)
  }

  private isRunning(id: SessionId): boolean {
    return this.deps.turns?.isRunning(id) ?? false
  }

  private requireLead(caller: SessionHandle, lead: SessionHandle): void {
    if (caller.id !== lead.id) throw new TeamError('only the Team Lead can do that', 'TEAM_LEAD_REQUIRED')
  }

  private journal(lead: SessionHandle, payload: { type: string } & Record<string, unknown>): void {
    this.deps.store.append(lead, { ...payload, version: TEAM_EVENT_VERSION, teamId: lead.id })
    this.deps.notify?.(lead.id)
    for (const waiter of [...this.waiters]) waiter()
  }

  /**
   * Start a turn without awaiting it. The prompt is appended by `run` before its first await, so a caller that
   * reads the log right after this call sees the member's first message — which is what makes "provisioning left
   * a resumable session" checkable later.
   */
  private startTurn(child: SessionHandle, prompt: string, source?: unknown, signal?: AbortSignal): void {
    void this.deps.run(child, prompt, source, signal).catch((error: unknown) => {
      this.deps.store.append(child, { type: 'turn/failed', reason: error instanceof Error ? error.message : String(error) })
    })
  }

  private async deliver(lead: SessionHandle, message: TeamMessageSnapshot): Promise<boolean> {
    const target = this.deps.store.open(message.targetId)
    if (target === null) return false
    if (!this.recorded(target, message.id)) {
      const source = { kind: 'team-message', teamId: lead.id, messageId: message.id, senderId: message.senderId, senderName: message.senderName }
      if (this.isRunning(message.targetId)) {
        /** Mid-turn: the loop notices new input between rounds, which is heddle's existing steering. */
        this.deps.store.message(target, { role: 'user', content: message.content, source })
      } else {
        this.startTurn(target, textOf(message.content), source)
      }
    }
    if (!this.recorded(target, message.id)) return false
    const state = foldTeam(this.deps.store.read(lead), lead.id)
    if (!state.delivered.includes(message.id)) {
      this.journal(lead, { type: 'team/message/delivered', messageId: message.id, targetId: target.id })
    }
    return true
  }

  /** Is this message in the target's own log? The only delivery proof this service accepts. */
  private recorded(handle: SessionHandle, messageId: string): boolean {
    return this.deps.store.read(handle).some((event) => {
      if (event.type !== 'message') return false
      const message = event.message as { role?: string; source?: { kind?: string; messageId?: string } } | undefined
      return message?.role === 'user' && message.source?.kind === 'team-message' && message.source.messageId === messageId
    })
  }

  /** Serialize delivery per target, so two sends cannot race each other into the same log. */
  private async serialize(targetId: SessionId, operation: () => Promise<boolean>): Promise<boolean> {
    const previous = this.dispatchTails.get(targetId) ?? Promise.resolve()
    let result = false
    const run = previous.then(async () => {
      result = await operation()
    }, async () => {
      result = await operation()
    })
    this.dispatchTails.set(targetId, run.then(() => undefined, () => undefined))
    await run
    return result
  }

  private waitForSignal(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return Promise.resolve(false)
    return new Promise<boolean>((resolvePromise) => {
      let done = false
      const finish = (changed: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(changed)
      }
      const waiter = (): void => finish(true)
      const onAbort = (): void => finish(false)
      this.waiters.add(waiter)
      const timer = setTimeout(() => finish(false), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** The folded snapshot of one member, after a journal write. */
function memberByLast(state: TeamState, id: SessionId): TeamMemberSnapshot {
  const member = state.members.find((one) => one.id === id)
  if (member === undefined) throw new TeamError(`member '${id}' vanished after a journal write`, 'TEAM_INVALID_EVENT')
  return member
}

