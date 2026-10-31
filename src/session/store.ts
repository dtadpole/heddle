import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import type { Chunk, ContentPart, Message } from '../llm/types.ts'
import { workspaceKey } from './layout.ts'
import { interruptedTurnClosers } from './repair.ts'
import { SessionTitles } from './title.ts'
import { decodeTranscript, encodeFrame } from './transcript.ts'
import { normalizeSessionTitle } from './title-text.ts'

/**
 * The session store.
 *
 * Modelled on `@deepseek-ai/dsh-session`: a session is an **event log**, not a
 * mutable conversation object. Each event is appended, so a turn that is interrupted leaves a start
 * with no end — which is exactly what an interruption looks like and what a
 * rewrite-the-whole-file store cannot show.
 *
 * **The record is a sequence of zstd frames, one per event** (`session.v2.jsonl.zstd`), which is
 * DSH's shape and was the owner's decision. It was taken with the cost measured rather than
 * assumed: one frame per event compresses worse than one frame per file (2.13x against 3.49x on a
 * real session here), because frames share no match window. What it buys is appendability — the
 * bytes before an append are untouched, and a crash that tears the last frame costs that frame
 * rather than the file — and what it costs is the property this store used to advertise: a
 * transcript is no longer readable with `cat`. `heddle transcript <id>` prints the same events, and
 * `zstd -dc` reads the file; a session born before this format keeps its plain `session.jsonl` and
 * keeps being appended to in plain text, because this store never rewrites a record to change how
 * it is stored.
 *
 * **A torn tail is cut off when the session is opened**, and the repair is recorded as a
 * `transcript/repaired` event. Without that, one interruption made a session unreadable from the tear
 * onward: the frame walk stops at the first incomplete frame, so every event appended after it —
 * including the next turn's — would sit in the file and never be read. Measured before the repair:
 * a torn file plus one appended frame read back as one event instead of two.
 *
 * **A process that has opened a session reads it from memory.** The file is read and decoded once,
 * and every later `read`, `count`, measure or derivation is served from that fold. It exists because
 * of a measurement: one turn re-read and re-parsed the whole transcript **21 times** (five `read`
 * calls and sixteen `count` calls, and `count` read the file too), so a turn's cost grew with the
 * square of the session's length — and compressed storage is only affordable once decompression
 * happens once per process rather than once per read.
 *
 * A session id is the directory's name; `meta.json` records what the session is for, so a listing
 * does not need to parse any transcript; and the transcript is found by name, preferring the
 * versioned one so a reader knows the format before it decodes.
 *
 * **One process writes a session at a time.** The first append takes a writer lock beside the log
 * (`<id>.lock`, or `session.lock` inside an old-layout session directory) and the process keeps it
 * until it lets go or exits; another process that tries to append is refused with DSH's sentence,
 * `session "<id>" is already owned by an active write handle`. Without it, a `heddle web` server and a
 * `heddle --resume <id> --turn` each appended from their own in-memory seq counter and the log got the
 * same seqs twice (R-developer-eight-27). See {@link SessionOwnedError} and `acquireWriterLock`.
 */

/** Identifies one session; the directory name under the store root. */
export type SessionId = string

/** One entry in the log. `seq` is monotonic within a session. */
export interface SessionEvent {
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly [key: string]: unknown
}

/** What a caller gets back when it opens a session. */
export interface SessionHandle {
  readonly id: SessionId
  /** The folder this session's files are in: its workspace folder, or its own directory in the old layout. */
  readonly dir: string
  /** Where the transcript is; a caller may cite it. */
  readonly transcript: string
  /** Where the metadata is: `<id>.json` beside the log, or `meta.json` inside the old session directory. */
  readonly meta: string
}

/** A message as it is recorded, which is the shape a request needs too. */
export interface RecordedMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: readonly ContentPart[]
  /** Present on a `tool` message: which call this answers. */
  readonly toolCallId?: string
  /**
   * Who wrote this message, when it was not a person.
   *
   * An automatic goal round is a user message whose `source` is `{ kind: 'goal', goalId, revision, round }`,
   * which is how the goal fold knows a round was **admitted** rather than merely attempted — the count is
   * read from the log, not kept in a counter that can drift.
   */
  readonly source?: unknown
}

/** One session's metadata, written once and corrected rarely. */
export interface SessionMeta {
  readonly id: SessionId
  readonly created: string
  /**
   * When a **person last prompted or steered** the session, which is the age a row shows and what Last updated sorts by.
   *
   * DSH's list dates a row `max(createdAt, lastPromptAt)` (dsh-api-session-controller/lib/index.js:2124-2125), where
   * `lastPromptAt` is the time of the latest user-sourced `user/message`. So an answer, a tool result, a turn boundary or
   * a harness-written message (one with a `source`) does not move it; absent until the first prompt, when `created` stands.
   */
  readonly updated?: string
  readonly cwd: string
  readonly endpoint?: string
  readonly model?: string
  /**
   * The reasoning level the session runs with, when its model declares levels.
   *
   * Part of the same selection as `endpoint` and `model`, replaced with them in one write: a level belongs to
   * the model that declared it, so carrying one across a model switch would ask a provider for a level its
   * model never offered. Absent means the model's own default.
   */
  readonly reasoningEffort?: string
  readonly title?: string
  readonly turns: number
  /** Held at the top of its branch. A reading preference, but one a person sets and expects to persist. */
  readonly pinned?: boolean
  /**
   * When it was pinned, so several pinned sessions order by **recency of the pin** rather than by name.
   *
   * DSH keeps a registry-level list and **prepends** each new pin, which is the same order as a timestamp descending;
   * a per-session record cannot prepend, so it records the time that produces that order.
   */
  readonly pinnedAt?: string
  /** Out of the tree, and the log untouched: the reversible act, and the only one offered. */
  readonly archived?: boolean
  /**
   * The session that delegated this one, when this session is a subagent's.
   *
   * The same three fields DSH's `childSessionMeta` writes: the parent's id, the origin, and how deep the
   * delegation chain is. Attribution lives in the session record rather than in the transcript because a
   * child runs in its **own** log — the parent's transcript sees the delegation only as a tool call.
   */
  readonly parentSession?: SessionId
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  /**
   * The team this session belongs to, when it is a teammate's.
   *
   * A teammate runs in its own log, so "which team am I in" has to be answerable from the teammate's own
   * record: the Lead's session id. The team's journal is in the Lead's log; this field is how a tool called
   * inside a teammate's turn finds it.
   */
  readonly teamId?: SessionId
  /**
   * The agent preset this session runs under (inventory A96), recorded when it is created and never changed.
   *
   * DSH's rule: a session keeps the preset it was created with, so editing a preset or the default affects sessions
   * created afterwards. A session from before presets has none until its next turn records the current default
   * (`recordPreset`), after which it keeps that one too.
   */
  readonly preset?: string
}

/** The default root, overridable so a check can use a scratch directory. */
export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'sessions')
}

/**
 * The transcript a new session writes, and the one older sessions already have.
 *
 * The name carries the format version because a reader has to know what it is looking at before it
 * can decode, exactly as DSH's `session.v4.jsonl.zstd` does. A v1 transcript — plain JSONL — is
 * still read, still appended to, and never rewritten to change how it is stored: a session keeps the
 * format it was born with.
 */
export const TRANSCRIPT_NAME = 'session.v2.jsonl.zstd'
export const LEGACY_TRANSCRIPT_NAME = 'session.jsonl'

/**
 * Whether a transcript path is one of the **zstd-framed** ones.
 *
 * Asked of the suffix rather than of the whole legacy file name, because the layout changed the name: a log
 * is now `<session-id>.v2.jsonl.zstd` inside its workspace folder, and a test for `session.v2.jsonl.zstd`
 * silently answered "plain JSONL" for every session written since — which, after a repair, would have
 * appended lines to a framed file.
 */
export function isFramed(path: string): boolean {
  return path.endsWith('.v2.jsonl.zstd')
}

/** Whether this build can compress. Node gained zstd in 22.15; older runtimes write plain JSONL. */
export function canCompress(): boolean {
  return typeof zstdCompressSync === 'function'
}

