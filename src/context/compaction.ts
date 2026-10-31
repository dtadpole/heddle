import type { Message } from '../llm/types.ts'
import { deriveMessage, indexBySeq, type SessionEvent, type SessionHandle, type SessionStore } from '../session/store.ts'

import type { Budget } from './budget.ts'
import { estimateMessage, type Measurement } from './meter.ts'
import { ToolResultPruner } from './prune.ts'

/**
 * Compaction: condensing the oldest part of a surface into one checkpoint.
 *
 * Modelled on `@deepseek-ai/dsh-compaction-basic`, and the parts worth naming are the ones that
 * make it safe to run on a conversation somebody is having:
 *
 * - **The log is never rewritten.** A compaction appends a summary record and one replacement node
 *   whose `surfaceOp` shadows a span; the shadowed events stay readable, so a transcript still
 *   shows what was said and a replay is exact.
 * - **The cut is balanced.** No range may separate an assistant's tool call from the result that
 *   answers it, because a provider rejects a tool call it never sees answered. DSH walks the cut
 *   backwards until the pairing balances; so does this.
 * - **A summary that does not shrink is refused.** Accepting one would spend a model call to make
 *   the conversation longer, and the next round would compact the same span again.
 * - **The summarizer replays the real prefix.** The system node plus the shadowed region plus the
 *   instruction is what the model last saw, so the auxiliary call reuses the provider's warm
 *   prefix instead of paying for the conversation twice.
 * - **Pruning comes first, inside the same call.** Trimming one oversized tool result is cheaper
 *   than summarising twenty small messages, and if trimming clears the pressure nothing is
 *   summarised at all.
 */

/**
 * What the summarizer is asked, which is the final user message of the auxiliary call: DSH's directive, verbatim
 * (dsh-compaction-basic `COMPACTION_INSTRUCTION`).
 *
 * It replaced a four-sentence request ("Summarise the conversation above ... a briefing to yourself") that a model
 * could read as one more turn of the conversation (#77). When the replayed span ended with a pending user request,
 * the DeepSeek reasoning model answered that request and wrote the next part of an essay as the "summary", and the
 * session lost what the older span held. DSH's directive names the role (a compaction engine), fixes a structure with
 * every section kept, and forbids any other action, so the auxiliary call stays a checkpoint.
 */
export const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
  "",
  "Rules:",
  "- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  "- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.",
].join('\n')

/** The tags a checkpoint's text carries, so a reader can tell it from something a person said. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** The span one compaction will shadow, chosen before anything is written. */
export interface CompactionPlan {
  readonly fromSeq: number
  readonly throughSeq: number
  readonly shadowedSeqs: readonly number[]
  /** What is kept verbatim, newest last; a plan never touches it. */
  readonly retainedSeqs: readonly number[]
  /** The route-priced cost of the span, which the summary has to beat. */
  readonly shadowedTokens: number
}

/** What a compaction did, in numbers a caller can report. */
export interface CompactionOutcome {
  readonly compacted: boolean
  readonly reason?: string
  /** How many oversized tool results were rewritten before the summary was considered. */
  readonly pruned: number
  readonly before: number
  readonly after: number
  readonly plan?: CompactionPlan
  readonly reasonSeq?: number
  readonly summarySeq?: number
  readonly replacementSeq?: number
}

/** What a compaction needs from whoever calls it. */
export interface CompactOptions {
  readonly budget: Budget
  /** The measurement the decision was taken on. */
  readonly measurement: Measurement
  /**
   * One model call that returns the summary text.
   *
   * Passed in rather than reached for, so the engine stays a plain class with no context and a
   * check can compact without spending anything.
   */
  readonly summarize: (messages: readonly Message[]) => Promise<string>
  /** Take a fresh measurement — after a prune, and after a replacement. */
  readonly measure: () => Measurement
}

/** {@link CompactOptions} plus the one switch overflow recovery needs. */
export interface CompactIfNeededOptions extends CompactOptions {
  /**
   * Ignore the threshold and the retention floor.
   *
   * This is what a provider-confirmed overflow asks for: the window was already exceeded, so
   * waiting for a trigger and keeping a recent tail are both wrong, and one maximal balanced
   * reduction is what can still save the turn.
   */
  readonly force?: boolean
}

