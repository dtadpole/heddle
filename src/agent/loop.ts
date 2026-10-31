import { mergeTokenUsage } from '../llm/usage.ts'
import type { TokenUsage } from '../llm/usage.ts'
import type { Context } from '@deepseek-ai/cordis'

import type { Chunk, ContentPart, Message, ToolSpec } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'
import type { TurnRegistry } from './turns.ts'
import type { ToolResult } from '../tools/service.ts'
import { sandboxPolicyStatement } from '../sandbox/policy.ts'
import { claimNextStep, hasPendingStep } from '../session/inbox.ts'
import { recordTimeContext } from '../schedule/time-context.ts'

/**
 * A model failure, read the way a seam has to read it: **by its code, not by its class**.
 *
 * Measured while building recovery: the CLI runs from `dist/`, while a profile's plugin tree loads
 * from `src/`, so the error thrown by the model service and the error class this file could compare
 * against were **two different classes with the same name** and `instanceof` was false for every
 * failure. The code is the contract between them, which is also how DSH reads a provider failure —
 * `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` — and it survives a plugin boundary, a bundle, or
 * a second copy of the module.
 */
function modelFailure(error: unknown): { readonly code: string; readonly message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  const message = (error as { message?: unknown }).message
  return { code, message: typeof message === 'string' ? message : String(error) }
}

/** The surface positions that hold a user message, which is what "new input" means to a running turn. */
function userInputSeqs(ctx: Context, session: SessionHandle): ReadonlySet<number> {
  const held = new Set<number>()
  for (const seq of ctx.session.surface(session).nodes) {
    if (ctx.session.node(session, seq)?.role === 'user') held.add(seq)
  }
  return held
}

/**
 * Whether a message arrived that this loop did not put there.
 *
 * The rule it exists for is DSH's steering: a message delivered **into a running turn** is answered by that
 * turn rather than by the next one. The loop already re-derives its context from the surface at the top of
 * every round, so what was missing was only the decision to take another round when the model answers without
 * asking for a tool — and that decision is this comparison, taken at the moment the answer completes.
 */
export function hasNewInput(before: ReadonlySet<number>, after: ReadonlySet<number>): boolean {
  for (const seq of after) if (!before.has(seq)) return true
  return false
}

/**
 * The agent loop.
 *
 * One turn is: record the user's message, ask the model, run whatever tools it
 * asked for, feed the results back, and stop when it answers without asking for
 * another tool. Every step is on disk **before** the next one starts, so a killed
 * run reads as a partial turn rather than as nothing.
 *
 * The loop is deliberately small and lives outside the plugins that supply its
 * parts. It has no knowledge of which endpoint answers, which tools exist, or what
 * the sandbox permits; it asks for all three through services. That is what makes
 * the parts independently verifiable — each one's own verifier judges it without
 * the loop, and the end-to-end verifier judges the loop with all of them.
 *
 * Context is one of those parts, and the loop owns exactly one decision about it: when. It asks
 * `ctx.context.prepare(...)` at the top of every round, which derives the request from the surface,
 * prunes and summarises if the price is over the trigger, and answers with what to send. The
 * **recovery** path is the second decision: when a provider refuses a call because the window was
 * exceeded, the loop offers that failure on `agent/request-error` and retries only if something
 * durable happened — a compaction landing is what makes a retry different from a repeat.
 */

/** What happened in one turn, including what was refused. */
export interface TurnResult {
  /** The answer's text, which is what a caller prints. */
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly { name: string; arguments: string; result: ToolResult }[]
  /** Refusals, kept separate because a refused call is the sandbox's evidence. */
  readonly denials: readonly { tool: string; code: string; message: string }[]
  readonly finishReason: string
  /** How many events the turn added, so a caller can point at the transcript. */
  readonly events: number
  /** Rounds of model-plus-tools this turn took. */
  readonly rounds: number
  /** What the last context preparation was, so a caller can report the budget. */
  readonly context?: { readonly estimatedTokens: number; readonly thresholdTokens: number; readonly pruned: number; readonly compacted: boolean }
  /**
   * Why the turn stopped early, in the loop's own words — the round limit is the usual one. Kept on the result
   * **and** in the completed event so a page can say it instead of looking like it did nothing.
   */
  readonly ended?: readonly string[]
  /**
   * Tokens the provider said this turn used, when it said.
   *
   * Providers report usage per round, and a turn has several rounds when tools are involved, so this is the
   * sum. Absent when no round reported any — the status line under the composer prints a rate only from a
   * number the provider actually sent.
   */
  readonly usage?: TokenUsage
}

