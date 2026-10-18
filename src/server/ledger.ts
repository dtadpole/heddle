/**
 * The Trajectory ledger: one session's recorded events, projected as a turn-aware ledger.
 *
 * This is the same idea DSH's `dsh-client-ui-trajectory` states plainly — its view is a **pure projection**
 * of the session window and "neither reads nor changes the Chat conversation snapshot". Two views over one
 * record cannot disagree about what happened; two stores can. So this file reads events and returns data,
 * and the page decides how to draw it.
 *
 * What the ledger is for: the Chat view answers *what was said*, and this answers *what the harness did* —
 * which step, in which turn, how long it took, and what it cost. The chat view deliberately collapses the
 * parts (reasoning, tool arguments) that a reader wants out of the way; the ledger is where they are the
 * subject rather than the interruption.
 *
 * Three rules are copied from DSH because each is a way to lie to a reader:
 *
 * - **An in-flight record has a start and no duration.** A duration for something still running is invented
 *   time, and it is the kind a reader believes.
 * - **An unavailable number is absent, not zero.** `inputTokens: 0` says a request cost nothing, which is a
 *   different and false claim from "this was not reported".
 * - **A record's timing comes from its own events.** Nothing interpolates a missing timestamp.
 */

import { billedInputTokens, mergeTokenUsage, type TokenUsage } from '../llm/usage.ts'

/** One event, as much of it as the projection reads. */
export interface LedgerEvent {
  readonly seq?: number
  readonly at?: string
  readonly type: string
  readonly message?: { readonly role?: string; readonly content?: readonly { readonly type?: string; readonly text?: string }[]; readonly toolCallId?: string }
  readonly chunk?: { readonly type?: string; readonly id?: string; readonly name?: string; readonly arguments?: string; readonly text?: string; readonly usage?: TokenUsage }
  readonly text?: string
  readonly reasoning?: string
  readonly finishReason?: string
  readonly rounds?: number
  readonly messages?: number
  readonly estimatedTokens?: number
  readonly pruned?: number
  readonly compacted?: boolean
  readonly endpoint?: string
  readonly model?: string
  /** The tools the request offered, when it recorded them. */
  readonly tools?: readonly string[]
}

/** What produced a record. The vocabulary is DSH's, so a reader of either tool sees the same words. */
export type LedgerKind = 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'context' | 'compaction'

/** One row of the ledger. */
export interface LedgerRecord {
  readonly kind: LedgerKind
  /** A one-line identity: the tool's name, the model, or the record's kind. */
  readonly label: string
  /** The full text — the tool's arguments, the reasoning, or the message. */
  readonly text: string
  /** When it started, from its own event. Absent when the event carried no time. */
  readonly startedAt?: string
  /**
   * How long it took, in milliseconds.
   *
   * Absent while the record is still running, and absent when the events cannot measure it. The two are
   * distinguished by `inFlight`: a reader deserves to know which it is.
   */
  readonly durationMs?: number
  /**
   * Whether the record had not finished when these events ended.
   *
   * True for a chunk stream with no settling event after it — a killed run, or one still arriving. It is the
   * field that stops a caller printing a duration for something unfinished.
   */
  readonly inFlight?: boolean
  /** Time to first token, when a stream recorded one and a step start is known. */
  readonly ttftMs?: number
  /** Token counts, each absent rather than zero when the record does not carry one. */
  readonly usage?: TokenUsage
  /** Whether the counts came from the provider rather than from the harness's own estimate. */
  readonly usageSource?: 'provider' | 'estimated'
  /** Whatever else the event said that a reader would want: finish reason, denials, pruned count. */
  readonly note?: string
  /**
   * A tool call's name, without the arrow its label carries.
   *
   * The label is what the collapsed one-liner shows; the name is what the row's own typeface says, and a
   * renderer that had to strip the arrow off a label would be parsing a string this file just built.
   */
  readonly name?: string
  /** The call this result answers — the field that pairs the two halves into one row. */
  readonly toolCallId?: string
  /**
   * What the tool answered.
   *
   * Held on the call's own record, so one row shows "it ran this and got that" as DSH does, rather than
   * two rows a reader has to match up by eye.
   */
  readonly result?: string
  /** A call is running until its result says otherwise; an error result marks the row. */
  readonly state?: 'running' | 'ok' | 'error'
  /** Which note wrote a context row: the system prompt, the instruction baseline, or another note. */
  readonly origin?: string
}

