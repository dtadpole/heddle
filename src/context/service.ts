import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { heddleHome } from '../config/schema.ts'
import type { Chunk, Message, ToolSpec } from '../llm/types.ts'
import { CONTEXT_WINDOW_EXCEEDED } from '../llm/types.ts'
import { deriveMessage, indexBySeq, type SessionEvent, type SessionHandle, type SessionStore } from '../session/store.ts'

import { resolveBudget, type Budget, type BudgetPolicy } from './budget.ts'
import { CompactionEngine, type CompactionOutcome } from './compaction.ts'
import {
  INSTRUCTIONS_MAX_BYTES,
  findInstructionFiles,
  renderInstructionBaseline,
  type InstructionBaseline,
} from './instructions.ts'
import { TokenMeter, type Measurement } from './meter.ts'
import { ToolResultPruner } from './prune.ts'

export * from './budget.ts'
export * from './compaction.ts'
export * from './instructions.ts'
export * from './meter.ts'
export * from './prune.ts'

export const name = 'context'

/** The origin of the harness's runtime-context snapshots; distinct from the system prompt and the instruction baseline. */
export const RUNTIME_CONTEXT_ORIGIN = 'runtime-context'

/** The prefix DSH gives a full snapshot, so a model with earlier ones in history reads the newest as current. */
export const RUNTIME_CONTEXT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

/** What a snapshot says when every contribution has gone away. */
export const CLEARED_RUNTIME_CONTEXT = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** One named contribution to a runtime-context snapshot, the way DSH attributes each part to its subsystem. */
export interface RuntimeContextSection {
  readonly name: string
  readonly text: string
}

/** Render DSH's joined snapshot text from the named contributions. */
function renderRuntimeContext(sections: readonly RuntimeContextSection[]): string {
  const body = sections
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
  return body.length === 0 ? CLEARED_RUNTIME_CONTEXT : `${RUNTIME_CONTEXT_HEADER}\n\n${body}`
}

export const Config = Schema.object({
  /** The system prompt, written to the surface as its first node. */
  system: Schema.string(),
  /** The context window to budget against, in tokens. */
  contextWindow: Schema.number().default(1_048_576),
  /** Compact when the estimate reaches this fraction of the window; defaults to 0.8. */
  thresholdRatio: Schema.number(),
  /** Keep this fraction of the window verbatim; defaults to 0.16. */
  retainRatio: Schema.number(),
  /** An absolute trigger, which beats the ratio. */
  thresholdTokens: Schema.number(),
  /** An absolute retained tail, which beats the ratio. */
  retainTokens: Schema.number(),
  /** Per-endpoint overrides, for a route with a smaller window than the rest. */
  policies: Schema.array(
    Schema.object({
      endpoint: Schema.string().required(),
      thresholdRatio: Schema.number(),
      retainRatio: Schema.number(),
      thresholdTokens: Schema.number(),
      retainTokens: Schema.number(),
    }),
  ).default([]),
  /** Read `AGENTS.md` and `CLAUDE.md` and keep them on the surface as a baseline. */
  instructions: Schema.boolean().default(true),
  /** The largest rendered baseline, in bytes. */
  instructionsMaxBytes: Schema.number().default(INSTRUCTIONS_MAX_BYTES),
  /** The endpoint a summary is asked of; defaults to the turn's. */
  endpoint: Schema.string(),
  /** The model a summary is asked of; defaults to the endpoint's. */
  model: Schema.string(),
  /** Cap on generated tokens for the summarising call. */
  summarizeMaxTokens: Schema.number().default(1024),
})

export interface Config {
  readonly system?: string
  readonly contextWindow?: number
  readonly thresholdRatio?: number
  readonly retainRatio?: number
  readonly thresholdTokens?: number
  readonly retainTokens?: number
  readonly policies?: readonly ({ readonly endpoint: string } & BudgetPolicy)[]
  readonly instructions?: boolean
  readonly instructionsMaxBytes?: number
  readonly endpoint?: string
  readonly model?: string
  readonly summarizeMaxTokens?: number
}