/**
 * The log's file name for one session id, in the **workspace folder** layout.
 *
 * The id is the file's name, so a log can be cited, copied or deleted without a directory of its own; the
 * format's suffix is the one the store already used, which is why a compressed log reads
 * `<id>.v2.jsonl.zstd` and an uncompressed one reads exactly `<id>.jsonl`.
 */
export function logName(id: string): string {
  return `${id}${canCompress() ? '.v2.jsonl.zstd' : '.jsonl'}`
}

/** The metadata's file name for one session id, beside its log in the workspace folder. */
export function metaName(id: string): string {
  return `${id}.json`
}

/** The transcript a session directory holds, preferring the current format. */
export function transcriptIn(dir: string): string {
  for (const name of [TRANSCRIPT_NAME, LEGACY_TRANSCRIPT_NAME]) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return join(dir, canCompress() ? TRANSCRIPT_NAME : LEGACY_TRANSCRIPT_NAME)
}

/**
 * The **surface**: the positional view of a log, which is what a request is derived from.
 *
 * Modelled on `@deepseek-ai/dsh-session`'s surface, and the reason it exists is the one thing an
 * append-only log cannot do by itself: let something be *replaced* without being *erased*. A
 * compaction, a pruning and a rewritten system prompt all want the model to stop seeing an old
 * span while a person still can, and DSH gets that by keeping the log immutable and giving the
 * model a second, derived view of it.
 *
 * Two rules hold the whole thing up:
 *
 * - **Only message-producing events take a position.** Everything else — the rest of a streamed
 *   run, a request record, a compaction marker — is log-only, which is what lets the log carry the
 *   record of a rewrite without the rewrite becoming conversation.
 * - **What the harness wrote is not what a person said.** A system prompt, an instruction baseline
 *   and a compaction checkpoint are all model-visible messages, but none of them is a turn somebody
 *   took, so they are `context/note` events rather than `message` ones. That distinction is what
 *   keeps a transcript honest *by construction*: a view of the conversation shows `message` and
 *   chunk events, and a note cannot leak into it because it never claimed to be one. Measured the
 *   other way: with the checkpoint written as a user `message`, the Web UI showed a compaction to
 *   the reader as though they had typed it.
 * - **A replacement names positions, not a new history.** The replacement event is written later,
 *   so its `seq` is higher than everything it shadows; it splices the positions it covers and
 *   records which seqs it found there, so a replay is exact.
 */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set(['message', 'context/note', 'assistant/chunk'])

/** How an event entered the surface. An event with no marker in an older log is an append. */
export type SurfaceOp = 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/** One landed replacement, kept so a reader can see what a node shadowed. */
export interface SurfaceReplacement {
  readonly seq: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
}

/** The positional view of a log: the nodes the model can see, in order. */
export interface SurfaceState {
  /** The `seq` of every node, in surface order — which is not seq order after a replacement. */
  readonly nodes: readonly number[]
  /** Bumped by an append and by a replacement: the derivation cache key. */
  readonly contentGeneration: number
  /** Bumped only by a replacement: "a rewrite has landed", which is what a retry waits for. */
  readonly replaceGeneration: number
  readonly replacements: readonly SurfaceReplacement[]
}

/** Whether an event type can take a position on the surface. */
export function isSurfaceEligible(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/** Whether an operation is a replacement, narrowing its range. */
export function isReplacementOp(
  op: SurfaceOp | undefined,
): op is { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number } {
  return typeof op === 'object' && op !== null && op.op === 'replace'
}

/**
 * Whether an event ends a model step for the fold: the next request, or the turn's retry or end.
 *
 * A chunk run that never got its `done` (a stop, a failed stream) ends here, and a message held for the step
 * boundary is placed.
 */
export function endsStep(type: string): boolean {
  return type === 'model/request' || type.startsWith('turn/')
}

/**
 * Fold a log into its surface.
 *
 * The chunk rule is where this store's own choice meets the surface: heddle records **every**
 * streamed chunk as it arrives, so an interrupted answer is not lost, while DSH settles a stream
 * into one message. The fold resolves that by giving the surface one node per run — the seq of its
 * first chunk — and deriving the run's message from the chunks that follow.
 *
 * **A message that lands mid-step is placed at the step boundary** (#30). A steer, a subagent's settlement notice and
 * a teammate's mail are written when they arrive, which can be while the model is still streaming. Placed where it
 * landed, such a message closed the run: the rest of the step became a second assistant node after it, the next
 * request ended with that assistant message, the provider read it as a prefix to continue (in thinking mode it
 * refused it for want of its reasoning), and the model never saw its own reply before the message. DSH claims such
 * input at the next step boundary. So a message that lands while a run is open is held. It is placed when the run
 * closes, or, when the step called tools, once their results are placed, so a call and its result stay adjacent. A
 * new request, the turn's end or a replacement places whatever is still held.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceState {
  const nodes: number[] = []
  const replacements: SurfaceReplacement[] = []
  let contentGeneration = 0
  let replaceGeneration = 0
  let openChunk: number | undefined
  /** The tool calls of the open run. */
  let runCalls = new Set<string>()
  /** The calls of the run that closed last whose results are not all placed yet. */
  let awaiting = new Set<string>()
  /** Messages that landed mid-step, in arrival order. */
  let held: number[] = []
  const place = (seq: number): void => {
    nodes.push(seq)
    contentGeneration += 1
  }
  const release = (): void => {
    for (const seq of held) place(seq)
    held = []
    awaiting = new Set()
  }

  for (const event of events) {
    const op = event.surfaceOp as SurfaceOp | undefined
    if (isReplacementOp(op)) {
      release()
      runCalls = new Set()
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx < startIdx) {
        throw new Error(
          `session event ${event.seq}: a replacement names a range that is not on the surface (${op.startSeq}..${op.endSeq})`,
        )
      }
      const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
      nodes.splice(startIdx, shadowedSeqs.length, event.seq)
      replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowedSeqs })
      contentGeneration += 1
      replaceGeneration += 1
      openChunk = undefined
      continue
    }
    if (endsStep(event.type)) {
      openChunk = undefined
      runCalls = new Set()
      release()
      continue
    }
    if (isSurfaceEligible(event.type) && event.type !== 'assistant/chunk') {
      // A `message` the person or the model produced, or a `context/note` the harness wrote: both take a position,
      // and neither is a chunk run. Mid-step, the position is the step boundary.
      if (openChunk !== undefined) {
        held.push(event.seq)
        continue
      }
      if (awaiting.size > 0) {
        const message = event.message as { readonly role?: string; readonly toolCallId?: string } | undefined
        if (message?.role === 'tool' && typeof message.toolCallId === 'string' && awaiting.has(message.toolCallId)) {
          place(event.seq)
          awaiting.delete(message.toolCallId)
          if (awaiting.size === 0) release()
        } else {
          held.push(event.seq)
        }
        continue
      }
      place(event.seq)
      continue
    }
    if (event.type === 'assistant/chunk') {
      if (openChunk === undefined) {
        place(event.seq)
        openChunk = event.seq
        runCalls = new Set()
      }
      const chunk = event.chunk as Chunk | undefined
      if (chunk?.type === 'tool-call') runCalls.add(chunk.id)
      if (chunk?.type === 'done') {
        openChunk = undefined
        if (runCalls.size > 0) awaiting = runCalls
        else release()
        runCalls = new Set()
      }
    }
  }
  // The log may end mid-step (a turn still streaming, or its tools still running): what is held is shown at the end,
  // and the next fold, over a longer log, places it at the boundary.
  release()

  return { nodes, contentGeneration, replaceGeneration, replacements }
}

/**
 * The message one node derives to, or null when it produces none.
 *
 * A chunk run derives **one part per block, not one per delta**: consecutive `text-delta`s join into one `text` part
 * and consecutive `reasoning-delta`s into one `reasoning` part, while a `tool-call` (or a switch between text and
 * reasoning) starts the next part. That is DSH's assembly — `BlockAssembler.push` appends every delta of a block to one
 * partial (`partial.text += chunk.text`, dsh-llm `lib/types/assembler.js:46-52`) — and it matters on the wire: the chat
 * adapter keeps separate text blocks apart with a newline, so a part per delta handed the model its own earlier answer
 * broken at every point where the stream split it (live-testing draft developer-five-2). The log itself still holds
 * one event per chunk; only the derivation coalesces. The Rust twin is `derive_message` in heddle-session `surface.rs`.
 */