/** A step: one model request and everything it produced. */
export interface LedgerStep {
  readonly index: number
  readonly records: readonly LedgerRecord[]
  /** The model this step asked, when the request named one. */
  readonly model?: string
  readonly startedAt?: string
  readonly durationMs?: number
}

/** A turn: what one prompt caused, in steps. */
export interface LedgerTurn {
  readonly index: number
  readonly startedAt?: string
  readonly durationMs?: number
  readonly rounds?: number
  readonly steps: readonly LedgerStep[]
}

/** The whole ledger, plus the totals a header shows. */
export interface Ledger {
  readonly turns: readonly LedgerTurn[]
  /** Records that belong to no turn — a session that recorded events before the first prompt. */
  readonly loose: readonly LedgerRecord[]
  readonly tokens: {
    readonly input?: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
    readonly estimated?: number
  }
  readonly records: number
  readonly inFlight: number
}

/**
 * The session's bottom statistics: what the composer's dock prints.
 *
 * One pass over the session's own events, because every number is in them: the user messages are the turns,
 * `turn/completed.rounds` are the agent steps, and the assistant chunks carry the provider's usage per round.
 * Nothing is estimated or multiplied here — a bucket that no frame reported stays absent so the page can print
 * a blank instead of an invented number.
 */
export interface SessionStats {
  readonly turns: number
  readonly steps: number
  readonly usage?: TokenUsage
  /**
   * The prompt-side total of the **most recent** reported round, which is what the context share divides by
   * the window (DSH's context pressure is the same fact). Absent when no frame reported a prompt side.
   */
  readonly lastPromptTokens?: number
}

export function projectSessionStats(events: readonly LedgerEvent[]): SessionStats {
  let turns = 0
  let steps = 0
  let usage: TokenUsage | undefined
  let lastPromptTokens: number | undefined
  for (const event of events) {
    if (event.type === 'message' && event.message?.role === 'user') {
      turns += 1
      continue
    }
    if (event.type === 'turn/completed') {
      steps += typeof event.rounds === 'number' && event.rounds > 0 ? event.rounds : 0
      continue
    }
    if (event.type === 'assistant/chunk' && event.chunk?.usage !== undefined) {
      usage = mergeTokenUsage(usage, event.chunk.usage)
      const billed = billedInputTokens(event.chunk.usage)
      if (billed !== undefined) lastPromptTokens = billed
    }
  }
  return {
    turns,
    steps,
    ...(usage !== undefined ? { usage } : {}),
    ...(lastPromptTokens !== undefined ? { lastPromptTokens } : {}),
  }
}

/** One row of the Trajectory table: a record, plus where it sits. */
export interface LedgerRow {
  readonly turn: number
  readonly step?: number
  readonly kind: LedgerKind
  readonly record: LedgerRecord
  /** True on a turn's first row — what draws its label and the separator above it. */
  readonly turnStart: boolean
  /** True on a step's first row. */
  readonly stepStart: boolean
  /** True for a record that belongs to no turn: a session that logged before its first prompt. */
  readonly loose: boolean
  /**
   * The one line the table shows for the row, decided here rather than in the page.
   *
   * It is a claim about the record (the assistant that only called tools has no words; a tool result with
   * no call still names itself), so it is made beside the projection that has the record, and unit-tested.
   */
  readonly preview: string
}

/** The three lanes of DSH's timeline overview. */
export type LedgerLane = 'input' | 'model' | 'tools'

/**
 * Which lane an event belongs to, as DSH's overview groups them.
 *
 * Input is what a person or the harness put in, model is what the model produced (its words and its
 * thinking), and tools is what ran. Exported and tested because the page's lanes are only as right as this.
 */
export function laneOf(kind: LedgerKind): LedgerLane {
  if (kind === 'user' || kind === 'context' || kind === 'system') return 'input'
  if (kind === 'tool') return 'tools'
  return 'model'
}