/** What one assembly was made of, for a caller that wants to report or check it. */
export interface ContextReport {
  readonly messages: readonly Message[]
  readonly estimatedTokens: number
  readonly contextWindow: number
  readonly thresholdTokens: number
  /** How many oversized tool results this call rewrote. */
  readonly pruned: number
  readonly compacted: boolean
  /** The instruction files the baseline carried, in the order it carried them. */
  readonly instructions: readonly string[]
  /**
   * The request's estimated size split the way the reference's context panel shows it — the system prompts,
   * the tool schemas, and every other message. The meter already computes these three; this surface is what
   * carries them to the log and then to the dock's context panel.
   */
  readonly breakdown: { readonly system: number; readonly tools: number; readonly messages: number }
}

/** What {@link ContextService.ensureContext} did, so a caller need not guess. */
export interface BaselineOutcome {
  readonly systemSeq?: number
  readonly instructionsSeq?: number
  readonly instructions: readonly string[]
  /** True when anything was written; false when the surface already said all of this. */
  readonly wrote: boolean
}

/** How the service reaches a model for a summary, injected so the service stays context-free. */
export interface ContextDependencies {
  /** The routed endpoint's own window, when its adapter declares one. */
  readonly endpointWindow?: (endpoint: string) => number | undefined
  /** One non-streaming completion, for the summarising call. */
  readonly complete?: (request: {
    readonly endpoint: string
    readonly model?: string
    readonly messages: readonly Message[]
    readonly maxOutputTokens?: number
    /** Tags the call for a consumer that treats a summary differently from a turn. */
    readonly purpose?: string
  }) => Promise<string>
}

/**
 * The context service.
 *
 * It owns the four things a request's context is made of, and each is a separate module because
 * each is judged separately: the **surface** a log is read through (the session store), the
 * **meter** that prices it, the **budget** resolved for the routed endpoint, and the **compaction**
 * that prunes and then summarises when the price is over the trigger. The service is the seam the
 * loop talks to, and it is deliberately the only place that knows all four.
 *
 * The order in {@link prepare} is the policy, and it is DSH's order: derive, measure, prune if over
 * the trigger, measure again, and only summarise what pruning could not fix.
 */
export class ContextService extends Service {
  static readonly provide = 'context'

  readonly store: SessionStore
  readonly meter = new TokenMeter()
  readonly compaction: CompactionEngine
  readonly pruner: ToolResultPruner
  private readonly config: Config
  private readonly dependencies: ContextDependencies

  constructor(ctx: Context, store: SessionStore, config: Config = {}, dependencies: ContextDependencies = {}) {
    super(ctx, 'context')
    this.store = store
    this.config = config
    this.dependencies = dependencies
    this.pruner = new ToolResultPruner()
    this.compaction = new CompactionEngine(store, this.pruner)
  }

  /** The budget for one endpoint, resolved from its own window when it declares one. */
  budget(endpoint?: string): Budget {
    const endpointWindow = endpoint === undefined ? undefined : this.dependencies.endpointWindow?.(endpoint)
    return resolveBudget({
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(endpointWindow !== undefined ? { endpointWindow } : {}),
      ...(this.config.contextWindow !== undefined ? { configWindow: this.config.contextWindow } : {}),
      configPolicy: {
        ...(this.config.thresholdRatio !== undefined ? { thresholdRatio: this.config.thresholdRatio } : {}),
        ...(this.config.retainRatio !== undefined ? { retainRatio: this.config.retainRatio } : {}),
        ...(this.config.thresholdTokens !== undefined ? { thresholdTokens: this.config.thresholdTokens } : {}),
        ...(this.config.retainTokens !== undefined ? { retainTokens: this.config.retainTokens } : {}),
      },
      ...(this.config.policies !== undefined ? { policies: this.config.policies } : {}),
    })
  }

  /**
   * Price the surface as it stands.
   *
   * The provider's own number is offered to the meter, tagged with the generation it was measured
   * at, and the meter decides whether it may anchor the estimate. Reading it here rather than in
   * the meter is deliberate: the anchor is a fact about the *log* (which request, which answer),
   * while the meter only knows how to price.
   */
  measure(handle: SessionHandle, options: { readonly tools?: readonly ToolSpec[] } = {}): Measurement {
    const events = this.store.read(handle)
    const bySeq = indexBySeq(events)
    const state = this.store.surface(handle)
    const nodes: { seq: number; message: Message }[] = []
    for (const seq of state.nodes) {
      const message = deriveMessage(bySeq, seq)
      if (message !== null) nodes.push({ seq, message })
    }
    const usage = this.lastUsage(events)
    return this.meter.measure({
      nodes,
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      generation: state.contentGeneration,
      ...(usage !== undefined ? { usage } : {}),
    })
  }

