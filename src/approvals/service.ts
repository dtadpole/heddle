import { randomUUID } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'approvals'

/** What the policy says about one call. */
export interface ApprovalDecision {
  readonly allowed: boolean
  readonly mode: ApprovalMode
  /** Present when refused; this is the sentence a user is shown. */
  readonly reason?: string
}

export type ApprovalMode = 'allow' | 'deny' | 'ask'

/**
 * The closed outcome vocabulary of one answered request.
 *
 * Structurally DSH's `ApprovalOutcome`: `allowed-once` is the only grant and it applies to the one call that asked;
 * `rejected` is a person saying no; `cancelled` is the ask being withdrawn (aborted); `unavailable` is a run with
 * no one who could answer.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One question waiting for a person, as the Web UI draws it and the CLI could report it. */
export interface ApprovalRequest {
  readonly id: string
  readonly tool: string
  /** The audit reason, in English, the way the logs are written. */
  readonly reason: string
  /** What a person reads; the model's justification is carried verbatim inside it. */
  readonly displayReason: string
  /** The session the call belongs to, when it has one — the page only draws the card for its own session. */
  readonly session?: string
  readonly at: string
}

export const Config = Schema.object({
  /**
   * The standing policy.
   *
   * `ask` is the honest default for an unattended harness and the awkward one for
   * a headless run: with no one to answer, an `ask` is a denial with a reason. The
   * loop reports it as such rather than hanging or silently allowing.
   */
  mode: Schema.union([Schema.const('allow' as const), Schema.const('deny' as const), Schema.const('ask' as const)]).default(
    'allow',
  ),
  /** Tools refused by name, whatever the mode says. */
  deny: Schema.array(Schema.string()).default([]),
  /** Tools allowed by name even when the mode is `deny`. */
  allow: Schema.array(Schema.string()).default([]),
  /** Answer given to an `ask` when nothing can answer it. */
  unanswered: Schema.union([Schema.const('deny' as const), Schema.const('allow' as const)]).default('deny'),
  /**
   * How long a question waits for a person before it is withdrawn as cancelled.
   *
   * Bounded rather than open-ended: a turn blocked forever on a card nobody saw is a turn that cannot be stopped
   * cleanly, and `cancelled` is the truthful answer to "nobody answered".
   */
  answerTimeoutMs: Schema.number().default(300_000),
})

export interface Config {
  readonly mode?: ApprovalMode
  readonly deny?: readonly string[]
  readonly allow?: readonly string[]
  readonly unanswered?: 'deny' | 'allow'
  readonly answerTimeoutMs?: number
}

/** One unresolved question, with the promise it will settle. */
interface PendingApproval {
  readonly request: ApprovalRequest
  readonly settle: (outcome: ApprovalOutcome) => void
}

/**
 * The approval policy, and the channel a person answers a question through.
 *
 * The point of the service existing separately from the sandbox is that the two
 * refuse different things and a user needs to know which one stopped them: the
 * sandbox refuses **where** an effect lands, the policy refuses **whether** an
 * action may be taken at all. A tool denied by name is a different sentence from a
 * path outside the workspace, and collapsing the two loses the diagnosis.
 *
 * `ask` used to be modelled rather than implemented, because a prompt is a UI concern. It is implemented now: an
 * answering surface **attaches** (the Web UI does on start), `request()` emits the question and waits for
 * `answer()`, and a run with nothing attached gets its `unanswered` answer and says so. That is what makes DSH's
 * approval-gated escalation possible without a second approval mechanism.
 */
export class ApprovalService extends Service {
  static readonly provide = 'approvals'

  readonly mode: ApprovalMode
  readonly deny: readonly string[]
  readonly allow: readonly string[]
  readonly unanswered: 'deny' | 'allow'
  readonly answerTimeoutMs: number

