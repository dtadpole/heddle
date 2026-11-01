import { readFileSync } from 'node:fs'

import type { GenerateRequest } from '../llm/types.ts'
import type { SessionEvent, SessionHandle } from './store.ts'

/**
 * A session's **automatic title**, the way DSH makes one (R-developer-eight-12, parity row C6).
 *
 * DSH mounts `dsh-session-title` with the first-prompt model provider (`dsh-session-title-first-prompt-llm`) in its base
 * profile (`dsh-base/cordis.patch.yml:60-77`). The service writes a deterministic fallback from the first eligible human
 * message at once; the provider then asks the session's own route for a title, without delaying the turn, and the
 * answer replaces the fallback. Heddle already had the fallback (`titleFrom`, which fills a blank title from the first
 * message); this module is the provider half, read from DSH's code:
 *
 * - **When**: on the session's first eligible human message — a `user` message written by a person (no `source`), with
 *   visible text — in a session that has no title and no parent (`dsh-session-title` `onUserMessage`, lib/index.js:380-404:
 *   `parentSession === undefined && count === 1 && get(session) === undefined`). The call starts only once the turn's
 *   own request is on record, with that request's endpoint and model (`onRequestHeader`, :406-416) — here the
 *   `model/request` event the loop writes before each model call. DSH titles nothing when a session is created, so
 *   every path that opens a session for a turn — a blank row, the turn route, the CLI's `--turn` — opens it untitled
 *   (#68: the turn route and the CLI used to name it with the prompt cut to 60 characters, which read as a person's
 *   name, so no call ever started). A title given at creation (`session new --title`, a definition) is a person's.
 * - **What it sends**: the first-prompt provider's system prompt and its JSON framing of the one message
 *   (`dsh-session-title-first-prompt-llm` lib/index.js:44-56), at most `maxInputBytes` of input, `maxOutputTokens` of
 *   output, `timeoutMs` end to end, tagged `purpose: 'session-title'` (`dsh-session-title-llm` lib/index.js:160-220).
 * - **How it is cleaned**: the first non-empty line of the answer, without emphasis that wraps the whole line, with
 *   terminal controls and invisible characters removed and whitespace collapsed (`titleFromOutput`, first-prompt :67-73;
 *   `normalizeSessionTitle`, `dsh-session-title` :19-58), then cut to `maxTitleBytes` UTF-8 bytes on a code point.
 *   Only a `stop` finish with text and no tool call is accepted (first-prompt :75-87).
 * - **What stops it**: a person's rename. DSH's `rename()` supersedes in-flight generation (:295-311) and a user-sourced
 *   title schedules none (:383); here `SessionService.rename` calls {@link SessionTitles.supersede}, which drops the
 *   pending call and makes an answer still in flight land nowhere — including the C5 case, where confirming the
 *   automatic title unchanged makes it the person's own.
 * - **On failure**: the answer is dropped and the fallback stays (`startPending`, :433-445: "automatic title generation
 *   failed", the latest title retained). Nothing is retried; a later message does not try again.
 *
 * Two differences are kept on purpose. The title lives where heddle keeps it — the meta record's `title`, written by the
 * store's own `rename` so both builds write the same bytes — rather than in a `session/title` log event, and the request
 * is not logged as DSH's `session/title-llm-request`; heddle's log stays the turn's record. And the fallback is heddle's
 * existing `titleFrom` (48 characters at a word) rather than DSH's five words in 40 bytes, which other checks assert.
 */

/** DSH's shipped limits for the first-prompt title, verbatim from `dsh-base/cordis.patch.yml:60-77`. */
export const SESSION_TITLE_LIMITS = Object.freeze({
  /** `session-title.maxTitleBytes`: the most UTF-8 bytes any accepted title may hold. */
  maxTitleBytes: 80,
  /** `session-title-llm.targetWords`. */
  targetWords: 5,
  /** `session-title-llm.targetCjkCharacters`. */
  targetCjkCharacters: 10,
  /** `session-title-llm.maxInputBytes`: a longer framed input is not sent. */
  maxInputBytes: 4096,
  /** `session-title-llm.maxOutputTokens`: a ceiling against runaway output, not a length target. */
  maxOutputTokens: 4096,
  /** `session-title-llm.timeoutMs`: the call's end-to-end deadline. */
  timeoutMs: 60_000,
})

