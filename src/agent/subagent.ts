import type { Context } from '@deepseek-ai/cordis'

import { inheritRecordedMode } from '../session/mode.ts'
import type { SessionEvent, SessionHandle, SessionMeta, SessionStore } from '../session/store.ts'
import { runTurn } from './loop.ts'

/**
 * Subagent delegation: a parent turn asks for a child agent, the child runs in its **own session** in the
 * background, and its closing message comes back to the parent as a **settlement notice** when it settles.
 *
 * Modelled on DSH's subagent layer read in
 * [`_context_/dsh-mechanisms/dsh-agent-teams.md`](../../_context_/dsh-mechanisms/dsh-agent-teams.md) and in the
 * `dsh-tool-subagent` and `dsh-subagent` packages: the child is a session with `parentSession`,
 * `origin:'subagent'` and `delegationDepth` in its metadata (the fields `childSessionMeta` writes); the tool
 * returns `started subagent <id>` at once; the parent's transcript sees the tool call and, later, a user-role
 * `subagent-settled` notice carrying the child's **final assistant output**; and depth/active limits are the
 * runtime's, not the tool's.
 *
 * This is deliberately the *subagent* slice rather than DSH's experimental team layer: a team (roster,
 * mailbox, shared task board in one session) builds on having agents at all, and heddle had none.
 */

/** Stable refusals, so a caller (and a model) can branch on the code rather than the sentence. */
export type SubagentErrorCode =
  | 'SUBAGENT_DEPTH_EXCEEDED'
  | 'SUBAGENT_BUSY'
  | 'SUBAGENT_NO_SESSION'
  | 'SUBAGENT_EMPTY_PROMPT'
  | 'SUBAGENT_FAILED'

export class SubagentError extends Error {
  readonly code: SubagentErrorCode

  constructor(message: string, code: SubagentErrorCode) {
    super(message)
    this.name = 'SubagentError'
    this.code = code
  }
}

/** Limits the runtime enforces — DSH's `maxDepth` and `maxActiveSubagents` in spirit. */
export interface SubagentLimits {
  /** Deepest allowed delegation chain. A root agent is depth 0; its child is depth 1. */
  readonly maxDepth?: number
  /** How many children one parent session may run at once. */
  readonly maxActive?: number
}

/** The dependencies a delegation needs, injected so the decision is testable without a model. */
export interface SubagentDeps {
  readonly store: SessionStore
  /** Run one child turn. Real deployments pass `runTurn`; tests pass a recorder. */
  readonly run: (child: SessionHandle, prompt: string, signal?: AbortSignal) => Promise<void>
}

/** What a completed delegation reports back to the parent. */
export interface SubagentResult {
  readonly childSession: string
  readonly text: string
  readonly depth: number
}

/** A parent's delegation depth and selection, read from its own session record. */
export function parentFacts(
  meta: SessionMeta | undefined,
): { readonly depth: number; readonly endpoint?: string; readonly model?: string; readonly reasoningEffort?: string } {
  return {
    depth: meta?.delegationDepth ?? 0,
    ...(meta?.endpoint !== undefined ? { endpoint: meta.endpoint } : {}),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
    ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
  }
}

/**
 * The child's final answer: the assistant output of its **last round**.
 *
 * DSH folds the child's own events with `finalAssistantOutput`; the equivalent here reads the child's log
 * rather than a shared conversation — which is what keeps a delegation a boundary rather than a merge. A round
 * begins at the loop's `model/request`, and a settled `assistant/completed` replaces that round's deltas (the
 * log records both), so the last round's text is the answer.
 */
export function finalAssistantText(events: readonly SessionEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.type === 'model/request') {
      text = ''
      continue
    }
    if (event.type === 'message') {
      const role = (event.message as { role?: string } | undefined)?.role
      if (role === 'user') text = ''
      continue
    }
    if (event.type === 'assistant/completed') {
      if (typeof event.text === 'string') text = event.text
      continue
    }
    if (event.type === 'assistant/chunk') {
      const chunk = event.chunk as { type?: string; text?: string } | undefined
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  }
  return text.trim()
}

/**
 * The checks and the child session every delegation starts with, blocking or in the background.
 *
 * Refusals are explicit and stable: an empty prompt, no session, a chain beyond `maxDepth`, or too many children
 * already in flight. One helper, so the two delegation paths cannot drift apart in what they refuse.
 */