  /** Every decision this process made, so a run can report what it refused. */
  private readonly decisions: { tool: string; allowed: boolean; reason?: string }[] = []
  /** Questions waiting for an answer, and who can answer them. */
  private readonly pending = new Map<string, PendingApproval>()
  private answerers = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'approvals')
    this.mode = config.mode ?? 'allow'
    this.deny = config.deny ?? []
    this.allow = config.allow ?? []
    this.unanswered = config.unanswered ?? 'deny'
    this.answerTimeoutMs = config.answerTimeoutMs ?? 300_000
  }

  /** Decide one call, and remember the decision. */
  check(tool: string): ApprovalDecision {
    const decision = this.decide(tool)
    this.decisions.push({ tool, allowed: decision.allowed, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) })
    return decision
  }

  private decide(tool: string): ApprovalDecision {
    if (this.deny.includes(tool) && !this.allow.includes(tool)) {
      return { allowed: false, mode: this.mode, reason: `the approval policy denies '${tool}' by name` }
    }
    if (this.mode === 'allow') return { allowed: true, mode: this.mode }
    if (this.mode === 'deny') {
      if (this.allow.includes(tool)) return { allowed: true, mode: this.mode, reason: `'${tool}' is allowed by name` }
      return { allowed: false, mode: this.mode, reason: `the approval policy is 'deny' and '${tool}' is not allowed by name` }
    }
    // `ask` with no one to answer.
    if (this.unanswered === 'allow') return { allowed: true, mode: this.mode, reason: `'${tool}' was not asked; unanswered defaults to allow` }
    return {
      allowed: false,
      mode: this.mode,
      reason: `the approval policy asks before '${tool}', and this run has no one to answer, so it is refused`,
    }
  }

  /**
   * Mark that a surface can answer questions, and return the disposer.
   *
   * Counted rather than boolean because a web server reload creates a new answerer before the old one's disposal,
   * and a boolean would let the old disposal switch the new one off. A run with no answerer (the CLI) answers from
   * `unanswered` immediately, which is what keeps a headless turn from waiting for a card nobody can see.
   */
  attachAnswerer(): () => void {
    this.answerers += 1
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.answerers -= 1
    }
  }

  /** Whether anything could answer a question right now. */
  canAnswer(): boolean {
    return this.answerers > 0
  }

  /** The questions waiting for an answer, oldest first — what a reloaded page reads to repaint its card. */
  pendingRequests(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /**
   * Ask a person one question and wait, or answer from policy when no one can be asked.
   *
   * `allowed-once` is the only grant: the caller decides what it means, and the escalation ladder applies it to
   * exactly one call. An abort or the timeout settles the question as `cancelled`; nothing is left hanging.
   */
  request(options: {
    readonly tool: string
    readonly reason: string
    readonly displayReason?: string
    readonly session?: string
    readonly signal?: AbortSignal
  }): Promise<ApprovalOutcome> {
    if (!this.canAnswer()) {
      return Promise.resolve(this.unanswered === 'allow' ? 'allowed-once' : 'unavailable')
    }
    if (options.signal?.aborted === true) return Promise.resolve('cancelled')
    const request: ApprovalRequest = {
      id: `approval-${randomUUID()}`,
      tool: options.tool,
      reason: options.reason,
      displayReason: options.displayReason ?? options.reason,
      ...(options.session !== undefined ? { session: options.session } : {}),
      at: new Date().toISOString(),
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        this.pending.delete(request.id)
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = (): void => settle('cancelled')
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => settle('cancelled'), this.answerTimeoutMs)
      this.pending.set(request.id, { request, settle })
      this.ctx.emit('approval/request', request)
    })
  }

  /** Answer one waiting question. Answers the id's outcome; `false` when it is already settled or unknown. */
  answer(id: string, outcome: 'allowed-once' | 'rejected' | 'cancelled'): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    entry.settle(outcome)
    return true
  }

  /** The decisions made in this process, in order. */
  history(): readonly { tool: string; allowed: boolean; reason?: string }[] {
    return this.decisions
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['approvals']`. */
    approvals: ApprovalService
  }

  interface Events {
    /** One question waiting for a person; emitted from the one write path that creates it. */
    'approval/request'(request: ApprovalRequest): void
  }
}

/**
 * The plugin is the service class itself, so the Cordis loader's own `inject`
 * row gates it — the mechanism DSH uses, rather than an exported `inject` array
 * that a hand-written `ctx.set` path ignores. Measured: the function form threw
 * "cannot get property ... without inject" while the loader reported nothing,
 * because `ctx.set` does not go through the inject gate.
 */
export default class ApprovalServicePlugin extends ApprovalService {
  /** Declared on the plugin so the loader validates and applies the row's config. */
  static readonly Config = Config
}