export function deriveMessage(bySeq: ReadonlyMap<number, SessionEvent>, seq: number): Message | null {
  const event = bySeq.get(seq)
  if (event === undefined) return null
  if (event.type === 'message' || event.type === 'context/note') {
    const message = event.message as Message | undefined
    if (message === undefined || message.content.length === 0) return null
    return message
  }
  if (event.type !== 'assistant/chunk') return null
  const content: ContentPart[] = []
  /** Append a delta to the part it continues — the last one, when it is the same kind — or start a new part. */
  const delta = (type: 'text' | 'reasoning', text: string): void => {
    const last = content.at(-1)
    if (last !== undefined && last.type === type) content[content.length - 1] = { type, text: last.text + text }
    else content.push({ type, text })
  }
  for (let index = seq; ; index += 1) {
    const next = bySeq.get(index)
    if (next === undefined) break
    if (next.type !== 'assistant/chunk') {
      // A message held for the step boundary, an inbox splice or any other note written while the model streamed is
      // not part of its step (#30): the step runs to its `done`, or to a new request or the turn's end.
      if (endsStep(next.type)) break
      continue
    }
    const chunk = next.chunk as Chunk | undefined
    if (chunk === undefined) continue
    if (chunk.type === 'text-delta') delta('text', chunk.text)
    else if (chunk.type === 'reasoning-delta') delta('reasoning', chunk.text)
    else if (chunk.type === 'tool-call') content.push({ type: 'tool-call', id: chunk.id, name: chunk.name, arguments: chunk.arguments })
    else if (chunk.type === 'done') break
  }
  return content.length === 0 ? null : { role: 'assistant', content }
}

/**
 * The events a fork inherits: everything up to the **last completed turn**.
 *
 * DSH cuts its fork seed at `latestCompletedPrefixBoundary` and refuses a source with no completed turn. A session here can
 * hold a user message whose answer never arrived; copying that dangling half-turn would ask the model to continue work it
 * never saw finish, so the cut excludes it. A log with no `turn/completed` returns as it is — callers decide whether that is
 * forkable at all (the service refuses it).
 */
export function completedPrefix(events: readonly SessionEvent[]): readonly SessionEvent[] {
  let boundary: number | undefined
  for (const event of events) {
    if (event.type === 'turn/completed') boundary = event.seq
  }
  if (boundary === undefined) return events
  return events.filter((event) => event.seq <= boundary)
}

/**
 * Whether the conversation a fork would inherit contains an **assistant message**.
 *
 * This is the question a fork's refusal turns on: a session whose question was recorded and whose answer never arrived has
 * nothing to continue, while a session that was itself forked holds copied messages and no assistant chunks — so the test
 * reads the **projection of the completed prefix**, not the event vocabulary.
 */
export function inheritsAnswer(events: readonly SessionEvent[]): boolean {
  const inherited = completedPrefix(events)
  const bySeq = indexBySeq(inherited)
  /** A copied conversation is plain `message` events, which the projection sees as an assistant message. */
  if (foldSurface(inherited).nodes.some((seq) => deriveMessage(bySeq, seq)?.role === 'assistant')) return true
  /**
   * A recorded turn carries `assistant/completed` **beside** its deltas (the server reads deltas for display and the
   * completed event for the record), so an answer is present when either form is there.
   */
  return inherited.some((event) => event.type === 'assistant/completed')
}

/**
 * Whether a fork inherits an event of this type.
 *
 * DSH's seed is the source's exact event prefix (`buildForkSeed`, dsh-session/lib/types/fork.js:18-27), and a child
 * here inherits the same — with four exceptions, each an event that belongs to the **source** rather than to the
 * conversation, and that this store has no inherited-prefix mark to neutralise (DSH passes `inheritedEventCount` to every
 * projection, dsh-session/lib/index.js:1418-1426; heddle's folds read the whole log):
 *
 * - `session/created`: the child writes its own, with its own clock.
 * - `transcript/repaired`: it reports bytes cut from the source's file, not the child's.
 * - `goal/change`: heddle arms an active goal whenever a process folds one (src/goal/service.ts, `activationOf`), so an
 *   inherited goal would start spending rounds in the branch; DSH disarms it after a fork.
 * - `team/*`: the team journal names the source as its Lead (`teamId`), and `foldTeam` refuses a foreign one, so a
 *   copied journal would break the child's team tools.
 */
export function inheritedByFork(type: string): boolean {
  return type !== 'session/created' && type !== 'transcript/repaired' && type !== 'goal/change' && !type.startsWith('team/')
}

/** A recorded field that names one other event by its seq, in a log-only record (a compaction's own bookkeeping). */
const SEQ_FIELDS = ['fromSeq', 'throughSeq', 'summarySeq', 'replacementSeq'] as const
/** A recorded field that names several events by seq. */
const SEQ_LIST_FIELDS = ['sourceEventSeqs', 'shadowedSeqs'] as const

/**
 * The events a fork's child is seeded with: the inherited ones, as they were recorded, numbered on from `firstSeq`.
 *
 * Each event keeps its own time and every field in its written order, so the child's view, its surface and its
 * model context are the source's: a streamed answer stays chunks (its reasoning a reasoning block, a call a named call),
 * and a compaction stays a summary standing in for turns the child still shows (#52, #55). The child's own
 * `session/created` takes seq 0 and so does the source's, so the seqs normally carry over unchanged and the
 * events are copied byte for byte. When an event is left out (see {@link inheritedByFork}) the ones after it move
 * down, and every field that names a seq is renumbered with them — the surface's `surfaceOp` range above all, which
 * the fold resolves by position, plus the compaction records' `fromSeq`, `throughSeq`, `summarySeq`,
 * `replacementSeq`, `shadowedSeqs`, `shadowedRange` and a replacement's `sourceEventSeqs`. A seq that names no
 * inherited event is left as written. The Rust twin is `fork_seed` in heddle-session `surface.rs`.
 */
export function forkSeed(inherited: readonly SessionEvent[], firstSeq: number): readonly SessionEvent[] {
  const kept = inherited.filter((event) => inheritedByFork(event.type))
  if (kept.every((event, index) => event.seq === firstSeq + index)) return kept
  const renumbered = new Map<number, number>()
  kept.forEach((event, index) => renumbered.set(event.seq, firstSeq + index))
  const moved = (seq: unknown): unknown => (typeof seq === 'number' ? (renumbered.get(seq) ?? seq) : seq)
  /** Renumber the named fields that are present, in place in a copy, so no field moves and none is added. */
  const renumber = (record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const copy = { ...record }
    for (const key of keys) if (key in copy) copy[key] = moved(copy[key])
    return copy
  }
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  return kept.map((event, index) => {
    const copy = renumber({ ...event, seq: firstSeq + index }, SEQ_FIELDS)
    for (const key of SEQ_LIST_FIELDS) {
      const list = copy[key]
      if (Array.isArray(list)) copy[key] = list.map(moved)
    }
    if (isRecord(copy.surfaceOp) && copy.surfaceOp.op === 'replace') copy.surfaceOp = renumber(copy.surfaceOp, ['startSeq', 'endSeq'])
    if (isRecord(copy.shadowedRange)) copy.shadowedRange = renumber(copy.shadowedRange, ['start', 'end'])
    return copy as SessionEvent
  })
}

/** Index a log by seq, which every derivation over it wants. */
export function indexBySeq(events: readonly SessionEvent[]): ReadonlyMap<number, SessionEvent> {
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) bySeq.set(event.seq, event)
  return bySeq
}

/** The message one surface node derives to, or null when it produces none. */
export function deriveNodeMessage(events: readonly SessionEvent[], seq: number): Message | null {
  return deriveMessage(indexBySeq(events), seq)
}

/**
 * Where the transcript can be read.
 *
 * A session records under the directory its process ran in, and the record names
 * that directory, so the caller can decide whether a session belongs to them
 * rather than guessing from the store's shape.
 *
 * Every append is also handed to an `onEvent` listener, which is how the Web UI sees
 * a turn **while it is happening**. Reading the file on a timer would have worked and
 * would have been a second copy of the truth with its own lag; the listener fires from
 * the one write path, so what a browser shows is what was just written.
 */