/** The one line a row shows: its first line, or what the row is when it has none. */
export function previewOf(record: LedgerRecord): string {
  const text = String(record.text ?? '').split('\n')[0] ?? ''
  if (text !== '') return text
  if (record.kind === 'assistant') return '(tool call only)'
  if (record.kind === 'tool') return record.name ?? record.label ?? 'tool'
  return record.label ?? record.kind
}

/**
 * Flatten the ledger into the rows a Trajectory table draws.
 *
 * DSH's table is one row per event with turn and step boundaries carried *on the rows* (its rows have
 * `data-turn-start` / `data-step` attributes), rather than as nested containers. That is what lets the
 * table be virtualised, filtered by search, and collapsed by turn without rebuilding a tree — so the
 * projection does the flattening here, where a unit test can judge it, and the page only draws rows.
 */
export function projectRows(ledger: Ledger): readonly LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const turn of ledger.turns) {
    for (const step of turn.steps) {
      step.records.forEach((record, index) => {
        rows.push({
          turn: turn.index,
          step: step.index,
          kind: record.kind,
          record,
          turnStart: rows.length === 0 || rows[rows.length - 1]?.turn !== turn.index,
          stepStart: index === 0,
          loose: false,
          preview: previewOf(record),
        })
      })
    }
  }
  /**
   * Records that belong to no turn come last, and say so rather than inventing a turn number: a session
   * that recorded context before its first prompt has no turn to belong to.
   */
  for (const record of ledger.loose) {
    rows.push({ turn: 0, kind: record.kind, record, turnStart: false, stepStart: false, loose: true, preview: previewOf(record) })
  }
  return rows
}

/** Milliseconds between two timestamps, or `undefined` when either is missing or the pair is backwards. */
function between(from?: string, to?: string): number | undefined {
  if (from === undefined || to === undefined) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  return end - start
}

/** A chunk stream that is being assembled into one assistant record. */
interface PendingAssistant {
  parts: string[]
  reasoning: string[]
  startedAt?: string
  firstTokenAt?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  sawProviderUsage: boolean
}

/**
 * Project events into the ledger.
 *
 * Pure: the same events always give the same ledger, and nothing here writes or mutates its input. The
 * caller decides what to render, including how much of a long record to show.
 */