function openChild(
  store: SessionStore,
  parent: SessionHandle | undefined,
  prompt: string,
  limits: SubagentLimits,
  inFlight: number,
): { readonly parent: SessionHandle; readonly child: SessionHandle; readonly text: string; readonly depth: number } {
  if (parent === undefined) throw new SubagentError('a delegation needs a parent session', 'SUBAGENT_NO_SESSION')
  const text = prompt.trim()
  if (text.length === 0) throw new SubagentError('a delegation needs a prompt', 'SUBAGENT_EMPTY_PROMPT')

  const parentMeta = store.list().find((meta) => meta.id === parent.id)
  const { depth, endpoint, model, reasoningEffort } = parentFacts(parentMeta)
  const childDepth = depth + 1
  const maxDepth = limits.maxDepth ?? 2
  if (childDepth > maxDepth) {
    throw new SubagentError(`subagent depth ${childDepth} exceeds maxDepth ${maxDepth}`, 'SUBAGENT_DEPTH_EXCEEDED')
  }
  const maxActive = limits.maxActive ?? 2
  /** The limit is on children **in flight**; it is enforced here rather than in the tool so no caller bypasses it. */
  if (inFlight >= maxActive) {
    throw new SubagentError(`already running ${inFlight} subagent(s); maxActive is ${maxActive}`, 'SUBAGENT_BUSY')
  }

  const cwd = parentMeta?.cwd ?? process.cwd()
  const child = store.create({
    cwd,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    parentSession: parent.id,
    origin: 'subagent',
    delegationDepth: childDepth,
    /**
     * A child runs under its parent's agent preset (inventory A96), for the same reason it inherits the mode: a
     * session narrowed to a preset's tools cannot widen itself by delegating to a child that has every tool.
     */
    ...(parentMeta?.preset !== undefined ? { preset: parentMeta.preset } : {}),
  })
  /** Delegation inherits the parent's mode, so a narrowed session cannot widen itself by spawning a child. */
  inheritRecordedMode(store, parent, child)
  return { parent, child, text, depth: childDepth }
}

/**
 * Delegate one prompt to a child agent and **wait** for its answer.
 *
 * The blocking primitive: the model-facing tool no longer uses it (a delegation starts a background child, see
 * `SubagentService`), but a caller that needs the answer in hand can still drive one child to completion.
 * Cancellation is the caller's abort signal.
 */
export async function delegateSubagent(
  deps: SubagentDeps,
  parent: SessionHandle | undefined,
  prompt: string,
  limits: SubagentLimits,
  options: { readonly signal?: AbortSignal; readonly active: Set<string> } = { active: new Set() },
): Promise<SubagentResult> {
  const opened = openChild(deps.store, parent, prompt, limits, options.active.size)
  options.active.add(opened.parent.id)
  try {
    await deps.run(opened.child, opened.text, options.signal)
    const answer = finalAssistantText(deps.store.read(opened.child))
    if (answer.length === 0) throw new SubagentError('the child agent produced no assistant output', 'SUBAGENT_FAILED')
    return { childSession: opened.child.id, text: answer, depth: opened.depth }
  } finally {
    options.active.delete(opened.parent.id)
  }
}

/** How a background child's run ended, in DSH's settlement vocabulary (`dsh-subagent` stop reasons). */
export type SubagentStopReason = 'completed' | 'aborted' | 'error'

/**
 * The opening line of a settlement notice, DSH's `settlementSummary` word for word.
 *
 * A delegate child is one-shot: it takes no follow-up message (heddle's continuable child is the teammate), so a
 * completed child is worded as DSH words a child that cannot receive more.
 */
export function settlementSummary(childId: string, stopReason: SubagentStopReason): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished. It cannot receive follow-up messages.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'error':
      return `${subject} failed before it finished.`
  }
}

/** A settled child's report to its parent: the user-role message DSH's runtime delivers, and its source. */
export interface SettlementNotice {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: 'subagent-settled'
    readonly form: 'notice'
    readonly summary: string
    readonly senderSessionId: string
  }
}

/**
 * The settlement notice, shaped as DSH's `createSettlementMessage`: the summary line, then `Its closing message:`
 * and the child's closing text, or `It left no closing message.` when it has none, then any diagnostic.
 */
export function settlementNotice(
  childId: string,
  stopReason: SubagentStopReason,
  closingText: string,
  diagnostic?: string,
): SettlementNotice {
  const summary = settlementSummary(childId, stopReason)
  const closing = closingText.trim()
  const text = (value: string) => ({ type: 'text' as const, text: value })
  return {
    content: [
      text(summary),
      ...(closing.length === 0 ? [text('It left no closing message.')] : [text('Its closing message:'), text(closing)]),
      ...(diagnostic !== undefined && diagnostic.length > 0 ? [text(diagnostic)] : []),
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId },
  }
}

/** What a background delegation needs beyond the blocking one: a way to hand the parent its child's notice. */
export interface BackgroundSubagentDeps extends SubagentDeps {
  /**
   * Deliver a settled child's notice to its parent. Resolves once the parent has it **and** has answered it, so
   * a host that waits for its children (a one-shot CLI) also waits for the turn the notice started.
   */
  readonly deliver: (parent: SessionHandle, notice: SettlementNotice) => Promise<void>
}