  /** The provider usage of the last completed call, with the generation of the request that made it. */
  private lastUsage(events: readonly SessionEvent[]): { inputTokens?: number; outputTokens?: number; generation: number } | undefined {
    let anchor: number | undefined
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    for (const event of events) {
      if (event.type === 'model/request') {
        const generation = event.generation
        anchor = typeof generation === 'number' ? generation : undefined
        usage = undefined
        continue
      }
      if (event.type !== 'assistant/chunk' || anchor === undefined) continue
      const chunk = event.chunk as Chunk | undefined
      if (chunk?.type === 'done' && chunk.usage !== undefined) usage = chunk.usage
    }
    if (anchor === undefined || usage === undefined) return undefined
    return { ...usage, generation: anchor }
  }

  /**
   * Keep the runtime-context snapshot current, the way DSH's agent loop does.
   *
   * The standing file policy is **dynamic context**, not a stable prompt section: DSH assembles the registered
   * contexts before every request and, when the rendered snapshot differs from the retained one, logs it as a
   * sourced `user/message` with "This snapshot supersedes earlier runtime-context snapshots." The earlier
   * snapshots stay in history — that is what lets a later round, a replay, or a reader after the fact see which
   * policy each step ran under — while the newest one is the standing fact.
   *
   * Heddle had a replacing note before this: it kept the model's request correct but erased from model history
   * *when* the expectation changed. This is the DSH shape instead: append on change, write nothing when nothing
   * changed (so an unchanged request reuses the retained snapshot), and attribute the parts so a log reader can
   * see that the harness said it, not a person.
   *
   * A session written by the old mechanism carries a `sandbox-policy` note; the first snapshot **replaces** it, so
   * the model never reads a stale "Current …" sentence beside the current snapshot.
   */
  recordRuntimeContext(handle: SessionHandle, sections: readonly RuntimeContextSection[]): void {
    const snapshot = renderRuntimeContext(sections)
    const events = this.store.read(handle)
    let retained: { readonly seq: number; readonly identity?: unknown } | undefined
    let legacy: { readonly seq: number } | undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'context/note') continue
      if (event.origin === RUNTIME_CONTEXT_ORIGIN) {
        retained = { seq: event.seq, ...(event.identity !== undefined ? { identity: event.identity } : {}) }
        break
      }
      if (event.origin === 'sandbox-policy' && legacy === undefined) legacy = { seq: event.seq }
    }
    if (retained !== undefined && retained.identity === snapshot) return
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: snapshot }],
      source: sections.length === 0 ? { kind: RUNTIME_CONTEXT_ORIGIN } : { kind: RUNTIME_CONTEXT_ORIGIN, form: 'snapshot', sections },
    }
    const legacyIsSurface =
      retained === undefined && legacy !== undefined && this.store.surface(handle).nodes.includes(legacy.seq)
    if (retained === undefined && legacyIsSurface && legacy !== undefined) {
      this.store.append(
        handle,
        { type: 'context/note', message, origin: RUNTIME_CONTEXT_ORIGIN, identity: snapshot },
        { surfaceOp: { op: 'replace', startSeq: legacy.seq, endSeq: legacy.seq }, sourceEventSeqs: [legacy.seq] },
      )
      return
    }
    this.store.append(handle, { type: 'context/note', message, origin: RUNTIME_CONTEXT_ORIGIN, identity: snapshot }, { surfaceOp: 'append' })
  }

  /**
   * Make sure the surface says what this run means it to say, once.
   *
   * Two things live here rather than in the loop, because both are context policy: the **system
   * prompt** is written as the surface's first node (the paradigm's shape — a prompt is a message
   * the model reads, not a field beside the messages), and the **instruction baseline** is one
   * durable user-role message that is re-sent only when its digest changes.
   *
   * Both are written as `context/note` events rather than `message` ones, and that is a claim about
   * who wrote them: a view of the conversation is a view of what a person and a model said, and a
   * note the harness composed is neither. Writing them as messages made the Web UI show a project's
   * instructions — and later a compaction — as though the user had typed them.
   *
   * Called at the start of every round, so a file edited by a tool is picked up on the next round
   * through a digest comparison rather than a message.
   */
  ensureContext(handle: SessionHandle, options: { readonly cwd: string; readonly system?: string }): BaselineOutcome {
    const before = this.store.count(handle)
    const state = this.store.surface(handle)
    const bySeq = indexBySeq(this.store.read(handle))
    const headSeq = state.nodes[0]
    const head = headSeq === undefined ? null : deriveMessage(bySeq, headSeq)
    const system = options.system ?? this.config.system
    let systemSeq: number | undefined

    if (system !== undefined && system.length > 0 && head?.role !== 'system') {
      systemSeq = this.store.append(
        handle,
        { type: 'context/note', message: { role: 'system', content: [{ type: 'text', text: system }] }, origin: 'system-prompt' },
        { surfaceOp: 'append' },
      ).seq
    }

    const instructions = this.config.instructions === false
      ? []
      : findInstructionFiles(options.cwd, { home: heddleHome() })
    const rendered: InstructionBaseline | undefined =
      instructions.length === 0
        ? undefined
        : renderInstructionBaseline(instructions, this.config.instructionsMaxBytes ?? INSTRUCTIONS_MAX_BYTES)

    let instructionsSeq: number | undefined
    if (rendered !== undefined) {
      const current = this.currentBaseline(handle)
      if (current === undefined) {
        instructionsSeq = this.store.append(
          handle,
          {
            type: 'context/note',
            message: { role: 'user', content: [{ type: 'text', text: rendered.text }] },
            origin: 'instructions',
            identity: rendered.identity,
            files: rendered.included,
          },
          { surfaceOp: 'append' },
        ).seq
      } else if (current.identity !== rendered.identity) {
        /**
         * A changed baseline **replaces** the old node rather than piling up beside it.
         *
         * One node is what keeps the instruction budget meaningful across an edit; appending would
         * leave the model reading the old rules and the new ones.
         */
        instructionsSeq = this.store.append(
          handle,
          {
            type: 'context/note',
            message: { role: 'user', content: [{ type: 'text', text: rendered.text }] },
            origin: 'instructions',
            identity: rendered.identity,
            files: rendered.included,
          },
          { surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq }, sourceEventSeqs: [current.seq] },
        ).seq
      } else {
        instructionsSeq = current.seq
      }
    }

    const wrote = this.store.count(handle) !== before
    return {
      ...(systemSeq !== undefined ? { systemSeq } : {}),
      ...(instructionsSeq !== undefined ? { instructionsSeq } : {}),
      instructions: rendered?.included ?? [],
      wrote,
    }
  }

  /** The instruction node currently on the surface, with the digest it was rendered from. */
  private currentBaseline(handle: SessionHandle): { readonly seq: number; readonly identity: string } | undefined {
    const bySeq = indexBySeq(this.store.read(handle))
    for (const seq of [...this.store.surface(handle).nodes].reverse()) {
      const event = bySeq.get(seq)
      if (event?.origin !== 'instructions') continue
      const identity = event.identity
      return { seq, identity: typeof identity === 'string' ? identity : '' }
    }
    return undefined
  }

  /**
   * Assemble one request's context: what a caller would send right now.
   *
   * This may write the system prompt or the instruction baseline the first time it is called,
   * because "what the model will read" includes them; after that it is a read.
   */
  assemble(
    handle: SessionHandle,
    options: { readonly cwd: string; readonly tools?: readonly ToolSpec[]; readonly system?: string; readonly endpoint?: string },
  ): ContextReport {
    const baseline = this.ensureContext(handle, { cwd: options.cwd, ...(options.system !== undefined ? { system: options.system } : {}) })
    return this.report(handle, {
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      instructions: baseline.instructions,
    })
  }

  /**
   * The whole per-round policy: assemble, prune, summarise if still over the trigger.
   *
   * `force` is overflow recovery — the provider has already said the window was exceeded, so the
   * trigger and the retained tail are both bypassed and one maximal balanced reduction is taken.
   */
  async prepare(
    handle: SessionHandle,
    options: {
      readonly cwd: string
      readonly endpoint: string
      readonly model?: string
      readonly tools?: readonly ToolSpec[]
      readonly system?: string
      readonly summarize?: (messages: readonly Message[]) => Promise<string>
      readonly force?: boolean
    },
  ): Promise<ContextReport> {
    const baseline = this.ensureContext(handle, { cwd: options.cwd, ...(options.system !== undefined ? { system: options.system } : {}) })
    const budget = this.budget(options.endpoint)
    const tools = options.tools
    const measurement = this.measure(handle, tools !== undefined ? { tools } : {})
    const outcome = await this.compaction.compactIfNeeded(handle, {
      budget,
      measurement,
      ...(options.force !== undefined ? { force: options.force } : {}),
      summarize: options.summarize ?? this.defaultSummarizer(options),
      measure: () => this.measure(handle, tools !== undefined ? { tools } : {}),
    })
    return this.report(handle, {
      ...(tools !== undefined ? { tools } : {}),
      endpoint: options.endpoint,
      instructions: baseline.instructions,
      outcome,
    })
  }

  /** The default summariser: one call, the replayed prefix, and the configured cap. */
  private defaultSummarizer(options: { readonly endpoint: string; readonly model?: string }): (messages: readonly Message[]) => Promise<string> {
    const complete = this.dependencies.complete
    const endpoint = this.config.endpoint ?? options.endpoint
    const model = this.config.model ?? options.model
    return async (messages) => {
      if (complete === undefined) throw new Error('context: no model is available to summarise with')
      return complete({
        endpoint,
        ...(model !== undefined ? { model } : {}),
        messages,
        maxOutputTokens: this.config.summarizeMaxTokens ?? 1024,
        purpose: 'compaction',
      })    }
  }

  /** Build the report every caller reads, measuring the surface once more after any rewrite. */
  private report(
    handle: SessionHandle,
    options: {
      readonly tools?: readonly ToolSpec[]
      readonly instructions: readonly string[]
      readonly outcome?: CompactionOutcome
      readonly endpoint?: string
    },
  ): ContextReport {
    const measurement = this.measure(handle, options.tools !== undefined ? { tools: options.tools } : {})
    const budget = this.budget(options.endpoint)
    return {
      messages: this.store.deriveMessages(handle),
      estimatedTokens: measurement.totalTokens,
      contextWindow: budget.contextWindow,
      thresholdTokens: budget.thresholdTokens,
      pruned: options.outcome?.pruned ?? 0,
      compacted: options.outcome?.compacted ?? false,
      instructions: options.instructions,
      breakdown: { system: measurement.systemTokens, tools: measurement.toolsTokens, messages: measurement.messageTokens },
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['context']`. */
    context: ContextService
  }
}

/** The context plugin: the budget, the meter, the pruner and the compaction, wired to a model. */
export default class ContextPlugin extends ContextService {
  static readonly Config = Config

  static readonly inject = ['model', 'session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, ctx.session.store, config, {
      endpointWindow: (endpoint) => ctx.model.endpoint(endpoint)?.contextWindow,
      complete: async (request) => {
        const result = await ctx.model.generate({
          endpoint: request.endpoint,
          ...(request.model !== undefined ? { model: request.model } : {}),
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
        })
        return result.text
      },
    })

    /**
     * Overflow recovery, registered where DSH registers it.
     *
     * A provider that refused a call because the conversation did not fit is answered with one
     * forced reduction, and the loop is granted a retry **only if a replacement actually landed** —
     * a retry without a landed rewrite would send the same too-long request and fail the same way.
     * Reading `replaceGeneration` before and after is how that is decided rather than assumed.
     */
    ctx.on('agent/request-error', async (payload, next) => {
      const seen = payload.error.code
      if (seen !== CONTEXT_WINDOW_EXCEEDED) {
        ctx.session.store.append(payload.session, { type: 'compaction/recovery', code: seen, retry: false, reason: 'not a window overflow' })
        return next()
      }
      const before = ctx.session.surface(payload.session).replaceGeneration
      await this.prepare(payload.session, {
        cwd: payload.cwd,
        endpoint: payload.endpoint,
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        tools: payload.tools,
        force: true,
      })
      const after = ctx.session.surface(payload.session).replaceGeneration
      /**
       * The decision is recorded, because the two answers look identical from outside.
       *
       * A refusal that cannot be reduced and a reduction that landed before the retry both leave
       * the provider's own error as the only visible trace; this event is what tells them apart
       * after the fact.
       */
      ctx.session.store.append(payload.session, {
        type: 'compaction/recovery',
        code: payload.error.code,
        generationBefore: before,
        generationAfter: after,
        retry: after > before,
      })
      if (after <= before) return next()
      return { kind: 'retry' as const }
    })
  }
}