/**
 * A flag the store refuses for a reason that is not "no such session".
 *
 * Pinning and archiving are mutually exclusive in the reference, and a silence that answered `null` for both an unknown
 * session and a refused pin would leave a route unable to tell a 404 from a 409.
 */
export class SessionFlagError extends Error {
  readonly code: 'archived' | 'not-archived'
  readonly id: string

  constructor(code: 'archived' | 'not-archived', id: string) {
    super(code === 'archived' ? `session ${id} is archived and cannot be pinned` : `session ${id} is not archived`)
    this.name = 'SessionFlagError'
    this.code = code
    this.id = id
  }
}

/**
 * Whether a session, or a session above it in its **subagent** lineage, is archived — the question DSH's archived-session
 * gate asks before every model step (`underArchivedSession`, dsh-api-session-controller lib/index.js:2528-2541).
 *
 * The walk follows `parentSession` only through `origin: 'subagent'` records, as DSH's follows its durable header: a
 * delegated child of an archived session runs no step either, while a fork (a `parentSession` with no origin) is an
 * independent conversation. A parent whose record cannot be read ends the walk unarchived, and a cycle ends it too.
 * Pure over a lookup so a caller can judge it without a store.
 */
export function underArchivedSession(
  lookup: (id: SessionId) => Pick<SessionMeta, 'id' | 'archived' | 'origin' | 'parentSession'> | null | undefined,
  id: SessionId,
): boolean {
  let meta = lookup(id)
  const visited = new Set<string>()
  while (meta !== null && meta !== undefined && !visited.has(meta.id)) {
    if (meta.archived === true) return true
    visited.add(meta.id)
    if (meta.origin !== 'subagent' || meta.parentSession === undefined) return false
    meta = lookup(meta.parentSession)
  }
  return false
}

/**
 * A write refused because another process holds the session's writer lock.
 *
 * The sentence is DSH's `SessionAlreadyOwnedError` word for word (`@deepseek-ai/dsh-session-persistence`), and the
 * code is the one its session controller answers a resume with (`session/writer-held`); the holder's pid is added in
 * brackets because a person who is refused needs to know which process to stop. Read-only access is never refused.
 */
export class SessionOwnedError extends Error {
  readonly code = 'session/writer-held'
  readonly id: string
  /** The process named in the lock, when the lock named one. */
  readonly pid: number | undefined

  constructor(id: string, pid?: number) {
    super(`session "${id}" is already owned by an active write handle${pid !== undefined ? ` (process ${pid})` : ''}`)
    this.name = 'SessionAlreadyOwnedError'
    this.id = id
    this.pid = pid
  }
}

/**
 * Where a session's writer lock is: `<id>.lock` beside its log, or `session.lock` inside an old-layout session
 * directory — DSH's `session.lock`, named the way this layout names everything else of one session.
 *
 * The Rust store uses the same path and the same contents (the holder's pid and a newline), so either build refuses
 * a writer the other one holds.
 */
export function lockPath(handle: SessionHandle): string {
  return basename(handle.meta) === 'meta.json' ? join(handle.dir, 'session.lock') : join(handle.dir, `${handle.id}.lock`)
}

/**
 * How long a lock file with no pid in it is taken to be one being written, rather than one left half-written.
 *
 * The holder creates the file and writes its pid in the next call, so an empty lock older than this is debris.
 */
const UNWRITTEN_LOCK_GRACE_MS = 5_000

/** The lock files this process holds, and how many stores in it hold each — the last one to let go removes it. */
const heldByProcess = new Map<string, number>()
let exitHookInstalled = false