/** What `start` hands back at once: the child's id and depth, never its answer. */
export interface StartedSubagent {
  readonly childSession: string
  readonly depth: number
}

/**
 * Background delegation, DSH's managed activation: `start` creates the child and returns at once, the child runs
 * its turn on its own, and when it settles its parent receives a settlement notice.
 *
 * The service also answers the question a headless host has to ask before it prints an answer — is any child of
 * this session still working, or any notice still being answered? — through `settle`, the analogue of DSH's
 * `waitForChildren` loop.
 */
export class SubagentService {
  /** Children in flight, by id; the active limit counts these. */
  private readonly inFlight = new Set<string>()
  /** Work a session is waiting on: its running children and the delivery of their notices. */
  private readonly pending = new Map<string, Set<Promise<void>>>()
  /** Notices delivered per parent session, for a host to report. */
  private readonly delivered = new Map<string, number>()

  private readonly deps: BackgroundSubagentDeps
  private readonly limits: SubagentLimits

  constructor(deps: BackgroundSubagentDeps, limits: SubagentLimits = {}) {
    this.deps = deps
    this.limits = limits
  }

  /** Children of every parent currently in flight. */
  get running(): number {
    return this.inFlight.size
  }

  /**
   * Start one child and return at once.
   *
   * The refusals are `openChild`'s and are thrown synchronously, before anything runs. The child's turn takes
   * `signal`, so a parent that is stopped stops its children too, as DSH's session stop cancels its descendants.
   */
  start(parent: SessionHandle | undefined, prompt: string, options: { readonly signal?: AbortSignal } = {}): StartedSubagent {
    const opened = this.openChildFor(parent, prompt)
    this.inFlight.add(opened.child.id)
    const work = this.runInBackground(opened.parent, opened.child, opened.text, options.signal)
    this.track(opened.parent.id, work)
    return { childSession: opened.child.id, depth: opened.depth }
  }

  /**
   * Wait until no child of this session is running and every notice it was sent has been answered; resolves
   * with the number of notices delivered so far. Work started while waiting (a notice's turn starting another
   * child) is waited for too.
   */
  async settle(sessionId: string): Promise<number> {
    for (;;) {
      const work = this.pending.get(sessionId)
      if (work === undefined || work.size === 0) break
      await Promise.allSettled([...work])
    }
    return this.delivered.get(sessionId) ?? 0
  }

  private openChildFor(parent: SessionHandle | undefined, prompt: string) {
    return openChild(this.deps.store, parent, prompt, this.limits, this.inFlight.size)
  }

  private track(sessionId: string, work: Promise<void>): void {
    const set = this.pending.get(sessionId) ?? new Set<Promise<void>>()
    this.pending.set(sessionId, set)
    set.add(work)
    void work.finally(() => {
      set.delete(work)
      if (set.size === 0 && this.pending.get(sessionId) === set) this.pending.delete(sessionId)
    })
  }

  private async runInBackground(parent: SessionHandle, child: SessionHandle, prompt: string, signal?: AbortSignal): Promise<void> {
    let stopReason: SubagentStopReason = 'completed'
    let diagnostic: string | undefined
    try {
      await this.deps.run(child, prompt, signal)
      /** A child settles only after its own children have, so its closing text is final (DSH closes admission
       *  after owned descendants finish). */
      await this.settle(child.id)
    } catch (error) {
      stopReason = signal?.aborted === true ? 'aborted' : 'error'
      diagnostic = error instanceof Error ? error.message : String(error)
    } finally {
      this.inFlight.delete(child.id)
    }
    if (stopReason === 'completed' && signal?.aborted === true) stopReason = 'aborted'
    const notice = settlementNotice(child.id, stopReason, finalAssistantText(this.deps.store.read(child)), diagnostic)
    try {
      await this.deps.deliver(parent, notice)
      this.delivered.set(parent.id, (this.delivered.get(parent.id) ?? 0) + 1)
    } catch {
      /** A delivery that fails must not reject the tracked work: `settle` would turn it into a host failure. */
    }
  }
}

/** The production `run` function: one bounded child turn with the parent's endpoint and model. */
export function subagentRunner(ctx: Context): SubagentDeps['run'] {
  return async (child, prompt, signal) => {
    const meta = ctx.session.list().find((one) => one.id === child.id)
    const endpoint = meta?.endpoint ?? ctx.model.defaultEndpoint()
    if (endpoint === undefined) throw new SubagentError('no endpoint is configured for a subagent run', 'SUBAGENT_FAILED')
    await runTurn(ctx, {
      session: child,
      endpoint,
      prompt,
      ...(meta?.model !== undefined ? { model: meta.model } : {}),
      ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  }
}