/**
 * Add one round's reported usage to the turn's running total.
 *
 * Kept as a function so the rule can be judged without a provider: a field stays absent until a round reports
 * it, and rounds add up rather than overwrite, because a turn with tools is several model calls.
 */
export function mergeUsage(previous: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  return mergeTokenUsage(previous, next)
}

export interface RunTurnOptions {
  /** The session this turn is recorded in. */
  readonly session: SessionHandle
  /** Which configured endpoint answers. */
  readonly endpoint: string
  /** The user's message for this turn. */
  readonly prompt: string
  /**
   * Files attached to the message, as typed content blocks.
   *
   * They are recorded with the user message beside its text and projected for the provider at request
   * time: the loop never has to know what an upload is, and the session log keeps the durable reference.
   */
  readonly attachments?: readonly ContentPart[]
  /** Who wrote the prompt, when it was not a person — an automatic goal round sets this. */
  readonly source?: unknown
  /**
   * Answer input that is already in the log instead of writing `prompt` as a new message.
   *
   * For a background child's settlement notice that was delivered into a turn which ended before it saw it: the
   * notice is in the log once, and the turn that answers it must not write it a second time.
   */
  readonly answerPending?: boolean
  /** A system prompt, written to the surface as its first node when the session has none. */
  readonly system?: string
  /** The model id, overriding the endpoint's default. */
  readonly model?: string
  /** The reasoning level, as an id the model declares; the adapter turns it into the provider's wire value. */
  readonly reasoningEffort?: string
  /** Cap on model-plus-tools rounds, so a looping model cannot run forever. */
  readonly maxRounds?: number
  /** Cap on generated tokens per model call. */
  readonly maxOutputTokens?: number
  /** How many times one round may be retried after the provider refused it as too long. */
  readonly maxOverflowRetries?: number
  /**
   * What this turn is for, when it is not an ordinary person-to-agent turn.
   *
   * It reaches the model call unchanged, so a backend that distinguishes calls (a summariser, a test double, a
   * teammate's automatic turn) can answer them differently. The team layer tags its turns `team`.
   */
  readonly purpose?: string
  readonly signal?: AbortSignal
}

/** The services a turn needs, narrowed to what it uses. */
interface TurnDeps {
  readonly ctx: Context
  readonly model: {
    names(): readonly string[]
    stream(request: Parameters<Context['model']['stream']>[0], signal?: AbortSignal): AsyncIterable<Chunk>
  }
  readonly session: Context['session']
  readonly tools: Context['tools']
}

/** Turn the tool registry's descriptions into what the model is told. */
function specsOf(tools: Context['tools']): readonly ToolSpec[] {
  return tools.describe().map((spec) => spec)
}

/**
 * Run one turn.
 *
 * `maxRounds` defaults to eight for a one-shot turn: enough for a task that reads, writes and checks, and small
 * enough that an unattended model which keeps asking for tools is stopped with a readable transcript rather than an
 * open-ended bill. The Web UI passes `Infinity`, which is the reference's own rule — DSH's agent loop has no step
 * cap (measured: its logs hold turns of 436 steps, and its contexts are bounded by compaction, not by cutting the
 * turn) — and an operator can still name a cap with `heddle web --max-rounds`. `maxOverflowRetries` defaults
 * to one, which is DSH's default and enough for the one thing a retry can fix.
 */
