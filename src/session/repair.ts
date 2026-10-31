import type { SessionEvent } from './store.ts'

/**
 * Closers for a turn its writer never finished: DSH's `openTurnClosers` (`@deepseek-ai/dsh-session`
 * lib/types/repair.js:35-78) read against heddle's log.
 *
 * A turn cut by a restart, a crash or a killed command line leaves a log that ends inside the turn: the call the model
 * asked for has no result and the turn has no end, so a view draws the call as running for good (issue #5). DSH balances
 * such a log in two places, and so does heddle:
 *
 * - **When the session is next opened for writing**, before anything else is appended (`dsh-agent-loop`
 *   lib/index.js:1992-1993: `const closers = interruptedTurnClosers(persisted); if (closers.length > 0) await
 *   handle.append(closers)`). Here that is the first time a process takes the session's writer lock
 *   (`SessionStore.claim`), which is DSH's write-open; a turn running in this process already holds the lock, so it is
 *   never closed from under itself.
 * - **When a session no writer holds is read** (`readColdSessionLog`, dsh-session-query lib/index.js:26-52), the same
 *   closers are appended to what the reader gets and nothing is written (`SessionService.events`). The two agree event
 *   for event, so a view does not change when the session is later written.
 *
 * The closers are heddle's own vocabulary for what DSH writes as `tool/result`, `step/end` and `turn/end`:
 *
 * 1. one tool `message` per call the turn left unanswered, in call order — the shape the loop commits a result in;
 * 2. `assistant/completed`, the turn's answer record, with the text and reasoning the turn streamed and an `ended`
 *    reason, which is how a turn stopped early already says so;
 * 3. `turn/completed`, carrying DSH's cause as `reason: { kind }` beside the rounds the turn ran.
 *
 * Sequences continue the log and every closer reuses the last real event's time, as DSH's do: a repair is not activity,
 * and a deterministic closer is what lets the read and the write produce the same events.
 *
 * **The result's words are heddle's request-time repair's** (`repairToolPairing`, src/context/pairing.ts), not DSH's
 * `ToolCallRecovery` text, for three reasons. The model has already been answered in those words for such a call, so the
 * request is the same before and after the log is repaired. The views draw a result as an error only when it begins with
 * `error` (`transcriptTurns` in src/server/web.ts, `is_error` in heddle-server transcript.rs), and DSH's sentence does
 * not. And DSH's two texts tell a call that was recorded as started from one that was not; heddle records no call start,
 * so that distinction has nothing to rest on. The code, `INTERRUPTED`, is DSH's.
 *
 * The Rust twin is heddle-session `repair.rs`, written to the same bytes.
 */

/**
 * Why a turn is being closed, which picks the words. DSH has `interrupted` (a crashed writer) and `forked` (a fork seed
 * cut inside a turn, `buildForkSeed`, dsh-session lib/types/fork.js:26); heddle closes the first here, and a fork seed
 * adds its own kind to this union and to {@link CLOSER_TEXT}.
 */
export interface CloserCause {
  readonly kind: 'interrupted'
}

/** A crashed or killed writer's turn: DSH's `interruptedTurnClosers` cause. */
export const INTERRUPTED: CloserCause = { kind: 'interrupted' }

/** What a closer says, by cause: the answer to an open call, and the reason the turn's record gives. */
const CLOSER_TEXT: Readonly<Record<CloserCause['kind'], { readonly result: string; readonly ended: string }>> = {
  interrupted: {
    result: 'error (INTERRUPTED): the turn ended before this call answered',
    ended: 'the process exited before this turn finished, so the turn was closed; unfinished tool calls have unknown outcomes',
  },
}

/** The events that end a turn in heddle's log: the loop's own end, and a teammate's failed turn. */
const TURN_ENDS: ReadonlySet<string> = new Set(['turn/completed', 'turn/failed'])

/** The plain text of a message's parts. */
function textOf(message: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }): string {
  return (message.content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
}

/**
 * The closers an open tail turn needs, in order; empty when the log's last turn has ended or never began.
 *
 * heddle writes no turn-start event, so a turn is known to have begun at its first `model/request` or streamed
 * `assistant/chunk` after the last turn end — the same markers the goal driver reads a turn in flight from
 * (src/plugins/goal-driver.ts). A prompt with no model call after it is therefore not closed: nothing of it is drawn as
 * running, and the fork already leaves such a prompt out of what it inherits. A call is open from its `tool-call` chunk
 * until a tool message names it; a turn end forgets the calls it leaves, as DSH's recovery does at its boundaries, so an
 * old turn is never reopened (the request-time repair answers its calls for the model).
 *
 * @param events - the log as the store holds it, possibly ending inside a turn.
 * @param cause - why the turn is being closed: selects the words and the turn's `reason`.
 * @returns the events to append after `events`, with their seqs and times assigned.
 */
export function openTurnClosers(events: readonly SessionEvent[], cause: CloserCause): SessionEvent[] {
  let open = false
  /** Unanswered call ids in the order the model asked for them; a Map keeps insertion order across deletes. */
  let pending = new Map<string, true>()
  let text = ''
  let reasoning = ''
  let finishReason: string | undefined
  let requests = 0
  let retries = 0
  let errors = 0
  for (const event of events) {
    if (TURN_ENDS.has(event.type)) {
      open = false
      pending = new Map()
      text = ''
      reasoning = ''
      finishReason = undefined
      requests = 0
      retries = 0
      errors = 0
      continue
    }
    switch (event.type) {
      case 'model/request':
        open = true
        requests += 1
        break
      case 'turn/retry':
        retries += 1
        break
      case 'assistant/chunk': {
        if (event.transient === true) break
        open = true
        const chunk = event.chunk as { type?: string; text?: string; id?: string; finishReason?: string } | undefined
        if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk?.type === 'reasoning-delta') reasoning += chunk.text ?? ''
        else if (chunk?.type === 'tool-call' && typeof chunk.id === 'string') pending.set(chunk.id, true)
        else if (chunk?.type === 'done' && typeof chunk.finishReason === 'string') finishReason = chunk.finishReason
        break
      }
      case 'message': {
        const message = event.message as { role?: string; toolCallId?: unknown; content?: readonly { type?: string; text?: string }[] } | undefined
        if (message?.role !== 'tool') break
        if (typeof message.toolCallId === 'string') pending.delete(message.toolCallId)
        if (/^error \(/.test(textOf(message))) errors += 1
        break
      }
      default:
        break
    }
  }
  const last = events.at(-1)
  if (!open || last === undefined) return []

  const words = CLOSER_TEXT[cause.kind]
  const at = last.at
  let seq = events.length
  const rounds = Math.max(0, requests - retries)
  const closers: SessionEvent[] = []
  for (const toolCallId of pending.keys()) {
    closers.push({
      seq: seq++,
      at,
      type: 'message',
      message: { role: 'tool', toolCallId, content: [{ type: 'text', text: words.result }] },
    })
  }
  closers.push({
    seq: seq++,
    at,
    type: 'assistant/completed',
    text,
    reasoning,
    ...(finishReason !== undefined ? { finishReason } : {}),
    rounds,
    denials: errors + pending.size,
    ended: [words.ended],
  })
  closers.push({ seq: seq++, at, type: 'turn/completed', rounds, reason: { kind: cause.kind } })
  return closers
}

/** The crash-recovery entry point: {@link openTurnClosers} with the `interrupted` cause, DSH's `interruptedTurnClosers`. */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  return openTurnClosers(events, INTERRUPTED)
}