/** Wrap a summary the way the model should read it. */
export function frameSummary(summary: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}` }],
  }
}

/**
 * Whether cutting the surface before `index` keeps every answered tool call paired.
 *
 * A call the surface never answers is ignored rather than counted as open: a model that asked for a
 * tool and then stopped would otherwise leave the pairing permanently unbalanced and the whole
 * conversation un-compactable. Only calls that *are* answered somewhere constrain the cut.
 */
export function toolPairingBalancedBefore(
  nodes: readonly number[],
  bySeq: ReadonlyMap<number, SessionEvent>,
  index: number,
): boolean {
  const answered = new Set<string>()
  for (const seq of nodes) {
    const message = deriveMessage(bySeq, seq)
    if (message?.role === 'tool' && message.toolCallId !== undefined) answered.add(message.toolCallId)
  }

  const open = new Set<string>()
  for (let position = 0; position < index; position += 1) {
    const seq = nodes[position]
    if (seq === undefined) continue
    const message = deriveMessage(bySeq, seq)
    if (message === null) continue
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call' && answered.has(part.id)) open.add(part.id)
      }
    } else if (message.role === 'tool' && message.toolCallId !== undefined) {
      open.delete(message.toolCallId)
    }
  }
  return open.size === 0
}

/** The compaction engine: prune, choose a span, summarise it, shadow it. */
export class CompactionEngine {
  private readonly store: SessionStore
  private readonly pruner: ToolResultPruner

  constructor(store: SessionStore, pruner?: ToolResultPruner) {
    this.store = store
    this.pruner = pruner ?? new ToolResultPruner()
  }

  /**
   * Choose the span to shadow, or `null` when there is nothing safe to take.
   *
   * The shape is DSH's: start at the first node that is not the system prompt, keep a tail priced
   * at `retainTokens` verbatim, and walk the cut backwards until no tool call is separated from its
   * result. A `null` is a real answer rather than a failure — a conversation that is over budget
   * with nothing safely removable is a conversation that has to be answered over budget.
   */
  plan(
    handle: SessionHandle,
    budget: Budget,
    measurement: Measurement,
    options: { readonly retainTokens?: number } = {},
  ): CompactionPlan | null {
    const nodes = this.store.surface(handle).nodes
    if (nodes.length === 0) return null

    if (measurement.nodes.length !== nodes.length || nodes.some((seq, index) => measurement.nodes[index]?.seq !== seq)) {
      throw new Error('compaction: the measurement is of a different surface than the one on disk')
    }
    const priced = new Map(measurement.nodes.map((node) => [node.seq, node.tokens]))

    const bySeq = indexBySeq(this.store.read(handle))
    const headSeq = nodes[0]
    const head = headSeq === undefined ? null : deriveMessage(bySeq, headSeq)
    const firstIdx = head?.role === 'system' ? 1 : 0

    const retainTokens = options.retainTokens ?? budget.retainTokens
    let accumulated = 0
    let keepFromIdx = nodes.length
    for (let index = nodes.length - 1; index >= firstIdx; index -= 1) {
      const seq = nodes[index]
      accumulated += seq === undefined ? 0 : (priced.get(seq) ?? 0)
      keepFromIdx = index
      if (accumulated >= retainTokens) break
    }
    if (keepFromIdx <= firstIdx) return null

    while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(nodes, bySeq, keepFromIdx)) keepFromIdx -= 1
    if (keepFromIdx <= firstIdx) return null

    const shadowedSeqs = nodes.slice(firstIdx, keepFromIdx)
    const fromSeq = shadowedSeqs[0]
    const throughSeq = shadowedSeqs[shadowedSeqs.length - 1]
    if (fromSeq === undefined || throughSeq === undefined) return null

    return {
      fromSeq,
      throughSeq,
      shadowedSeqs,
      retainedSeqs: nodes.slice(keepFromIdx),
      shadowedTokens: shadowedSeqs.reduce((total, seq) => total + (priced.get(seq) ?? 0), 0),
    }
  }

  /** Summarise a planned span and shadow it, or record why it was not shadowed. */
  async compact(handle: SessionHandle, plan: CompactionPlan, options: CompactOptions): Promise<CompactionOutcome> {
    const bySeq = indexBySeq(this.store.read(handle))
    const messages: Message[] = []
    const headSeq = this.store.surface(handle).nodes[0]
    const head = headSeq === undefined ? null : deriveMessage(bySeq, headSeq)
    // The replayed prefix is what the last request carried: the prompt as it stands, then the span.
    if (head?.role === 'system') messages.push(head)
    for (const seq of plan.shadowedSeqs) {
      const message = deriveMessage(bySeq, seq)
      if (message !== null) messages.push(message)
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] })

    const startEvent = this.store.append(handle, {
      type: 'compaction/start',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      shadowedSeqs: plan.shadowedSeqs,
      shadowedTokenCount: plan.shadowedTokens,
      estimatedTokens: options.measurement.totalTokens,
      thresholdTokens: options.budget.thresholdTokens,
    })

    let summary: string
    try {
      summary = await options.summarize(messages)
    } catch (error) {
      return this.refuse(handle, plan, options, `the summariser failed — ${(error as Error).message}`)
    }
    if (summary.trim().length === 0) {
      return this.refuse(handle, plan, options, 'the summariser returned nothing')
    }

    const checkpoint = frameSummary(summary)
    const checkpointTokens = estimateMessage(checkpoint)
    if (checkpointTokens >= plan.shadowedTokens) {
      return this.refuse(
        handle,
        plan,
        options,
        `the summary is not smaller than the span it would shadow (${checkpointTokens} estimated tokens >= ${plan.shadowedTokens})`,
      )
    }

    const summaryEvent = this.store.append(handle, {
      type: 'compaction/summary',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      summary: checkpoint.content[0]?.type === 'text' ? checkpoint.content[0].text : summary,
      shadowedSeqs: plan.shadowedSeqs,
      shadowedTokenCount: plan.shadowedTokens,
      estimatedTokens: checkpointTokens,
    })

    /**
     * The one surface mutation of the whole transaction.
     *
     * The replacement **is** the checkpoint message: it takes the span's position, and because the
     * summary record above is log-only, the model reads the summary exactly once. Writing it as a
     * separate durable message as well is the mistake this shape exists to prevent.
     */
    const replacement = this.store.append(
      handle,
      /**
       * A note, not a message: the checkpoint is something the harness wrote.
       *
       * Its role is `user` because that is where a model reads a briefing best, but a transcript is a
       * view of what a person said, and this was not said by one.
       */
      { type: 'context/note', message: checkpoint, origin: 'compaction' },
      {
        surfaceOp: { op: 'replace', startSeq: plan.fromSeq, endSeq: plan.throughSeq },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.shadowedSeqs],
      },
    )

    this.store.append(handle, {
      type: 'compaction/end',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      summarySeq: summaryEvent.seq,
      replacementSeq: replacement.seq,
    })

    const after = options.measure()
    this.store.append(handle, { type: 'compaction/measured', before: options.measurement.totalTokens, after: after.totalTokens })

    return {
      compacted: true,
      pruned: 0,
      before: options.measurement.totalTokens,
      after: after.totalTokens,
      plan,
      summarySeq: summaryEvent.seq,
      replacementSeq: replacement.seq,
    }
  }

  /**
   * Prune first, then summarise — and only if the estimate is still over the trigger afterwards.
   *
   * This is the whole per-round policy in one call, and the order is the policy: a pruning that
   * clears the pressure saves the model call a summary would have cost, which is why the second
   * measurement exists rather than being assumed.
   */
  async compactIfNeeded(handle: SessionHandle, options: CompactIfNeededOptions): Promise<CompactionOutcome> {
    const force = options.force === true
    const before = options.measurement.totalTokens
    if (!force && before < options.budget.thresholdTokens) {
      return { compacted: false, pruned: 0, before, after: before }
    }

    const { pruned } = this.pruner.pruneSession(this.store, handle)
    let measured = pruned > 0 ? options.measure() : options.measurement
    if (!force && measured.totalTokens < options.budget.thresholdTokens) {
      return { compacted: false, pruned, before, after: measured.totalTokens }
    }

    let plan = this.plan(handle, options.budget, measured, force ? { retainTokens: 0 } : {})
    if (plan === null && force) {
      // Overflow recovery still wants the largest reduction it can take; a retained tail is a
      // preference, and the window has already been exceeded.
      plan = this.plan(handle, options.budget, measured, { retainTokens: 0 })
    }
    if (plan === null) {
      return {
        compacted: false,
        pruned,
        before,
        after: measured.totalTokens,
        reason: 'nothing safe to compact: every span would split a tool call from its result',
      }
    }

    const outcome = await this.compact(handle, plan, { ...options, measurement: measured })
    return { ...outcome, pruned }
  }

  /** Record a refused compaction and report it, leaving the surface exactly as it was. */
  private refuse(handle: SessionHandle, plan: CompactionPlan, options: CompactOptions, reason: string): CompactionOutcome {
    const event = this.store.append(handle, {
      type: 'compaction/failed',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      refused: true,
      reason,
    })
    return {
      compacted: false,
      reason,
      pruned: 0,
      before: options.measurement.totalTokens,
      after: options.measurement.totalTokens,
      plan,
      reasonSeq: event.seq,
    }
  }
}