export async function runTurn(ctx: Context, options: RunTurnOptions): Promise<TurnResult> {
  /**
   * The live-turn registry is optional: a minimal profile can run turns without interruption. When it is
   * present, the turn's own signal is **combined** with the caller's, so a person's stop and a Lead's
   * `interrupt_agent` both take effect, and the entry is removed whichever way the turn ends.
   */
  /**
   * The registry is read **without** the inject requirement (`ctx.get`): a turn is also started from a plugin's
   * own fiber — a teammate's automatic turn — where the guarded property access throws "cannot get property
   * turns without inject". The row stays optional, which is the other half of why this is a store read.
   */
  const turns = ctx.get('turns') as TurnRegistry | undefined
  const live = turns?.begin(options.session.id)
  const signal =
    live === undefined
      ? options.signal
      : options.signal === undefined
        ? live.signal
        : AbortSignal.any([options.signal, live.signal])
  const progress: TurnProgress = { text: '', reasoning: '', rounds: 0, denials: 0, completed: false }
  try {
    return await runTurnBody(ctx, options, signal, progress)
  } catch (error) {
    recordUnfinished(ctx, options.session, error, signal, progress)
    throw error
  } finally {
    live?.settle()
  }
}

/**
 * End a turn that threw, durably (#16, #29).
 *
 * A turn whose model call failed (a refused connection, a socket timeout, a provider error) or that a stop cut
 * mid-stream threw out of the loop before its `assistant/completed` and `turn/completed`. The live stream showed the
 * error, but the log kept only the prompt, so a reload, a second tab or a client whose stream dropped saw a message
 * with no answer and no failure, and the next turn's model read two prompts in a row. DSH's loop appends `turn/end`
 * with its reason (`{ kind: 'error', error }`) in a `finally`. Here the turn ends the way a stopped turn already
 * does: `assistant/completed` names the reason in `ended`, which the transcript draws as the turn's notice, and
 * `turn/completed` closes it. The error still reaches the caller.
 */
function recordUnfinished(
  ctx: Context,
  session: SessionHandle,
  error: unknown,
  signal: AbortSignal | undefined,
  progress: TurnProgress,
): void {
  const stopped = signal?.aborted === true
  const message = error instanceof Error ? error.message : String(error)
  try {
    /**
     * The record keeps what the turn did before it failed: the answer of its earlier rounds, its reasoning, its round
     * and denial counts (developer-five's review). A turn whose completion was already written (only the closing
     * `turn/completed` failed) is not completed twice.
     */
    if (!progress.completed) {
      ctx.session.store.append(session, {
        type: 'assistant/completed',
        text: progress.text,
        reasoning: progress.reasoning,
        finishReason: stopped ? 'aborted' : 'error',
        rounds: progress.rounds,
        denials: progress.denials,
        ended: [stopped ? 'stopped by the caller' : `failed: ${message}`],
        ...(stopped ? {} : { error: message }),
      })
    }
    ctx.session.store.append(session, { type: 'turn/completed', rounds: progress.rounds, ...(stopped ? { stopped: true } : { error: message }) })
  } catch {
    // The log could not take the record either; the caller still gets the turn's own error.
  }
}

/** One turn's body; the exported `runTurn` adds the live-turn registration around it. */
/** What a turn has done so far, kept where `runTurn`'s catch can read it when the turn throws (#16, #29). */
interface TurnProgress {
  text: string
  reasoning: string
  rounds: number
  denials: number
  /** Whether the turn's `assistant/completed` is already in the log. */
  completed: boolean
}