export function projectLedger(events: readonly LedgerEvent[]): Ledger {
  const turns: LedgerTurn[] = []
  const loose: LedgerRecord[] = []
  let turn: { index: number; startedAt?: string; endedAt?: string; rounds?: number; steps: LedgerStep[] } | null = null
  /**
   * Records that belong to the current turn but precede its first step.
   *
   * The prompt is the turn's opener, not part of any request, and the first `model/request` is what opens
   * step one. Keeping the prompt here and folding it into that step is what stops it being dropped — the
   * first version pushed it into a step the request then replaced, and the prompt vanished.
   */
  let prologue: LedgerRecord[] = []
  let step: { startedAt?: string; endedAt?: string; model?: string; records: LedgerRecord[] } | null = null
  let pending: PendingAssistant | null = null

  const tokens = {
    input: undefined as number | undefined,
    output: undefined as number | undefined,
    cacheRead: undefined as number | undefined,
    cacheWrite: undefined as number | undefined,
    estimated: undefined as number | undefined,
  }

  /**
   * Close the open step.
   *
   * `keepPrologue` is the subtlety, and getting it wrong cost two rounds of tests. When a `model/request`
   * arrives, the prompt that opened the turn must **not** be flushed into a step of its own: it belongs to
   * the step the request is about to open, and the first version therefore produced one step holding the
   * prompt and another holding everything else. At a turn boundary the prologue has nowhere left to go, so
   * it is folded in.
   */
  const closeStep = (at?: string, keepPrologue = false): void => {
    const records = step?.records ?? []
    const startedAt = step?.startedAt
    const model = step?.model
    const endedAt = step?.endedAt ?? at
    step = null
    if (records.length === 0 && prologue.length === 0) {
      prologue = []
      return
    }
    const duration = between(startedAt, endedAt)
    if (records.length === 0) {
      /** Nothing but a prompt so far: it waits for the step that will hold it. */
      if (!keepPrologue) {
        turn?.steps.push({ index: (turn?.steps.length ?? 0) + 1, records: prologue, ...(prologue[0]?.startedAt !== undefined ? { startedAt: prologue[0].startedAt } : {}) })
        prologue = []
      }
      return
    }
    turn?.steps.push({
      index: (turn?.steps.length ?? 0) + 1,
      records: [...prologue, ...records],
      ...(model !== undefined ? { model } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    })
    /**
     * The prompt is folded in **once**.
     *
     * `keepPrologue` means "hold the prompt for the step a request is about to open", which is the
     * records-empty case above. Here the step has records, so the prompt has just been folded into it and
     * must be cleared — leaving it kept duplicated the user message and its context note into every later
     * step of the same turn, which is the bug a transcript with two model requests showed.
     */
    prologue = []
  }

  /** Close the current turn, if there is one. */
  const closeTurn = (at?: string, rounds?: number): void => {
    closeStep(at)
    if (prologue.length > 0) closeStep(at)
    if (turn === null) return
    const end = at ?? turn.endedAt
    turns.push({
      index: turn.index,
      steps: turn.steps,
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
      ...(between(turn.startedAt, end) !== undefined ? { durationMs: between(turn.startedAt, end) } : {}),
      ...(turn.rounds !== undefined ? { rounds: turn.rounds } : rounds !== undefined ? { rounds } : {}),
    })
    turn = null
  }

  /** Where a record goes: the open step, or the turn's prologue. */
  const put = (record: LedgerRecord): void => {
    if (step !== null) step.records.push(record)
    else if (turn !== null) prologue.push(record)
    else loose.push(record)
  }

  /**
   * The open tool call a result belongs to, if one is still unanswered.
   *
   * Searched newest-first through the step, then the prologue, then the loose records, because a tool's
   * result is written after its call and the newest open call is the one a provider without ids means.
   */
  const openCall = (toolCallId?: string): { readonly list: LedgerRecord[]; readonly index: number } | null => {
    const lists: LedgerRecord[][] = step !== null ? [step.records, prologue, loose] : [prologue, loose]
    for (const list of lists) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const record = list[index]
        if (record === undefined || record.kind !== 'tool' || record.result !== undefined) continue
        if (toolCallId !== undefined && record.toolCallId !== undefined && record.toolCallId !== toolCallId) continue
        return { list, index }
      }
    }
    return null
  }

  /** Close an in-flight assistant stream. `settled` decides whether it gets a duration or is marked running. */
  const settleAssistant = (at?: string, settled = false): void => {
    if (pending === null) return
    const text = pending.parts.join('')
    const reasoning = pending.reasoning.join('')
    const ttft = between(pending.startedAt, pending.firstTokenAt)
    if (reasoning.length > 0) {
      put({ kind: 'reasoning', label: 'reasoning', text: reasoning, ...(pending.startedAt !== undefined ? { startedAt: pending.startedAt } : {}) })
    }
    if (text.length > 0 || pending.inputTokens !== undefined || pending.outputTokens !== undefined) {
      put({
        kind: 'assistant',
        label: 'assistant',
        text,
        ...(pending.startedAt !== undefined ? { startedAt: pending.startedAt } : {}),
        ...(settled && at !== undefined && between(pending.startedAt, at) !== undefined ? { durationMs: between(pending.startedAt, at) } : {}),
        ...(!settled ? { inFlight: true } : {}),
        ...(ttft !== undefined ? { ttftMs: ttft } : {}),
        /**
         * Usage is attached only when there is something to attach. A record with no reported tokens carries no
         * `usage` key at all, so a renderer cannot mistake "not reported" for "zero".
         */
        ...(pending.inputTokens !== undefined || pending.outputTokens !== undefined
          ? {
              usage: {
                ...(pending.inputTokens !== undefined ? { inputTokens: pending.inputTokens } : {}),
                ...(pending.outputTokens !== undefined ? { outputTokens: pending.outputTokens } : {}),
                ...(pending.cacheReadTokens !== undefined ? { cacheReadTokens: pending.cacheReadTokens } : {}),
                ...(pending.cacheWriteTokens !== undefined ? { cacheWriteTokens: pending.cacheWriteTokens } : {}),
              },
              usageSource: pending.sawProviderUsage ? ('provider' as const) : ('estimated' as const),
            }
          : {}),
      })
    }
    pending = null
  }

  for (const event of events) {
    if (event.type === 'message') {
      const role = event.message?.role
      const text = (event.message?.content ?? []).map((part) => part.text ?? '').join('')
      if (role === 'user') {
        settleAssistant(event.at, true)
        closeTurn(event.at)
        turn = { index: turns.length + 1, startedAt: event.at, steps: [] }
        prologue = [{ kind: 'user', label: 'user', text, ...(event.at !== undefined ? { startedAt: event.at } : {}) }]
        continue
      }
      if (role === 'tool') {
        const refused = /^error/i.test(text)
        /**
         * A result fills the call it answers, so the two are one row.
         *
         * This is DSH's shape — one element per call, carrying its result — and the id is what pairs them.
         * A provider that sends no id is paired with the newest call still open; a result that matches
         * nothing is still shown, because losing what a tool said would be worse than an unpaired row.
         */
        const open = openCall(event.message?.toolCallId)
        if (open !== null) {
          open.list[open.index] = {
            ...(open.list[open.index] as LedgerRecord),
            result: text,
            state: refused ? 'error' : 'ok',
            ...(refused ? { note: 'the tool refused this call' } : {}),
          }
          continue
        }
        put({
          kind: 'tool',
          label: refused ? 'tool (refused)' : 'tool result',
          text: '',
          result: text,
          state: refused ? 'error' : 'ok',
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
          ...(refused ? { note: 'the tool refused this call' } : {}),
        })
        continue
      }
      if (role === 'assistant') {
        settleAssistant(event.at, true)
        put({ kind: 'assistant', label: 'assistant', text, ...(event.at !== undefined ? { startedAt: event.at } : {}) })
        continue
      }
      continue
    }

    if (event.type === 'session/created') continue

    if (event.type === 'model/request') {
      settleAssistant(event.at, true)
      /** The prompt waits for this step, which is the one it belongs to. */
      closeStep(event.at, true)
      step = { startedAt: event.at, records: [], ...(event.model !== undefined ? { model: event.model } : {}) }
      if (event.estimatedTokens !== undefined) {
        tokens.estimated = (tokens.estimated ?? 0) + event.estimatedTokens
        put({
          kind: 'system',
          label: 'request',
          text: [
            `${event.messages ?? '?'} message(s)`,
            event.tools !== undefined ? `tools: ${event.tools.join(', ')}` : undefined,
            event.endpoint !== undefined ? `endpoint: ${event.endpoint}` : undefined,
            event.pruned !== undefined && event.pruned > 0 ? `pruned: ${event.pruned}` : undefined,
            event.compacted === true ? 'compacted: yes' : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
          usage: { inputTokens: event.estimatedTokens },
          usageSource: 'estimated',
        })
      }
      continue
    }

    if (event.type === 'assistant/chunk') {
      const chunk = event.chunk
      if (chunk === undefined) continue
      pending ??= { parts: [], reasoning: [], ...(event.at !== undefined ? { startedAt: event.at } : {}), sawProviderUsage: false }
      /** The first token of the stream, which is what TTFT measures from the step start to. */
      pending.firstTokenAt ??= event.at
      if (chunk.type === 'text-delta' && chunk.text !== undefined) pending.parts.push(chunk.text)
      else if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) pending.reasoning.push(chunk.text)
      else if (chunk.type === 'tool-call' && chunk.name !== undefined) {
        settleAssistant(event.at, true)
        put({
          kind: 'tool',
          label: `→ ${chunk.name}`,
          name: chunk.name,
          text: chunk.arguments ?? '{}',
          state: 'running',
          ...(chunk.id !== undefined ? { toolCallId: chunk.id } : {}),
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
        })
      }
      /**
       * Provider usage, when the provider reported it. This is the truth the estimate approximates, and the
       * ledger marks which it holds rather than presenting one as the other.
       *
       * Read **before** a `done` chunk settles the record, and that order is the whole point: the first
       * version settled on `done` and then read the usage, so the provider's numbers were dropped on the
       * floor for every provider that reports them with the last chunk — which is how they are normally
       * reported. Measured, and it read as `undefined` rather than as an error until a `done` chunk carried
       * usage and the code wrote to a record that had already been closed.
       */
      if (
        pending !== null &&
        (chunk.usage?.inputTokens !== undefined ||
          chunk.usage?.outputTokens !== undefined ||
          chunk.usage?.cacheReadTokens !== undefined ||
          chunk.usage?.cacheWriteTokens !== undefined)
      ) {
        pending.sawProviderUsage = true
        if (chunk.usage.inputTokens !== undefined) {
          pending.inputTokens = chunk.usage.inputTokens
          tokens.input = (tokens.input ?? 0) + chunk.usage.inputTokens
        }
        if (chunk.usage.outputTokens !== undefined) {
          pending.outputTokens = chunk.usage.outputTokens
          tokens.output = (tokens.output ?? 0) + chunk.usage.outputTokens
        }
        /**
         * The cache buckets are prompt-side billing facts, not a second input count: they are summed so the
         * composer's token pill can print `Cache hit` and the session's billed total, and a provider that does
         * not report them leaves them absent rather than zero.
         */
        if (chunk.usage.cacheReadTokens !== undefined) {
          pending.cacheReadTokens = chunk.usage.cacheReadTokens
          tokens.cacheRead = (tokens.cacheRead ?? 0) + chunk.usage.cacheReadTokens
        }
        if (chunk.usage.cacheWriteTokens !== undefined) {
          pending.cacheWriteTokens = chunk.usage.cacheWriteTokens
          tokens.cacheWrite = (tokens.cacheWrite ?? 0) + chunk.usage.cacheWriteTokens
        }
      }
      if (chunk.type === 'done') settleAssistant(event.at, true)
      continue
    }

    if (event.type === 'assistant/completed') {
      /**
       * The settled answer is recorded **from this event** when no stream was being assembled.
       *
       * Measured: the handler settled a pending stream and then only wrote the finish-reason note, so a
       * session recorded as deltas lost nothing but a session whose answer arrived as a bare completion —
       * which is what `assistant/completed` carries — produced no assistant record at all. A ledger without
       * the answers is not a ledger.
       */
      settleAssistant(event.at, true)
      /**
       * The settled answer is written from this event only when the step does not already hold it.
       *
       * The old guard asked whether a stream was *pending*, and a `done` chunk settles the pending stream
       * before the completion arrives — so a real streamed answer was written twice: once from the deltas
       * and once from the completion. Measured in a transcript with a `done` chunk: two identical
       * `assistant` records in one step. The question is not "was a stream pending" but "do these words
       * already exist here", which is true for a bare completion and for a streamed one alike.
       */
      const alreadyRecorded = (records: readonly LedgerRecord[]): boolean =>
        records.some((record) => record.kind === 'assistant' && record.text === event.text)
      if (event.text !== undefined && event.text.length > 0 && !alreadyRecorded(step?.records ?? []) && !alreadyRecorded(prologue)) {
        put({ kind: 'assistant', label: 'assistant', text: event.text, ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      }
      const notes = [
        event.finishReason !== undefined ? `finish: ${event.finishReason}` : undefined,
        event.rounds !== undefined ? `rounds: ${event.rounds}` : undefined,
      ].filter((line): line is string => line !== undefined)
      if (notes.length > 0) put({ kind: 'system', label: 'completed', text: notes.join('\n'), ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      if (step !== null) step.endedAt = event.at
      continue
    }

    if (event.type === 'turn/retry') {
      put({ kind: 'system', label: 'retry', text: 'this step was retried', ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      continue
    }

    if (event.type === 'turn/completed') {
      settleAssistant(event.at, true)
      closeTurn(event.at, event.rounds)
      continue
    }

    /**
     * A context note is what the **harness** composed: the system prompt or the instruction baseline.
     *
     * DSH gives these their own SYSTEM and CONTEXT tags, so they get their own kinds here rather than
     * falling through to the generic record — which dumped the event as JSON and put a raw
     * `{"seq":2,"at":"…","type":"context/note",…` in a one-line row.
     */
    if (event.type === 'context/note') {
      const note = event.message as { content?: readonly { type?: string; text?: string }[] } | undefined
      const text = (note?.content ?? []).map((part) => part.text ?? '').join('')
      const origin = typeof (event as { origin?: unknown }).origin === 'string' ? String((event as { origin?: unknown }).origin) : 'note'
      put({
        kind: origin === 'system-prompt' ? 'system' : 'context',
        label: origin === 'system-prompt' ? 'system prompt' : origin === 'instructions' ? 'instructions' : origin,
        text,
        origin,
        ...(event.at !== undefined ? { startedAt: event.at } : {}),
      })
      continue
    }

    /**
     * Anything else is a record without a home yet, kept rather than dropped: a ledger that silently ignores
     * events it does not recognise cannot be trusted to be complete.
     *
     * The label is the event's own type and its **other** fields are the body, rather than the whole event
     * dumped as JSON. Measured: a raw dump put `{"seq":2,"at":"…","type":"context/note",…` in the row, which
     * is unreadable in a one-line summary and pushes the interesting part past the ellipsis. The type is what
     * the row needs to say; the rest is what opening it is for.
     */
    const { seq: _seq, at: _at, type: _type, ...rest } = event as unknown as Record<string, unknown>
    put({
      kind: 'system',
      label: event.type,
      text: Object.keys(rest).length === 0 ? event.type : JSON.stringify(rest, null, 2).slice(0, 2_000),
      ...(event.at !== undefined ? { startedAt: event.at } : {}),
    })
  }

  /**
   * The tail is left open deliberately: a caller projecting a session that is still running must see the
   * unfinished stream as unfinished, which `settleAssistant(undefined, false)` is what marks.
   */
  settleAssistant(undefined, false)
  closeTurn()

  const all = [...turns.flatMap((item) => item.steps.flatMap((entry) => entry.records)), ...loose]
  return {
    turns,
    loose,
    tokens: {
      ...(tokens.input !== undefined ? { input: tokens.input } : {}),
      ...(tokens.output !== undefined ? { output: tokens.output } : {}),
      ...(tokens.cacheRead !== undefined ? { cacheRead: tokens.cacheRead } : {}),
      ...(tokens.cacheWrite !== undefined ? { cacheWrite: tokens.cacheWrite } : {}),
      ...(tokens.estimated !== undefined ? { estimated: tokens.estimated } : {}),
    },
    records: all.length,
    inFlight: all.filter((record) => record.inFlight === true).length,
  }
}

/**
 * The timeline's domain and its spans, derived from the ledger's own timings.
 *
 * The overview above DSH's ledger is a real time axis: a fixed band that projects each record's start and
 * duration from left to right, and picking an interval focuses the ledger on it. This is the arithmetic
 * behind the same idea, kept here rather than in the page because it has rules worth judging.
 *
 * The rules, and the reason each exists:
 *
 * - **The domain is the recorded span**, from the earliest start to the latest end. Nothing is padded to a
 *   round number, because a padded axis puts a gap where no work happened.
 * - **A record with no timing contributes no span.** The timeline is where a reader looks for "how long",
 *   and a bar drawn from a guessed start is a bar that lies. The record still appears in the ledger; it is
 *   only absent from the axis.
 * - **A running record extends the domain to the newest event and is marked running**, rather than being
 *   dropped or given a duration. A session that is still working therefore has a domain that grows, and no
 *   span claims to have finished.
 * - **Every span carries its turn index**, so picking one can take the reader to the turn it belongs to.
 */
export interface TimelineSpan {
  readonly turn: number
  /** A position from 0 to 1 along the domain. */
  readonly start: number
  readonly end: number
  /** Which kinds of record the span covers, most frequent first, so a band can be coloured by its content. */
  readonly kinds: readonly LedgerKind[]
  /** The overview lanes this span touched, so the page draws lanes and does not decide them. */
  readonly lanes: readonly LedgerLane[]
  readonly records: number
  /** Whether anything in this span was still running when the events ended. */
  readonly running: boolean
}

export interface Timeline {
  readonly spans: readonly TimelineSpan[]
  /** From the earliest recorded start to the latest recorded end, in milliseconds. `0` when nothing is timed. */
  readonly durationMs: number
  readonly startsAt?: string
  readonly endsAt?: string
}

/** Project a ledger onto a time axis. */
export function projectTimeline(ledger: Ledger): Timeline {
  const timed: { turn: number; start: number; end: number; kind: LedgerKind; running: boolean }[] = []

  for (const turn of ledger.turns) {
    for (const step of turn.steps) {
      for (const record of step.records) {
        if (record.startedAt === undefined) continue
        const start = Date.parse(record.startedAt)
        if (Number.isNaN(start)) continue
        /** A finished record ends after its duration; a running one ends where the events end. */
        const end = record.durationMs !== undefined ? start + record.durationMs : start
        timed.push({ turn: turn.index, start, end, kind: record.kind, running: record.inFlight === true })
      }
    }
  }

  if (timed.length === 0) return { spans: [], durationMs: 0 }

  const domainStart = Math.min(...timed.map((entry) => entry.start))
  /**
   * The domain ends at the latest recorded end **or** the latest start, whichever is later: a running record
   * has no end, and an axis that stopped at the last finished work would hide the work in progress.
   */
  const latest = Math.max(...timed.map((entry) => entry.end), ...timed.map((entry) => entry.start))
  /**
   * A domain of zero width is real — one instantaneous record — and it is widened to a millisecond so every
   * position is a number rather than `NaN`. The axis then shows a single full-width band, which is honest:
   * there is nothing to distribute.
   */
  const domainEnd = latest > domainStart ? latest : domainStart + 1
  const durationMs = domainEnd - domainStart

  const byTurn = new Map<number, { start: number; end: number; kinds: LedgerKind[]; running: boolean }>()
  for (const entry of timed) {
    const existing = byTurn.get(entry.turn)
    if (existing === undefined) {
      byTurn.set(entry.turn, { start: entry.start, end: entry.end, kinds: [entry.kind], running: entry.running })
      continue
    }
    existing.start = Math.min(existing.start, entry.start)
    existing.end = Math.max(existing.end, entry.end)
    existing.kinds.push(entry.kind)
    existing.running ||= entry.running
  }

  const spans: TimelineSpan[] = []
  for (const [turn, span] of [...byTurn.entries()].sort((left, right) => left[0] - right[0])) {
    /**
     * Kinds in the order they matter to a reader scanning the band, **most significant first**.
     *
     * Every turn begins with a user record, so ordering by the first record made every band the same colour
     * and told a reader nothing — measured, and it defeated the point of colouring at all. The band should
     * say what the turn *did*: a call, an answer, reasoning, or nothing but a prompt.
     */
    const order: LedgerKind[] = ['tool', 'assistant', 'reasoning', 'compaction', 'context', 'user', 'system']
    const kinds = [...new Set(span.kinds)].sort((left, right) => order.indexOf(left) - order.indexOf(right))
    const start = (span.start - domainStart) / durationMs
    /**
     * A span always has a **pickable** width, because a hairline band cannot be aimed at with a mouse.
     *
     * Measured: the first floor was 0.4% of the axis, and a short turn in a session with a seven-minute gap
     * between two of them came out as a two-pixel sliver — legible as "something happened here", unusable as
     * a control. The floor is a share of the axis wide enough to hit, and it deliberately overstates a very
     * short turn: a target a person can click is worth more than an exact width nobody can.
     */
    const measuredEnd = (span.end - domainStart) / durationMs
    spans.push({
      turn,
      start,
      end: Math.max(measuredEnd, start + 0.02),
      kinds,
      lanes: [...new Set(kinds.map((kind) => laneOf(kind)))],
      records: span.kinds.length,
      running: span.running,
    })
  }

  return {
    spans,
    durationMs,
    startsAt: new Date(domainStart).toISOString(),
    endsAt: new Date(domainEnd).toISOString(),
  }
}
