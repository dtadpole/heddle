import type { Context } from '@deepseek-ai/cordis'

import { inheritRecordedMode } from '../session/mode.ts'
import type { SessionEvent, SessionHandle, SessionMeta, SessionStore } from '../session/store.ts'
import { runTurn } from './loop.ts'

/**
 * Subagent delegation: a parent turn asks for a child agent, the child runs in its **own session**, and its
 * final answer comes back as the parent's tool result.
 *
 * Modelled on DSH's subagent layer read in
 * [`_context_/dsh-mechanisms/dsh-agent-teams.md`](../../_context_/dsh-mechanisms/dsh-agent-teams.md): the child
 * is a session with `parentSession`, `origin:'subagent'` and `delegationDepth` in its metadata (the fields
 * `childSessionMeta` writes), the parent's transcript sees only the tool call, the result is the child's
 * **final assistant output**, and depth/active limits are the runtime's, not the tool's.
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

/** A parent's delegation depth and endpoint/model, read from its own session record. */
export function parentFacts(meta: SessionMeta | undefined): { readonly depth: number; readonly endpoint?: string; readonly model?: string } {
  return {
    depth: meta?.delegationDepth ?? 0,
    ...(meta?.endpoint !== undefined ? { endpoint: meta.endpoint } : {}),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
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
 * Delegate one prompt to a child agent and wait for its answer.
 *
 * Refusals are explicit and stable: an empty prompt, no session, a chain beyond `maxDepth`, or too many
 * children already running for this parent. Cancellation is the parent's abort signal — a stopped parent does
 * not leave a child running behind it.
 */
export async function delegateSubagent(
  deps: SubagentDeps,
  parent: SessionHandle | undefined,
  prompt: string,
  limits: SubagentLimits,
  options: { readonly signal?: AbortSignal; readonly active: Set<string> } = { active: new Set() },
): Promise<SubagentResult> {
  if (parent === undefined) throw new SubagentError('a delegation needs a parent session', 'SUBAGENT_NO_SESSION')
  const text = prompt.trim()
  if (text.length === 0) throw new SubagentError('a delegation needs a prompt', 'SUBAGENT_EMPTY_PROMPT')

  const parentMeta = deps.store.list().find((meta) => meta.id === parent.id)
  const { depth, endpoint, model } = parentFacts(parentMeta)
  const childDepth = depth + 1
  const maxDepth = limits.maxDepth ?? 2
  if (childDepth > maxDepth) {
    throw new SubagentError(`subagent depth ${childDepth} exceeds maxDepth ${maxDepth}`, 'SUBAGENT_DEPTH_EXCEEDED')
  }
  const maxActive = limits.maxActive ?? 2
  /**
   * The limit is on children **in flight**, and today's loop runs a turn's tool calls one at a time, so the
   * refusal only becomes reachable when a tool runs several delegations concurrently — or when a caller drives
   * `delegateSubagent` itself. It is enforced here rather than in the tool so a future parallel executor cannot
   * bypass it.
   */
  if (options.active.size >= maxActive) {
    throw new SubagentError(`already running ${options.active.size} subagent(s); maxActive is ${maxActive}`, 'SUBAGENT_BUSY')
  }

  const cwd = parentMeta?.cwd ?? process.cwd()
  const child = deps.store.create({
    cwd,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(model !== undefined ? { model } : {}),
    parentSession: parent.id,
    origin: 'subagent',
    delegationDepth: childDepth,
  })
  /** Delegation inherits the parent's mode, so a narrowed session cannot widen itself by spawning a child. */
  inheritRecordedMode(deps.store, parent, child)

  options.active.add(parent.id)
  try {
    await deps.run(child, text, options.signal)
    const answer = finalAssistantText(deps.store.read(child))
    if (answer.length === 0) throw new SubagentError('the child agent produced no assistant output', 'SUBAGENT_FAILED')
    return { childSession: child.id, text: answer, depth: childDepth }
  } finally {
    options.active.delete(parent.id)
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
      ...(signal !== undefined ? { signal } : {}),
    })
  }
}