async function runTurnBody(
  ctx: Context,
  options: RunTurnOptions,
  signal: AbortSignal | undefined,
  progress: TurnProgress,
): Promise<TurnResult> {
  const started = ctx.session.store.count(options.session)
  const maxRounds = options.maxRounds ?? 8
  const maxOverflowRetries = options.maxOverflowRetries ?? 1
  const maximumTokens = options.maxOutputTokens
  const folder = ctx.session.folder(options.session)
  /**
   * The session's folder is where its tools run: the shell's directory, the base of a relative path and the
   * `workspace-write` boundary — DSH's rule, so a turn in workspace B acts in B and not in the directory the
   * server was launched from. A root the operator named still applies to every session (`rootFor`).
   */
  const cwd = ctx.sandbox.rootFor(folder)
  // Instructions belong to the conversation, even when the operator pinned the tools' root elsewhere.
  const instructionCwd = folder ?? ctx.sandbox.workspaceRoot

  /**
   * Write what waits in the session's inbox into the conversation (src/session/inbox.ts).
   *
   * Called at every step boundary. A steer sent while a tool runs is queued, not written, so it reaches the
   * conversation here, after the result of the call it arrived during. Called once more before this turn's
   * prompt, because a steer that a stopped turn left pending is DSH's next-step input, and DSH's boundary
   * claims next-step input before the queued prompt.
   */
  const claimSteered = (): void => {
    claimNextStep(ctx.session.store, options.session, (content, source) => ctx.session.userContent(options.session, content, source))
  }
  claimSteered()

  if (options.answerPending !== true) {
    ctx.session.userContent(
      options.session,
      [{ type: 'text', text: options.prompt }, ...(options.attachments ?? [])],
      options.source,
    )
  }

  const tools = specsOf(ctx.tools)
  const denials: { tool: string; code: string; message: string }[] = []
  const toolCallRecords: { name: string; arguments: string; result: ToolResult }[] = []
  let text = ''
  let reasoning = ''
  let finishReason = 'unknown'
  /** What the provider said each round cost, added up — see `mergeUsage`. */
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  let rounds = 0
  let lastContext: { estimatedTokens: number; thresholdTokens: number; pruned: number; compacted: boolean } | undefined
  const ended: string[] = []
  /** Read at the moment asked: TypeScript narrows a checked field to `false` for the rest of the scope, and an
   *  abort arrives asynchronously while a tool is running. */
  const stoppedByCaller = (): boolean => signal !== undefined && signal.aborted

  for (let round = 0; round < maxRounds; round += 1) {
    /**
     * A stopped turn ends at the next boundary. The provider connection is aborted too, but a round that is between
     * model calls — waiting on a tool, or on an approval — has no connection to break, so the loop is where the stop
     * has to be noticed. Measured: without this, a Stop during a pending approval waited for the ask's timeout.
     */
    if (stoppedByCaller()) {
      ended.push('stopped by the caller')
      break
    }
    /**
     * The step boundary: the previous round's tool results are on disk, so a steer that arrived during them is
     * written now, after them. A stop is checked first, so a stopped turn leaves its steer pending.
     */
    claimSteered()
    rounds += 1
    progress.rounds = rounds

    /**
     * What the person had already said when this round started.
     *
     * Compared with the same reading after the answer, it is how a message delivered **into** the running turn
     * is noticed — DSH's steering. The agent runtime there owns an inbox and injects a steered message between
     * steps; heddle has no runtime between steps, so the message is appended to the session and the loop has
     * to look for it, which is what this pair of readings does.
     */
    /**
     * Keep the runtime-context snapshot current before the round measures "what did the person say".
     *
     * This is DSH's pre-step assembly: the sandbox policy is a dynamic contribution, a changed snapshot is appended
     * after retained history (so a mid-turn mode change reaches the active loop on its next request and stays
     * legible afterwards), and an unchanged one costs no event. Writing it on this side of the reading is what keeps
     * the harness's own snapshot from being mistaken for a steered message.
     */
    ctx.context.recordRuntimeContext(options.session, [
      {
        name: 'sandbox:policy',
        text: sandboxPolicyStatement(ctx.sandbox.policy(ctx.session.effectiveMode(options.session, ctx.sandbox.mode), cwd)),
      },
    ])
    /** The clock reading reminders depend on (DSH's dsh-time-context): due at most once per ten minutes. */
    recordTimeContext(ctx.session.store, options.session, { step: round + 1 })

    let inputBefore = userInputSeqs(ctx, options.session)

    /**
     * The context step: derive from the surface, prune, and summarise only if pruning did not
     * clear the pressure. The order is the policy and it lives in the service, so a check can
     * judge it without a loop.
     */
    let report = await ctx.context.prepare(options.session, {
      cwd: instructionCwd,
      endpoint: options.endpoint,
      ...(options.model !== undefined ? { model: options.model } : {}),
      tools,
      ...(options.system !== undefined ? { system: options.system } : {}),
    })

    /**
     * What this round's context was.
     *
     * Kept on the result so a caller can report the budget, which is how the context claim
     * is judged: a budget nobody can see is a budget nobody can check.
     */
    lastContext = {
      estimatedTokens: report.estimatedTokens,
      thresholdTokens: report.thresholdTokens,
      pruned: report.pruned,
      compacted: report.compacted,
    }

    /**
     * The pre-step hook, with its failures named.
     *
     * A listener that throws takes the round down — measured, and it is the right default for a refusal
     * — but the message must say the failure came from a hook rather than from the model, or a typo in
     * a policy reads as a provider outage. A listener that means to refuse can say so with `HookRefusal`.
     */
    let prepared: { messages: readonly Message[]; tools: readonly ToolSpec[] }
    try {
      prepared = ctx.waterfall(
        'agent/pre-step',
        { messages: report.messages, tools, round: round + 1 },
        () => ({ messages: report.messages, tools }),
      )
    } catch (error) {
      const reason = isHookRefusal(error) ? (error as Error).message : `a hook failed at agent/pre-step — ${(error as Error).message}`
      throw new Error(reason)
    }

    const calls: { id: string; name: string; arguments: string }[] = []
    let roundText = ''
    for (let attempt = 0; ; attempt += 1) {
      /**
       * The comparison window is the **model call itself**.
       *
       * Measured while wiring steering: taken one step earlier, at the top of the round, it also counted
       * whatever `ctx.context.prepare` appended to the surface while building the request — so every turn
       * looked as if a message had arrived, every turn took an extra round, and the endpoint was asked twice
       * for one message. What the rule is about is a message that arrives *while the model is answering*.
       */
      inputBefore = userInputSeqs(ctx, options.session)
      const request = {
        endpoint: options.endpoint,
        messages: prepared.messages,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(maximumTokens !== undefined ? { maxOutputTokens: maximumTokens } : {}),
        ...(prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
        ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
        sessionId: options.session.id,
        round,
      }

      ctx.session.store.modelRequest(options.session, {
        endpoint: options.endpoint,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        messages: prepared.messages.length,
        tools: prepared.tools.map((tool) => tool.name),
        estimatedTokens: report.estimatedTokens,
        thresholdTokens: report.thresholdTokens,
        pruned: report.pruned,
        compacted: report.compacted,
        breakdown: report.breakdown,
        generation: ctx.session.surface(options.session).contentGeneration,
      })

      try {
        for await (const chunk of ctx.model.stream(request, signal)) {
          // Recorded as it arrives: the transcript of an interrupted turn should show
          // the half of the answer that arrived.
          ctx.session.store.assistantChunk(options.session, chunk)
          if (chunk.type === 'text-delta') {
            roundText += chunk.text
            // The round's partial answer counts too, should the stream fail or be stopped before the round ends.
            progress.text = text + roundText
          }
          else if (chunk.type === 'reasoning-delta') {
            reasoning += chunk.text
            progress.reasoning = reasoning
          }
          else if (chunk.type === 'tool-call') calls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
          else if (chunk.type === 'done') {
            finishReason = chunk.finishReason
            usage = mergeUsage(usage, chunk.usage)
            /**
             * Only an **abnormal** finish is a stop reason worth a notice: `stop` ends the answer normally and
             * `tool_calls` asks for the next round by design. Recording those too made every healthy multi-round
             * turn read as "stopped" — measured while checking a ten-round fixture, whose answer carried a notice
             * about its own `tool_calls` finish.
             */
            if (chunk.finishReason !== 'stop' && chunk.finishReason !== 'tool_calls') {
              ended.push(`round ${round + 1}: ${chunk.finishReason}`)
            }
          }
        }
        break
      } catch (error) {
        /**
         * The recovery path: a provider that refused the call as too long gets one more chance,
         * and only because something durable changed in between.
         *
         * The listener is where compaction attaches, mirroring DSH's `agent/request-error`. A
         * retry is granted on the strength of a landed replacement, not on the failure itself:
         * sending the same too-long request again would fail identically, which is why the loop
         * re-derives the request before trying.
         */
        const failure = modelFailure(error)
        if (failure === undefined || attempt >= maxOverflowRetries) throw error
        const action = await ctx.waterfall(
          'agent/request-error',
          {
            error: failure,
            session: options.session,
            endpoint: options.endpoint,
            ...(options.model !== undefined ? { model: options.model } : {}),
            cwd: instructionCwd,
            tools,
          },
          () => undefined,
        )
        if (action?.kind !== 'retry') throw error
        /**
         * The retry re-derives; it does not reduce again.
         *
         * The reduction was the listener's job and it has already landed — that is *why* the retry
         * was granted. Reducing a second time here was measured while writing this: it spent a
         * second summary call and was then refused for not shrinking, because the first reduction
         * had left it nothing to take.
         */
        const generationBefore = ctx.session.surface(options.session).replaceGeneration
        const retried = ctx.context.assemble(options.session, {
          cwd: instructionCwd,
          tools,
          ...(options.system !== undefined ? { system: options.system } : {}),
          endpoint: options.endpoint,
          ...(options.model !== undefined ? { model: options.model } : {}),
        })
        report = retried
        prepared = { messages: retried.messages, tools }
        lastContext = {
          estimatedTokens: retried.estimatedTokens,
          thresholdTokens: retried.thresholdTokens,
          pruned: retried.pruned,
          compacted: ctx.session.surface(options.session).replaceGeneration > generationBefore,
        }
        ctx.session.store.append(options.session, {
          type: 'turn/retry',
          round,
          attempt: attempt + 1,
          code: failure.code,
          estimatedTokens: report.estimatedTokens,
          compacted: report.compacted,
        })
      }
    }
    text += roundText
    progress.text = text

    /**
     * A message that arrived while the model was answering is answered **by this turn**.
     *
     * This is the half of steering the loop owns. A steer is queued in the session's inbox and written at the next
     * step boundary, and a teammate's mail is written straight to the log; either way the next round would answer
     * it, but only if there **is** a next round, and an answer with no tool calls used to end the turn. So the
     * turn goes on while a message waits in the inbox or arrived on the surface during the call. DSH does the
     * same: a step that ends the turn with next-step input pending takes another step. Measured consequence of
     * leaving it out: a steered message sat unanswered until the person sent something else.
     */
    if (
      calls.length === 0 &&
      !hasNewInput(inputBefore, userInputSeqs(ctx, options.session)) &&
      !hasPendingStep(ctx.session.store, options.session)
    ) {
      break
    }

    /**
     * The step's calls run as DSH's loop runs them (`dsh-agent-loop` `runGroup`): a call whose tool is parallel-safe
     * (`concurrencySafe`, DSH's `isConcurrencySafe`) joins the consecutive safe calls around it in a pool of
     * `tools.maxParallelToolCalls`; any other call runs alone, a barrier between groups. Results commit in model order
     * after each group, so a call that finishes first is still answered in its place, and the step boundary (where
     * steered input is claimed) stays after the whole step, never between two results of one group.
     *
     * Every call the model asked for is answered in the log — even one that cannot run. The assistant's `tool_calls`
     * message and its tool messages are one unit to the provider: a Stop or a thrown tool between them used to leave a
     * call unanswered, and every later request failed with the pairing error. A stopped turn, a refused call and a tool
     * that threw all become an `error` result the model can read; a call a stop overtook before it started is one.
     */
    const runCall = async (call: (typeof calls)[number]): Promise<ToolResult> => {
      const args = parseArguments(call.arguments)
      if (stoppedByCaller()) {
        return { output: '', error: { code: 'INTERRUPTED', message: 'the turn was stopped before this call ran' } }
      }
      try {
        return await ctx.tools.call(call.name, args, {
          cwd,
          session: options.session,
          ...(signal !== undefined ? { signal } : {}),
          log: (message) => ctx.logger.info('turn: %s', message),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: '',
          error: {
            code: 'INTERRUPTED',
            message: stoppedByCaller() ? 'the turn was stopped while this call ran' : message,
          },
        }
      }
    }
    const commitCall = (call: (typeof calls)[number], result: ToolResult) => {
      toolCallRecords.push({ name: call.name, arguments: call.arguments, result })
      if (result.error) {
        denials.push({ tool: call.name, code: result.error.code, message: result.error.message })
        progress.denials = denials.length
      }
      ctx.session.store.message(options.session, {
        role: 'tool',
        toolCallId: call.id,
        content: [
          {
            type: 'text',
            text: result.error
              ? `error (${result.error.code}): ${result.error.message}`
              : result.output.length > 0
                ? result.output
                : '(the tool produced no output)',
          },
        ],
      })
    }
    const limit = Math.max(1, ctx.tools.maxParallelToolCalls ?? 1)
    const safe = (name: string) => limit > 1 && ctx.tools.isConcurrencySafe?.(name) === true
    for (let first = 0; first < calls.length; ) {
      let end = first + 1
      if (safe(calls[first]!.name)) while (end < calls.length && safe(calls[end]!.name)) end += 1
      const group = calls.slice(first, end)
      const results = await runPool(group, limit, runCall)
      group.forEach((call, index) => commitCall(call, results[index]!))
      first = end
    }
  }

  /** The tools ran; if a stop arrived while they did, the next model call would be wasted. */
  if (stoppedByCaller() && !ended.includes('stopped by the caller')) ended.push('stopped by the caller')
  if (rounds >= maxRounds) {
    ended.push(`stopped after the round limit of ${maxRounds}`)
  }
  ctx.session.store.append(options.session, {
    type: 'assistant/completed',
    text,
    reasoning,
    finishReason,
    rounds,
    denials: denials.length,
    /**
     * A stopped turn says so in the record. Measured before this: the reason lived only in the local `ended`
     * list, so a turn cut by the round limit reached the page as an empty answer with no trace anywhere.
     */
    ...(ended.length > 0 ? { ended } : {}),
  })
  progress.completed = true
  ctx.session.store.append(options.session, { type: 'turn/completed', rounds })

  return {
    text,
    reasoning,
    toolCalls: toolCallRecords,
    denials,
    finishReason,
    events: ctx.session.store.count(options.session) - started,
    rounds,
    context: lastContext,
    ...(ended.length > 0 ? { ended } : {}),
    ...(usage !== undefined ? { usage } : {}),
  }
}

/**
 * Parse a tool call's arguments.
 *
 * A malformed argument string is not a crash: the model's own syntax error is
 * handed back to the tool as an empty object with the raw text kept, so the
 * registry refuses it as bad arguments and the model gets told what it wrote.
 * Measured on a real model, which does occasionally emit a truncated JSON.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }
  } catch {
    return { __unparsed: raw }
  }
}

/** What one refused round is offered, so a listener can decide whether a retry would differ. */
export interface RequestErrorPayload {
  readonly error: { readonly code: string; readonly message: string }
  readonly session: SessionHandle
  readonly endpoint: string
  readonly model?: string
  readonly cwd: string
  readonly tools: readonly ToolSpec[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Waterfall before a round's request is built. Modelled on DSH's `agent/pre-step`.
     *
     * A listener may return different messages or tools, which is how context
     * management, instruction injection and a compaction policy attach without the loop
     * knowing about any of them. Throwing refuses the round.
     *
     * @mode waterfall
     */
    'agent/pre-step'(
      step: { readonly messages: readonly Message[]; readonly tools: readonly ToolSpec[]; readonly round: number },
      next: () => { readonly messages: readonly Message[]; readonly tools: readonly ToolSpec[] },
    ): { readonly messages: readonly Message[]; readonly tools: readonly ToolSpec[] }
    /**
     * Waterfall after a model call failed. Modelled on DSH's `agent/request-error`.
     *
     * This is the overflow seam: a listener recognises a refusal it can do something about —
     * a window that was exceeded — reduces the conversation durably and returns `{kind:'retry'}`,
     * and the loop re-derives the request and sends it again. Anything else is left to throw.
     *
     * @mode waterfall
     */
    'agent/request-error'(
      payload: RequestErrorPayload,
      next: () => { readonly kind: 'retry' } | undefined,
    ): { readonly kind: 'retry' } | undefined | Promise<{ readonly kind: 'retry' } | undefined>
  }
}

/**
 * Whether an error raised by a hook says it was meant as a refusal.
 *
 * The distinction matters to the person reading the failure: "the policy refused this" and "the policy
 * is broken" call for different actions, and a stack trace alone does not tell them apart. A hook that
 * means to refuse throws this; anything else is reported as a broken hook.
 */
export class HookRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HookRefusal'
  }
}

/** Whether an error came from a hook that meant to refuse. */
export function isHookRefusal(error: unknown): boolean {
  return error instanceof Error && (error.name === 'HookRefusal' || error.message.startsWith('refused by hook:'))
}

/** Run `run` over `items` with at most `limit` in flight, starting each as a slot frees; results keep `items`' order. */
async function runPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