/** Whether a process with this pid exists. A process this user may not signal (`EPERM`) exists. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid a lock file names, or undefined when it names none. */
function lockHolder(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const pid = Number(trimmed)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Remove a lock file only if it still names this process, so letting go never removes somebody else's lock. */
function removeOwnLock(path: string): void {
  try {
    if (lockHolder(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path)
  } catch {
    // Already gone, or unreadable: there is nothing of ours left to remove.
  }
}

/**
 * Take a session's writer lock for this process, or throw {@link SessionOwnedError}.
 *
 * DSH arbitrates with a kernel `flock(2)` on `session.lock`, which Node cannot take without a native addon; a lock
 * file created with `O_EXCL` and naming its holder's pid is the portable equivalent both builds can share. What
 * flock gives for free is supplied by hand: a holder that died without letting go (a crash, `SIGKILL`) leaves a
 * file naming a pid that no longer exists, and that lock is removed and taken rather than blocking the session
 * forever. A live holder is never expropriated, as in DSH: there is no expiry that could let a stalled writer's
 * resumed appends tear the log.
 *
 * Answers whether this process **took** the lock now (true) or already held it through another store (false): only a
 * fresh take is a write-open after whatever wrote the session before, which is when an unfinished turn is closed.
 */
function acquireWriterLock(path: string, id: string): boolean {
  const count = heldByProcess.get(path)
  if (count !== undefined) {
    heldByProcess.set(path, count + 1)
    return false
  }
  const take = (): void => {
    heldByProcess.set(path, 1)
    if (!exitHookInstalled) {
      exitHookInstalled = true
      process.once('exit', () => {
        for (const held of heldByProcess.keys()) removeOwnLock(held)
      })
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      take()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let text: string
    let modified: number
    try {
      text = readFileSync(path, 'utf8')
      modified = statSync(path).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const holder = lockHolder(text)
    if (holder === process.pid) {
      take()
      return true
    }
    if (holder !== undefined && processAlive(holder)) throw new SessionOwnedError(id, holder)
    if (holder === undefined && Date.now() - modified < UNWRITTEN_LOCK_GRACE_MS) throw new SessionOwnedError(id)
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new SessionOwnedError(id)
}

/** Let go of one store's hold on a lock; the last hold in this process removes the file. */
function releaseWriterLock(path: string): void {
  const count = heldByProcess.get(path)
  if (count === undefined) return
  if (count > 1) {
    heldByProcess.set(path, count - 1)
    return
  }
  heldByProcess.delete(path)
  removeOwnLock(path)
}

export class SessionStore {
  readonly root: string
  private readonly onEvent: ((handle: SessionHandle, event: SessionEvent) => void) | undefined
  /**
   * Parsed events per session, and whether that session's transcript is compressed.
   *
   * This is the **fold**: the file stays the durable record, and a process that has opened a session
   * keeps its events in memory, advancing them on append. It exists because of a measurement — a
   * single turn re-read and re-parsed the whole transcript **21 times** (five `read` calls and
   * sixteen `count` calls, and `count` read the file too), so the cost of a turn grew with the
   * square of the session's length. Loading once per process makes that linear, and it is also what
   * makes compressed storage affordable: decompression happens once per session per process rather
   * than once per read.
   *
   * The trade is stated rather than hidden: the fold is only as fresh as the last time this process
   * read the file. That is safe for writing because only the holder of the session's writer lock
   * appends, and taking the lock drops the fold so the first write re-reads what another process
   * may have appended before it let go. A process that only reads may show an older history until
   * it opens the session again.
   */
  private readonly loaded = new Map<string, { readonly events: SessionEvent[]; readonly framed: boolean }>()

  /** The sessions this store holds the writer lock for, and where each lock is. */
  private readonly held = new Map<string, string>()

  /**
   * Folded surfaces, keyed by session and the log length they were folded at.
   *
   * A log only ever grows, so its event count is a sound cache key — and a turn asks for the
   * surface once per round, which is exactly where re-folding a long log on every call would show.
   */
  private readonly surfaceCache = new Map<string, { readonly count: number; readonly state: SurfaceState }>()

  /**
   * The automatic titles of this store's sessions (`./title.ts`, DSH's first-prompt title). Idle until a model is
   * attached, which the session plugin does; it lives on the store so every service over this store shares one record
   * of which call may still land.
   */
  readonly titles: SessionTitles = new SessionTitles(this)

  constructor(
    root: string = defaultSessionRoot(),
    options: { readonly onEvent?: (handle: SessionHandle, event: SessionEvent) => void } = {},
  ) {
    // `~` is expanded because the profile writes `~/.heddle/sessions` and a
    // literal `~` directory beside the project is the wrong place to put it.
    this.root = resolve(root.startsWith('~') ? join(homedir(), root.slice(1)) : root)
    this.onEvent = options.onEvent
  }

  /**
   * Create a session, filed under the workspace it belongs to.
   *
   * The owner's layout of 2026-10-11: one folder per workspace and one file per session inside it, so the
   * store reads as a list of the folders a person worked in rather than as a list of opaque directories.
   */
  create(
    options: {
      readonly cwd?: string
      readonly endpoint?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly title?: string
      readonly parentSession?: SessionId
      readonly origin?: 'subagent'
      readonly delegationDepth?: number
      readonly teamId?: SessionId
      /** The agent preset the session runs under; absent until a turn records the default. */
      readonly preset?: string
      /** An id chosen by the caller, so a journal entry can name a session before it is created. */
      readonly id?: SessionId
    } = {},
  ): SessionHandle {
    const id = options.id ?? `session-${randomUUID()}`
    if (id.trim().length === 0) throw new Error('a session id must not be empty')
    const cwd = options.cwd ?? process.cwd()
    const dir = join(this.root, workspaceKey(cwd))
    mkdirSync(dir, { recursive: true })
    const handle: SessionHandle = { id, dir, transcript: join(dir, logName(id)), meta: join(dir, metaName(id)) }
    /** A title is cleaned as DSH cleans an accepted one (`./title-text.ts`); one with nothing visible left is not written. */
    const title = options.title === undefined ? '' : normalizeSessionTitle(options.title)
    writeFileSync(
      handle.meta,
      `${JSON.stringify(
        {
          id,
          created: new Date().toISOString(),
          cwd,
          ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(title.length > 0 ? { title } : {}),
          ...(options.parentSession !== undefined ? { parentSession: options.parentSession } : {}),
          ...(options.origin !== undefined ? { origin: options.origin } : {}),
          ...(options.delegationDepth !== undefined ? { delegationDepth: options.delegationDepth } : {}),
          ...(options.teamId !== undefined ? { teamId: options.teamId } : {}),
          ...(options.preset !== undefined ? { preset: options.preset } : {}),
          turns: 0,
        },
        null,
        2,
      )}\n`,
    )
    appendFileSync(handle.transcript, '')
    this.append(handle, { type: 'session/created', cwd })
    return handle
  }

  /**
   * Retitle a session in place.
   *
   * The **meta file** is a record, not the log: `session.jsonl` stays append-only and untouched, so a
   * rename cannot rewrite anything a run recorded. Only the title a person reads is replaced, and the
   * empty string clears it rather than leaving a blank name behind.
   *
   * The title is **cleaned as DSH cleans an accepted one** first (`./title-text.ts`, `dsh-session-title`
   * `normalizeSessionTitle`): controls and escape sequences removed, whitespace collapsed, at most 80 UTF-8 bytes.
   * Measured before: every title was kept as sent, a right-to-left override and an ANSI sequence included. A title
   * with nothing visible left clears, as a blank one does; refusing it is the route's answer, as in DSH.
   */
  rename(id: SessionId, title: string): SessionMeta | null {
    const current = this.list().find((meta) => meta.id === id)
    if (current === undefined) return null
    const trimmed = normalizeSessionTitle(title)
    const next: SessionMeta = {
      ...current,
      ...(trimmed.length > 0 ? { title: trimmed } : {}),
    }
    if (trimmed.length === 0) delete (next as { title?: string }).title
    const meta = this.metaFile(id)
    if (meta === null) return null
    writeFileSync(meta, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /**
   * Record the agent preset a session runs under, **only when it has none** (inventory A96).
   *
   * A session keeps its preset, so this never replaces one: it is how a session created before presets, or by a path
   * that named none, takes the current default once and then keeps it. Answers the record as it now is, or null for an
   * unknown session.
   */
  recordPreset(id: SessionId, preset: string): SessionMeta | null {
    const current = this.list().find((meta) => meta.id === id)
    if (current === undefined) return null
    if (current.preset !== undefined || preset.trim().length === 0) return current
    const next: SessionMeta = { ...current, preset: preset.trim() }
    const meta = this.metaFile(id)
    if (meta === null) return null
    writeFileSync(meta, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /**
   * Set or clear a session's **flags** — pinned, archived — and answer with the record as it now is.
   *
   * One method rather than one per flag, because the two are the same kind of fact about a session and the same
   * file holds them: a caller that wanted both would otherwise write the meta twice and could be interrupted
   * between the writes with half of its intent on disk. The rule is `rename`'s: the meta is a record, the log is
   * append-only, and a flag that is false is **deleted** rather than stored as false, so a record says only what
   * is true of the session.
   */
  flags(id: SessionId, patch: { readonly pinned?: boolean; readonly archived?: boolean }): SessionMeta | null {
    const current = this.list().find((meta) => meta.id === id)
    if (current === undefined) return null
    const next: SessionMeta = { ...current }
    if (patch.pinned !== undefined) {
      if (patch.pinned) {
        /** Archived and pinned are exclusive in the reference: an archived session cannot be pinned at all. */
        if (current.archived === true) throw new SessionFlagError('archived', id)
        ;(next as { pinned?: boolean }).pinned = true
        ;(next as { pinnedAt?: string }).pinnedAt = new Date().toISOString()
      } else {
        delete (next as { pinned?: boolean }).pinned
        delete (next as { pinnedAt?: string }).pinnedAt
      }
    }
    if (patch.archived !== undefined) {
      if (patch.archived) {
        ;(next as { archived?: boolean }).archived = true
        /** Archiving **drops the pin** in the same write, as DSH's archive does. */
        delete (next as { pinned?: boolean }).pinned
        delete (next as { pinnedAt?: string }).pinnedAt
      } else {
        delete (next as { archived?: boolean }).archived
      }
    }
    const meta = this.metaFile(id)
    if (meta === null) return null
    writeFileSync(meta, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /** One session's record, read from its own file; `null` for an unknown id or an unreadable record. */
  meta(id: SessionId): SessionMeta | null {
    const file = this.metaFile(id)
    if (file === null) return null
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')) as SessionMeta
      return typeof meta?.id === 'string' ? meta : null
    } catch {
      return null
    }
  }

  /**
   * Whether the session or a subagent ancestor is archived (`underArchivedSession`), read from the records **now**: the
   * agent loop asks before every step, so an archive written by another process stops the next step too.
   */
  underArchived(id: SessionId): boolean {
    return underArchivedSession((one) => this.meta(one), id)
  }

  /**
   * Seed a new session with a session's **log** up to its last completed turn, and answer with the new session.
   *
   * A fork is a new conversation that starts where another one stood, and it starts there by replaying the source's
   * events, as DSH's does: `session/fork` cuts at `latestCompletedPrefixBoundary` and seeds the child with that exact
   * prefix (dsh-api-session-controller/lib/index.js:724-733 and 870-872, `buildForkSeed` in
   * dsh-session/lib/types/fork.js:18-27). This copied the **projection** instead — one `message` per surface node — and
   * the child read differently from its source on both builds: a streamed answer became one assistant message whose
   * reasoning the chat drew glued in front of the answer, a tool call lost its name and command (#52), and a compacted
   * source handed over its summary and live turns only, so the branch started mid-conversation (#55). The seed is
   * {@link forkSeed}; the system prompt, the instruction baseline and a runtime-context snapshot come along as the notes
   * they were, at the positions they held, so the child's next round finds them and writes no second copy.
   */
  fork(
    source: SessionId,
    attribution: {
      readonly parentSession?: SessionId
      readonly origin?: 'subagent'
      readonly delegationDepth?: number
      readonly teamId?: SessionId
      readonly title?: string
      readonly id?: SessionId
    } = {},
  ): SessionHandle | null {
    const from = this.open(source)
    if (from === null) return null
    const meta = this.list().find((one) => one.id === source)
    const handle = this.create({
      ...(meta?.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta?.endpoint !== undefined ? { endpoint: meta.endpoint } : {}),
      ...(meta?.model !== undefined ? { model: meta.model } : {}),
      ...(meta?.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
      ...(attribution.title !== undefined ? { title: attribution.title } : {}),
      ...(attribution.parentSession !== undefined ? { parentSession: attribution.parentSession } : {}),
      ...(attribution.origin !== undefined ? { origin: attribution.origin } : {}),
      ...(attribution.delegationDepth !== undefined ? { delegationDepth: attribution.delegationDepth } : {}),
      ...(attribution.teamId !== undefined ? { teamId: attribution.teamId } : {}),
      ...(attribution.id !== undefined ? { id: attribution.id } : {}),
    })
    /**
     * The fork inherits what the source had **finished**: its log cut at the last completed turn. A dangling user
     * message — one whose answer never arrived — is not carried over.
     */
    const events = completedPrefix(this.read(from))
    this.seed(handle, events)
    return handle
  }

  /**
   * Write a fork's inherited events into its new log ({@link forkSeed}), after the child's own `session/created`.
   *
   * Written as one append and **not published**: the seed is history the child starts from, not activity, so neither
   * the live stream, nor the goal and reminder drivers, nor the title coordinator hear its `model/request` and
   * `turn/completed` events as a turn happening now. DSH's seeded session does the same: its constructor pushes each
   * seed event into the log after checking it against the surface, and its live events start after them
   * (dsh-session/lib/index.js:1399-1411). The result is folded here before anything is written, because a seed whose
   * replacements did not land on the child's surface would leave a log nothing can read. The meta counts the inherited
   * user messages as turns, as `message()` counted them in the source.
   */
  private seed(handle: SessionHandle, inherited: readonly SessionEvent[]): void {
    this.claim(handle)
    const log = this.load(handle)
    const records = forkSeed(inherited, log.events.length)
    if (records.length === 0) return
    foldSurface([...log.events, ...records])
    const lines = records.map((record) => `${JSON.stringify(record)}\n`)
    appendFileSync(handle.transcript, log.framed ? Buffer.concat(lines.map(encodeFrame)) : Buffer.from(lines.join(''), 'utf8'))
    /** One push per event: a long source's seed is far more events than a spread may pass as arguments. */
    for (const record of records) log.events.push(record)
    const turns = records.filter((record) => record.type === 'message' && (record.message as RecordedMessage | undefined)?.role === 'user').length
    this.touch(handle, { addTurns: turns })
  }

  /**
   * Record which endpoint and model a session runs with — the model switcher's one write.
   *
   * The same rule as `rename`, for the same reason: the meta file is a record, not the log, so only the
   * fields a person changed are replaced and the append-only transcript is never touched. The selection is
   * **replaced rather than merged**: a model override belongs to the endpoint that answered with it, so
   * switching endpoints drops it, and a switch that carried the old model across would silently ask the new
   * endpoint for a model it may not serve. The caller validates the endpoint against the model service; this
   * layer records what it is told.
   */
  setModel(
    id: SessionId,
    selection: { readonly endpoint: string; readonly model?: string; readonly reasoningEffort?: string },
  ): SessionMeta | null {
    const current = this.list().find((meta) => meta.id === id)
    if (current === undefined) return null
    const endpoint = selection.endpoint.trim()
    if (endpoint.length === 0) return null
    const model = selection.model?.trim()
    const reasoningEffort = selection.reasoningEffort?.trim()
    const next: SessionMeta = { ...current, endpoint }
    if (model !== undefined && model.length > 0) (next as { model?: string }).model = model
    else delete (next as { model?: string }).model
    if (reasoningEffort !== undefined && reasoningEffort.length > 0) (next as { reasoningEffort?: string }).reasoningEffort = reasoningEffort
    else delete (next as { reasoningEffort?: string }).reasoningEffort
    const meta = this.metaFile(id)
    if (meta === null) return null
    writeFileSync(meta, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /**
   * Where a session's metadata is, in whichever layout it was written in.
   *
   * Two layouts are read and only one is written: a session created before the workspace folders existed
   * lives in `<root>/<id>/meta.json` and keeps its own directory, because a session keeps the shape it was
   * born with — the same rule the transcript format already follows. A new one lives at
   * `<root>/<workspace>/<id>.json`.
   */
  private metaFile(id: SessionId): string | null {
    const legacy = join(this.root, id, 'meta.json')
    if (existsSync(legacy)) return legacy
    try {
      for (const name of readdirSync(this.root)) {
        const candidate = join(this.root, name, metaName(id))
        if (existsSync(candidate)) return candidate
      }
    } catch {
      return null
    }
    return null
  }

  /** Open an existing session by id, or by the newest one when `id` is omitted. */
  open(id?: SessionId): SessionHandle | null {
    if (id !== undefined) {
      const meta = this.metaFile(id)
      if (meta === null) return null
      const dir = dirname(meta)
      const transcript = existsSync(join(dir, logName(id))) ? join(dir, logName(id)) : transcriptIn(dir)
      return { id, dir, transcript, meta }
    }
    const newest = this.list()[0]
    return newest === undefined ? null : this.open(newest.id)
  }

  /**
   * Sessions newest first, from both layouts.
   *
   * The walk reads a session's own directory (the old shape) and every workspace folder's `<id>.json` (the
   * current one), so a store that holds both answers with all of its sessions and none of them twice.
   */
  list(): readonly SessionMeta[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    const metas = new Map<string, SessionMeta>()
    const remember = (text: string): void => {
      try {
        const meta = JSON.parse(text) as SessionMeta
        if (typeof meta?.id === 'string' && !metas.has(meta.id)) metas.set(meta.id, meta)
      } catch {
        // A file that is not metadata is not a reason to lose the sessions that are.
      }
    }
    for (const name of names) {
      const at = join(this.root, name)
      if (name.startsWith('session-')) {
        try {
          remember(readFileSync(join(at, 'meta.json'), 'utf8'))
        } catch {
          // A session directory without readable metadata is skipped, as it always was.
        }
        continue
      }
      let entries: string[]
      try {
        entries = readdirSync(at)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue
        try {
          remember(readFileSync(join(at, entry), 'utf8'))
        } catch {
          continue
        }
      }
    }
    return [...metas.values()].sort((left, right) => (left.created < right.created ? 1 : -1))
  }

  /**
   * Append one event.
   *
   * Synchronous on purpose: an event must be on disk before the thing it
   * describes happens, or an interruption loses precisely the event that says
   * what the run was doing. This is the same reasoning as "write at the event,
   * not at the end of it" in the runtime ledger.
   *
   * `options.surfaceOp` is how an event enters the surface: leave it out (or pass `'append'`) for
   * the ordinary case, and pass a `replace` range to shadow a span. A replacement is **validated
   * here**, before anything is written, because a log that carries a rewrite the surface cannot
   * fold is a log nothing can read afterwards: the range must be a real span of current positions,
   * a tool result may be rewritten only by a tool result for the same call, and a system prompt
   * sitting at the surface head may be rewritten only by a system message over exactly that node.
   */
  append(
    handle: SessionHandle,
    event: Omit<SessionEvent, 'seq' | 'at'> & { readonly type: string },
    options: { readonly surfaceOp?: SurfaceOp; readonly sourceEventSeqs?: readonly number[] } = {},
  ): SessionEvent {
    /** Before anything is read for the write: taking the lock is what makes the seq below the file's next one. */
    this.claim(handle)
    if (isReplacementOp(options.surfaceOp)) this.assertReplacement(handle, event, options.surfaceOp)
    const seq = this.count(handle)
    const record: SessionEvent = {
      seq,
      at: new Date().toISOString(),
      ...event,
      ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
      ...(options.sourceEventSeqs !== undefined ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
    }
    /**
     * One event, one zstd frame, appended.
     *
     * The frame is the unit of appendability: a compressed file cannot be added to in the middle,
     * and a frame is the smallest thing that can be added at the end. Measured: the prefix's bytes
     * are identical before and after an append, so an earlier event is never rewritten — and a
     * crash that tears the last frame costs that frame alone, because the reader walks frames and
     * stops at the first incomplete one.
     */
    const line = `${JSON.stringify(record)}\n`
    appendFileSync(handle.transcript, this.load(handle).framed ? encodeFrame(line) : Buffer.from(line, 'utf8'))
    this.load(handle).events.push(record)
    /**
     * No event here moves `updated`: DSH dates a row by the latest prompt or steer only (see `message()`), so an answer, a
     * turn boundary or a harness note no longer re-dates it. This used to touch on those three types (R-developer-eight-20).
     */
    // After the write, never before: a listener that saw an event the file does not
    // have would be a second truth, which is the failure this ordering prevents.
    this.onEvent?.(handle, record)
    /** A first prompt waits for a title, and the turn's `model/request` starts it (`./title.ts`); never throws. */
    this.titles.observe(handle, record)
    return record
  }

  /**
   * Take this session's writer lock, or throw {@link SessionOwnedError} while another process holds it.
   *
   * `append` calls it, so a caller only needs it to be refused **before** doing anything else — a route that
   * wants to answer `409` rather than start a turn it cannot record. Taking the lock drops this store's fold of
   * the session: what was read before may be behind the file, because the previous holder could have appended
   * and let go since, and a write counted from a stale fold is exactly the duplicate seq this lock exists to
   * prevent. Holding it again is free.
   *
   * Taking it **fresh** is DSH's write-open, so a turn the previous writer left unfinished is closed here, before the
   * write that asked for the lock (`./repair.ts`, issue #5). A turn running in this process holds the lock already and
   * never reaches this line.
   */
  claim(handle: SessionHandle): void {
    if (this.held.has(handle.id)) return
    const path = lockPath(handle)
    const fresh = acquireWriterLock(path, handle.id)
    this.held.set(handle.id, path)
    this.loaded.delete(handle.id)
    this.surfaceCache.delete(handle.id)
    if (fresh) this.record(handle, interruptedTurnClosers(this.read(handle)))
  }

  /**
   * Append events whose seq and time are already assigned, in one write, and without the side effects of `append`:
   * no listener hears them and the meta's age does not move. The turn closers are the one caller — a repair of what the
   * log already holds, not activity — and DSH seeds them into a resumed session rather than publishing them.
   */
  private record(handle: SessionHandle, records: readonly SessionEvent[]): void {
    if (records.length === 0) return
    const entry = this.load(handle)
    const lines = records.map((record) => `${JSON.stringify(record)}\n`)
    appendFileSync(handle.transcript, entry.framed ? Buffer.concat(lines.map(encodeFrame)) : Buffer.from(lines.join(''), 'utf8'))
    entry.events.push(...records)
  }

  /** Whether this store holds the session's writer lock. */
  holds(handle: SessionHandle): boolean {
    return this.held.has(handle.id)
  }

  /**
   * Whether a live writer holds the session: this process (through any store), or the live process its lock names.
   *
   * A reader asks it before it shows a session's unfinished turn as closed (`SessionService.events`): a turn whose
   * writer is alive may still be running, and one whose writer is gone never will. A lock naming this process that
   * this process does not hold is a previous process's that had the same pid.
   */
  writerHeld(handle: SessionHandle): boolean {
    const path = lockPath(handle)
    if (heldByProcess.has(path)) return true
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return false
    }
    const holder = lockHolder(text)
    return holder !== undefined && holder !== process.pid && processAlive(holder)
  }

  /**
   * Let go of the session's writer lock, so another process may write it.
   *
   * Nothing has to call this: the process lets go of every lock it holds when it exits, and a lock whose holder
   * died is taken over by the next writer. A later append takes the lock again.
   */
  release(handle: SessionHandle): void {
    const path = this.held.get(handle.id)
    if (path === undefined) return
    this.held.delete(handle.id)
    releaseWriterLock(path)
  }

  /** Take the writer lock if no other process holds it; false when one does. */
  private tryClaim(handle: SessionHandle): boolean {
    try {
      this.claim(handle)
      return true
    } catch (error) {
      if (error instanceof SessionOwnedError) return false
      throw error
    }
  }

  /** The transcript's bytes and their decoding; a file not written yet is an empty session, not an error. */
  private readLog(handle: SessionHandle): { bytes: Buffer; decoded: ReturnType<typeof decodeTranscript> } {
    let bytes = Buffer.alloc(0)
    try {
      bytes = readFileSync(handle.transcript)
    } catch {
      // a session whose file has not been written yet is an empty session, not an error
    }
    return { bytes, decoded: decodeTranscript(bytes) }
  }

  /**
   * The session's events, read once and kept in memory.
   *
   * A transcript is compressed per frame, and a process that holds a session should pay for that
   * once: every `read`, `count`, measure and derivation after the first load is served from here.
   * The format is decided by what the file says and what it is called, so a session born before
   * frames existed keeps being appended to as plain JSONL rather than being rewritten.
   */
  private load(handle: SessionHandle): { events: SessionEvent[]; framed: boolean } {
    const cached = this.loaded.get(handle.id)
    if (cached !== undefined) return cached as { events: SessionEvent[]; framed: boolean }

    let { bytes, decoded } = this.readLog(handle)
    const torn = bytes.length - decoded.readableBytes > 0

    /**
     * A torn tail is cut off before anything is appended.
     *
     * Without this, one interruption makes a session permanently unreadable: a frame torn in half
     * stops the walk, so every event written *after* it — including the next turn's — would sit in
     * the file and never be read. Measured: a torn file plus one appended frame read back as one
     * event rather than two, with the new event silently gone. What is dropped is a frame that was
     * never written whole, so no event that existed as an event is lost, and the repair is recorded
     * on the session rather than done silently.
     *
     * Only the session's writer cuts. A half frame at the end of a session another process holds may
     * be that process's append in progress, so a reader that cannot take the lock reads the whole
     * frames and leaves the file alone; one that can re-reads under the lock before it cuts, because
     * the frame may have been finished by the holder it just replaced.
     */
    let dropped = 0
    if (torn && this.tryClaim(handle)) {
      ;({ bytes, decoded } = this.readLog(handle))
      dropped = bytes.length - decoded.readableBytes
      if (dropped > 0) {
        try {
          truncateSync(handle.transcript, decoded.readableBytes)
        } catch {
          // a transcript that cannot be truncated still reads; the next append simply lands after the tear
        }
      }
    }

    const events: SessionEvent[] = []
    for (const [index, line] of decoded.lines.entries()) {
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch (error) {
        throw new Error(`${handle.transcript}:${index + 1} is not valid JSON — ${(error as Error).message}`)
      }
    }
    const framed = decoded.format === 'zstd-frames' || ((torn || decoded.lines.length === 0) && isFramed(handle.transcript))
    const entry = { events, framed }
    this.loaded.set(handle.id, entry)
    if (dropped > 0) this.append(handle, { type: 'transcript/repaired', droppedBytes: dropped })
    return entry
  }

  /**
   * Reject a replacement the surface could not fold or that would erase something it must not.
   *
   * Every rule here is one DSH enforces on its own session, and each exists because the failure it
   * prevents is silent: a range that is not a span would shadow a hole, a tool result rewritten by
   * something else would leave the model a tool answer for no call, and a rewritten system head
   * would replace the prompt with a user's sentence.
   */
  private assertReplacement(
    handle: SessionHandle,
    event: Omit<SessionEvent, 'seq' | 'at'> & { readonly type: string },
    op: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number },
  ): void {
    if (!isSurfaceEligible(event.type)) {
      throw new Error(`session ${handle.id}: "${event.type}" is not surface-eligible and cannot replace a range`)
    }
    const state = this.surface(handle)
    const startIdx = state.nodes.indexOf(op.startSeq)
    const endIdx = state.nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx < startIdx) {
      throw new Error(`session ${handle.id}: replacement range ${op.startSeq}..${op.endSeq} is not a span of the surface`)
    }
    const shadowedSeqs = state.nodes.slice(startIdx, endIdx + 1)
    /**
     * The span is **positional**, and its seqs need not be ordered.
     *
     * This is the trap this validation used to fall into. A replacement is written later than what
     * it shadows, so it carries a high seq while sitting at an older position — and any span that
     * contains it therefore holds a seq *below* `startSeq`. Checking the seqs form a numeric
     * interval read that as "a node would be left inside the span" and refused it, which made
     * **every second compaction of a session** fail: measured, `shadowedSeqs: [5, 2, 9]` with
     * `fromSeq: 5, throughSeq: 9` is an ordinary span after one replacement, and DSH documents the
     * same shape (`start` may be greater than `end`). Taking the positions between the two
     * endpoints *is* the validation; there is no hole to check for, because the slice defines the
     * span rather than assuming it.
     */
    const events = this.read(handle)
    const replacement = isSurfaceEligible(event.type) ? (event.message as Message | undefined) : undefined
    const head = shadowedSeqs[0]
    const headMessage = head === undefined ? null : deriveNodeMessage(events, head)
    if (startIdx === 0 && headMessage?.role === 'system') {
      if (replacement?.role !== 'system' || shadowedSeqs.length !== 1) {
        throw new Error(
          `session ${handle.id}: the surface head holds the system prompt and may be rewritten only by a system message over exactly that node`,
        )
      }
    }
    for (const seq of shadowedSeqs) {
      const original = deriveNodeMessage(events, seq)
      if (original?.role !== 'tool') continue
      /**
       * A tool result may only be rewritten by a tool result for the same call — and only over
       * exactly that node.
       *
       * The rule is one-directional, as DSH's is: what it forbids is a *tool* replacement that
       * lands on anything but the one result it answers. A compaction may still shadow a span that
       * contains tool results, because that replacement is a user message and shadows a whole
       * balanced region rather than pretending to be the call's answer.
       */
      if (replacement?.role !== 'tool') continue
      if (shadowedSeqs.length !== 1 || replacement.toolCallId !== original.toolCallId) {
        throw new Error(
          `session ${handle.id}: a tool result may be rewritten only by a tool result for the same call, over exactly that node`,
        )
      }
    }
  }

  /** How many events a session holds, which is also the next event's `seq`. */
  count(handle: SessionHandle): number {
    return this.load(handle).events.length
  }

  /**
   * Every event, parsed, in order.
   *
   * Served from the fold — the array is the store's own and a caller must not mutate it — and a line
   * that cannot be parsed fails the load naming its position rather than being skipped.
   */
  read(handle: SessionHandle): readonly SessionEvent[] {
    return this.load(handle).events
  }

  /** Whether this session's transcript is stored as frames, for a caller that wants to say so. */
  framed(handle: SessionHandle): boolean {
    return this.load(handle).framed
  }

  /** A session's bytes on disk, for a caller that wants to report the size or hash a prefix. */
  bytes(handle: SessionHandle): Buffer {
    try {
      return readFileSync(handle.transcript)
    } catch {
      return Buffer.alloc(0)
    }
  }

  /** The surface, folded from the log and cached until the log grows. */
  surface(handle: SessionHandle): SurfaceState {
    const count = this.count(handle)
    const cached = this.surfaceCache.get(handle.id)
    if (cached !== undefined && cached.count === count) return cached.state
    const state = foldSurface(this.read(handle))
    this.surfaceCache.set(handle.id, { count, state })
    return state
  }

  /** One node's message, or null when the node produces none. */
  deriveNode(handle: SessionHandle, seq: number): Message | null {
    return deriveNodeMessage(this.read(handle), seq)
  }

  /**
   * The messages a request carries: every surface node, derived in order.
   *
   * This is the whole point of the surface, seen from a caller's seat — a compaction or a pruning
   * shows up here and nowhere else, while `read()` still returns everything that ever happened.
   */
  deriveMessages(handle: SessionHandle): readonly RecordedMessage[] {
    const events = this.read(handle)
    const bySeq = indexBySeq(events)
    const messages: RecordedMessage[] = []
    for (const seq of this.surface(handle).nodes) {
      const message = deriveMessage(bySeq, seq)
      if (message !== null) messages.push(message)
    }
    return messages
  }

  /** Record a message and keep the metadata's turn count and prompt time honest. */
  message(handle: SessionHandle, message: RecordedMessage): SessionEvent {
    const event = this.append(handle, { type: 'message', message })
    /**
     * A user message is a turn; one a **person** wrote — a prompt or a steer, which is a user message with no `source` —
     * also dates the row, with the event's own time, as DSH's `lastPromptAt` takes `event.time` from a `user/message`
     * whose source is the user (dsh-api-session-controller/lib/index.js:1872-1879). One write for both facts.
     */
    if (message.role === 'user') {
      this.touch(handle, { bumpTurns: true, ...(message.source === undefined ? { promptedAt: event.at } : {}) })
    }
    return event
  }

  /**
   * Record the assistant's answer from the chunk stream.
   *
   * One event per chunk rather than one per answer, for the same reason the
   * ledger is written at the event: a killed run should read as a partial answer,
   * not as no answer. The `assistant/completed` event that follows is what says
   * the answer finished.
   */
  assistantChunk(handle: SessionHandle, chunk: Chunk): void {
    /**
     * A tool call's fragments are **published, never recorded**.
     *
     * They exist so a live reader can show a call being written; the complete call follows as one `tool-call`
     * chunk, and that is the record. Writing the fragments too would put hundreds of events per call into the log
     * — measured, 793 for one `write_file` — and every history projection (the transcript, the trajectory, the
     * surface) would have to learn to skip them. DSH draws the same line: a transient frame per chunk, one durable
     * settlement. The event carries `transient: true` and the next real `seq`, so a client can tell it from a
     * record and order it among them, and the log's own sequence never has a hole.
     */
    if (chunk.type === 'tool-call-delta') {
      this.onEvent?.(handle, { seq: this.count(handle), at: new Date().toISOString(), type: 'assistant/chunk', chunk, transient: true })
      return
    }
    this.append(handle, { type: 'assistant/chunk', chunk })
  }

  /**
   * Record which model call produced the answer, before it is made.
   *
   * The context facts ride along — the estimate, the budget, what was pruned and
   * whether a compaction ran — because they are the only place an assembly is visible
   * after the fact, and a budget nobody can see is a budget nobody can check.
   */
  modelRequest(
    handle: SessionHandle,
    request: {
      readonly endpoint: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly messages: number
      readonly tools: readonly string[]
      readonly estimatedTokens?: number
      readonly thresholdTokens?: number
      readonly pruned?: number
      readonly compacted?: boolean
      /** The request's meter sections: system prompts, tool schemas, and every other message. */
      readonly breakdown?: { readonly system?: number; readonly tools?: number; readonly messages?: number }
      /**
       * The surface generation this request was built at.
       *
       * It is what makes a provider's reported usage reusable: a usage number describes one
       * envelope, so it may only anchor a measurement of that same envelope. A later append or
       * replacement moves the generation, and the number stops applying.
       */
      readonly generation?: number
    },
  ): void {
    this.append(handle, { type: 'model/request', ...request })
  }

  /**
   * The messages a resumed session would send.
   *
   * Derived from the surface rather than filtered from the log, so a compaction or a pruning is
   * reflected here: this is the model's view, and `read()` remains the human's.
   */
  messages(handle: SessionHandle): readonly RecordedMessage[] {
    return this.deriveMessages(handle)
  }

  /** The plain text of a session's last assistant answer. */
  lastAnswer(handle: SessionHandle): string {
    const events = this.read(handle)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'assistant/completed') return String(event.text ?? '')
    }
    return ''
  }

  private bumpTurns(handle: SessionHandle): void {
    this.touch(handle, { bumpTurns: true })
  }

  /**
   * Record a person's prompt time (`updated`) and/or count a user turn, in one meta write.
   *
   * The meta is a convenience beside the log: failing to write it must never lose the event that was just appended, which is
   * why the catch swallows. `updated` is what a row's age reads and what **Last updated** sorts by, and `turns` what its
   * tooltip counts. A call with neither writes nothing.
   */
  touch(handle: SessionHandle, options: { readonly bumpTurns?: boolean; readonly addTurns?: number; readonly promptedAt?: string } = {}): void {
    const path = handle.meta
    /**
     * `addTurns` is a fork's seed, which counts every inherited user message in one write and dates nothing: a fork's row
     * is dated by its creation until its own first prompt, as DSH's `max(createdAt, lastPromptAt)` dates it.
     */
    const added = (options.bumpTurns === true ? 1 : 0) + (options.addTurns ?? 0)
    if (added === 0 && options.promptedAt === undefined) return
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as SessionMeta
      const updated: SessionMeta = {
        ...meta,
        ...(options.promptedAt !== undefined ? { updated: options.promptedAt } : {}),
        ...(added > 0 ? { turns: (meta.turns ?? 0) + added } : {}),
      }
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)
    } catch {
      // A session without readable metadata is still a usable session; the count
      // is a convenience and losing it must not lose the turn.
    }
  }
}