/** The purpose the title call carries, as DSH's does (`purpose: "session-title"`); a scripted step answers it by this tag. */
export const SESSION_TITLE_PURPOSE = 'session-title'

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** DSH's `cleanTitleText`: controls removed, one trimmed line with whitespace runs collapsed. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The longest leading code-point prefix of `input` within `maxBytes` UTF-8 bytes (DSH's `truncateTitleUtf8`). */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/** DSH's `normalizeSessionTitle`: a terminal-safe one-line title within `maxBytes`, possibly empty. */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/** The first-prompt provider's system instruction (`systemPrompt`, first-prompt lib/index.js:44-52), with DSH's targets. */
export function sessionTitleSystemPrompt(): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${SESSION_TITLE_LIMITS.targetWords} words in non-CJK languages or ${SESSION_TITLE_LIMITS.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n')
}

/** The one message, framed as JSON so its text cannot break the structure (`frameMessages`, first-prompt :54-56). */
export function sessionTitleInput(message: { readonly seq: number; readonly text: string }): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: message.seq, text: message.text }])}`
}

/** Asterisk emphasis wrapping a whole line, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/** DSH's `titleFromOutput`: the first non-empty line, without asterisk emphasis that wraps that whole line. */
export function titleFromOutput(text: string): string {
  const line = text.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.['marker']
  const inner = groups?.['inner']
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

/** What a model call answered, as the model service's `generate` collects it. */
export interface TitleAnswer {
  readonly text: string
  readonly finishReason: string
  readonly toolCalls: readonly unknown[]
}

/**
 * The accepted title from one answer, or a thrown reason (DSH's `titleFromResponse` then `validateResult`): only a
 * finished text answer counts, and the cleaned title must keep a visible character within `maxTitleBytes`.
 */
export function titleFromAnswer(answer: TitleAnswer): string {
  if (answer.finishReason !== 'stop') {
    throw new Error(
      answer.finishReason === 'tool_calls'
        ? 'session-title-llm: title output must contain text only'
        : `session-title-llm: title output ended with ${answer.finishReason}`,
    )
  }
  if (answer.toolCalls.length > 0) throw new Error('session-title-llm: title output must contain text only')
  const title = normalizeSessionTitle(titleFromOutput(answer.text), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  const accepted = normalizeSessionTitle(title, SESSION_TITLE_LIMITS.maxTitleBytes)
  if (accepted.length === 0) throw new Error('session-title provider returned an empty title')
  return accepted
}

/**
 * The text a recorded message offers a title, or `undefined` when it offers none (DSH's `sessionTitleUserMessageOf`):
 * a `user` message a person wrote — no `source`, which is how heddle marks a goal round, a teammate's mail or a notice —
 * whose text parts, joined by line breaks, keep a visible character.
 */
export function titleTextOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const recorded = message as { readonly role?: unknown; readonly source?: unknown; readonly content?: unknown }
  if (recorded.role !== 'user' || recorded.source !== undefined || !Array.isArray(recorded.content)) return undefined
  const text = recorded.content
    .filter((part): part is { type: 'text'; text: string } => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  return normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0 ? undefined : text
}

/** One title call: the request the model service is asked, and the signal that abandons it. */
export type TitleGenerate = (request: GenerateRequest, signal: AbortSignal) => Promise<TitleAnswer>

/** What the coordinator needs from the store it belongs to. */
export interface TitleStore {
  read(handle: SessionHandle): readonly SessionEvent[]
  rename(id: string, title: string): unknown
}

/** A session's meta record as the title rules read it: straight from its file, so another session cannot answer. */
function metaOf(handle: SessionHandle): { readonly title?: unknown; readonly parentSession?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(handle.meta, 'utf8'))
    return typeof value === 'object' && value !== null ? (value as { title?: unknown; parentSession?: unknown }) : undefined
  } catch {
    return undefined
  }
}

const titleOf = (meta: { readonly title?: unknown } | undefined): string => (typeof meta?.title === 'string' ? meta.title : '')

interface Pending {
  readonly revision: number
  readonly seq: number
  readonly text: string
}

interface WorkState {
  revision: number
  pending?: Pending
  active?: AbortController
}

/**
 * The scheduling half of DSH's `SessionTitleService`, for one store: which session waits for a title, which call is in
 * flight, and whether its answer may still land.
 *
 * It does nothing until a model is attached ({@link SessionTitles.attach}), so a store a test builds on its own — or a
 * profile with no model — keeps heddle's plain first-message name. The store hands it every event it appends; a rename
 * from a person supersedes; disposal abandons every call.
 */
export class SessionTitles {
  readonly #store: TitleStore
  #generate: TitleGenerate | undefined
  #log: ((message: string) => void) | undefined
  readonly #work = new Map<string, WorkState>()
  readonly #inFlight = new Set<Promise<void>>()

  constructor(store: TitleStore) {
    this.#store = store
  }

  /**
   * Give the coordinator its model call, and say where a failure is reported. Answers the detacher, which also
   * abandons whatever was pending or in flight.
   */
  attach(generate: TitleGenerate, options: { readonly log?: (message: string) => void } = {}): () => void {
    this.#generate = generate
    this.#log = options.log
    return () => {
      if (this.#generate !== generate) return
      this.#generate = undefined
      this.dispose()
    }
  }

  /** Whether a model is attached, which is whether a first prompt can earn a generated title. */
  get attached(): boolean {
    return this.#generate !== undefined
  }

  /**
   * One appended event. A first eligible message marks its session as waiting; the next `model/request` of that session
   * starts the call on that request's endpoint and model. Never throws: a title must not cost a turn its write.
   */
  observe(handle: SessionHandle, event: SessionEvent): void {
    if (this.#generate === undefined) return
    try {
      if (event.type === 'message') this.#onMessage(handle, event)
      else if (event.type === 'model/request') this.#onModelRequest(handle, event)
    } catch (error) {
      this.#log?.(`session "${handle.id}": automatic title scheduling failed: ${String(error)}`)
    }
  }

  /** A person named the session: nothing pending starts, and an answer already in flight lands nowhere. */
  supersede(id: string): void {
    const state = this.#work.get(id)
    if (state === undefined) return
    this.#bump(state, 'a rename superseded automatic title generation')
  }

  /** Abandon every pending and running call (the store's owner is going away). */
  dispose(): void {
    for (const state of this.#work.values()) this.#bump(state, 'session-title disposed')
    this.#work.clear()
  }

  /** Resolve once no title call is running — for a check that has to read the outcome. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])
  }

  #bump(state: WorkState, reason: string): void {
    state.active?.abort(new Error(reason))
    delete state.active
    delete state.pending
    state.revision += 1
  }

  #onMessage(handle: SessionHandle, event: SessionEvent): void {
    const text = titleTextOf(event.message)
    if (text === undefined) return
    const meta = metaOf(handle)
    if (meta === undefined || titleOf(meta).trim().length > 0 || meta.parentSession !== undefined) return
    const eligible = this.#store.read(handle).filter((one) => one.type === 'message' && titleTextOf(one.message) !== undefined).length
    if (eligible !== 1) return
    let state = this.#work.get(handle.id)
    if (state === undefined) {
      state = { revision: 0 }
      this.#work.set(handle.id, state)
    }
    this.#bump(state, 'a newer message superseded title generation')
    state.pending = { revision: state.revision, seq: event.seq, text }
  }

  #onModelRequest(handle: SessionHandle, event: SessionEvent): void {
    const state = this.#work.get(handle.id)
    const pending = state?.pending
    if (state === undefined || pending === undefined || pending.seq >= event.seq) return
    delete state.pending
    const endpoint = typeof event.endpoint === 'string' && event.endpoint.length > 0 ? event.endpoint : undefined
    const generate = this.#generate
    if (endpoint === undefined || generate === undefined) return
    const model = typeof event.model === 'string' && event.model.length > 0 ? event.model : undefined
    const input = sessionTitleInput(pending)
    const inputBytes = Buffer.byteLength(input, 'utf8')
    if (inputBytes > SESSION_TITLE_LIMITS.maxInputBytes) {
      this.#log?.(`session "${handle.id}": automatic title generation failed: session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${SESSION_TITLE_LIMITS.maxInputBytes}`)
      return
    }
    /** What stood when the call began — the fallback the first message wrote; an answer replaces only that. */
    const expected = titleOf(metaOf(handle))
    const controller = new AbortController()
    state.active = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SESSION_TITLE_LIMITS.timeoutMs)])
    const request: GenerateRequest = {
      endpoint,
      ...(model !== undefined ? { model } : {}),
      messages: [
        { role: 'system', content: [{ type: 'text', text: sessionTitleSystemPrompt() }] },
        { role: 'user', content: [{ type: 'text', text: input }] },
      ],
      maxOutputTokens: SESSION_TITLE_LIMITS.maxOutputTokens,
      purpose: SESSION_TITLE_PURPOSE,
      sessionId: handle.id,
    }
    const run = (async () => {
      try {
        const answer = await generate(request, signal)
        signal.throwIfAborted()
        const title = titleFromAnswer(answer)
        if (this.#work.get(handle.id) !== state || state.revision !== pending.revision) return
        if (titleOf(metaOf(handle)) !== expected) return
        this.#store.rename(handle.id, title)
      } catch (error) {
        if (controller.signal.aborted) return
        this.#log?.(`session "${handle.id}": automatic title generation failed: ${String(error)}`)
      } finally {
        if (state.active === controller) delete state.active
      }
    })()
    this.#inFlight.add(run)
    void run.finally(() => this.#inFlight.delete(run))
  }
}
