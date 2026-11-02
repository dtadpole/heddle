import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import {
  foldSurface,
  indexBySeq,
  quietsSurface,
  type SessionEvent,
  type SessionMeta,
  type SessionStore,
  type SurfaceState,
} from './store.ts'
import { decodeTranscript, frameEnd, looksCompressed, readFrames } from './transcript.ts'
import { DIACRITICS, FOLDS, SEPARATORS } from './unicode61.ts'

/**
 * **Content search**: which sessions said a phrase, ranked and quoted the way DSH's sidebar search answers.
 *
 * DSH's `session.search({ query })` (dsh-api-session-controller lib/index.js:2010-2091) asks its `sessionQuery`
 * provider, a SQLite FTS5 index (dsh-session-query-sqlite), for the visible sessions whose **current** `user/message`
 * or `assistant/message` text holds the query as one phrase, and answers at most 20 `{ sessionId, snippet }` rows with
 * `hasMore`. This module gives the same rows in the same order without SQLite, because the Rust build has none and both
 * builds must agree:
 *
 * - **Corpus** (lib/index.js:2016-2048, `MESSAGE_TYPES` :1853; dsh-session-query lib/index.js:545-630): every listed
 *   session with a `cwd`; of its log, the surface nodes that are a person's or the model's message — a `message` event
 *   whose role is `user` or `assistant`, or a streamed answer's chunk run — and never a `context/note`, a tool result or
 *   a shadowed span. A document's text is its text parts and its tool calls' name and arguments, each trimmed and joined
 *   with newlines; reasoning is not text.
 * - **Matching** (dsh-session-query-sqlite lib/index.js:106-115, :287-297, :368-374): FTS5's `unicode61` tokenizer
 *   and one quoted phrase. A token is a run of token characters, case-folded and stripped of a single diacritic; every
 *   other character separates. So `Quökka-Ledger` holds the phrase `quokka ledger`, and `quokkaledger` does not: it is
 *   a token-level phrase, not a substring. The tables are measured from SQLite itself (`unicode61-generate.ts`).
 * - **Ranking** (lib/index.js:818-834, `match_count` :969-975): a session's best document has the most highlighted
 *   phrase groups, then the fewest code points, then the latest time, then the highest seq; sessions are ordered by
 *   those values, then by id.
 * - **Snippet** (`makeSnippet`, lib/index.js:325-367; controller :2072): the document with its whitespace collapsed,
 *   at most 240 code points, its window starting a third of that before the first match.
 *
 * The choice of a **scan rather than an index** is deliberate and measured against heddle's scale: a session log is
 * read again only when its size or modification time changed, and then only from where the last read stopped, since a
 * log is append-only frames; what is kept between queries is the documents' text and tokens, never the whole event
 * log — the store's own fold is not used, so a search does not load every session into it or take any session's
 * writer lock. The cost is a directory walk and a `stat` per session per query, which a 250 ms debounced sidebar
 * search affords. The server's search does that work in slices, so it never holds the event loop for long (#257,
 * {@link SessionSearchIndex}).
 */

/** At most this many sessions in one answer (`SESSION_SEARCH_RESULT_LIMIT`, dsh-api-session-controller lib/client.js:357). */
export const SESSION_SEARCH_RESULT_LIMIT = 20

/** A snippet's bound in code points (`SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS`, lib/client.js:359). */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

/** A query's bound in UTF-16 code units (`SESSION_SEARCH_QUERY_MAX_CHARS`, lib/index.js:1852). */
export const SESSION_SEARCH_QUERY_MAX_CHARS = 500

/** One session that holds the phrase, and where. */
export interface SessionSearchHit {
  readonly sessionId: string
  readonly snippet: string
}

/** DSH's `session.search` answer. */
export interface SessionSearchPage {
  readonly items: readonly SessionSearchHit[]
  readonly hasMore: boolean
}

/** A query DSH refuses as `gateway/bad-request`, with DSH's sentence. */
export class SessionSearchQueryError extends Error {
  readonly code = 'gateway/bad-request'

  constructor(message: string) {
    super(message)
    this.name = 'SessionSearchQueryError'
  }
}

/** The controller's own validation, word for word (`normalizeSearchQuery`, lib/index.js:2117-2123). */
export function normalizeSearchQuery(query: unknown): string {
  const normalized = typeof query === 'string' ? query.trim() : ''
  if (normalized.length === 0) throw new SessionSearchQueryError('session search query must not be empty')
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new SessionSearchQueryError(`session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`)
  }
  if (normalized.includes('\0')) throw new SessionSearchQueryError('session search query must not contain NUL')
  return normalized
}

// ---------------------------------------------------------------------------------------------------------------------
// The tokenizer: FTS5 unicode61, from the measured tables.

const DIACRITIC_SET: ReadonlySet<number> = new Set(DIACRITICS)

/** Whether a code point ends a token. A lone surrogate is U+FFFD by the time SQLite sees it, and that separates. */
function isSeparator(cp: number): boolean {
  const point = cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp
  let low = 0
  let high = SEPARATORS.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = SEPARATORS[middle]!
    if (point < range[0]) high = middle - 1
    else if (point > range[1]) low = middle + 1
    else return true
  }
  return false
}

/** What a token character folds to: lower case, and a letter with one diacritic loses it. */
export function foldCodePoint(cp: number): number {
  let low = 0
  let high = FOLDS.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (FOLDS[middle]![0] <= cp) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  if (found < 0) return cp
  const [start, count, step, kind, value] = FOLDS[found]!
  const offset = cp - start
  if (offset % step !== 0 || offset / step >= count) return cp
  return kind === 0 ? cp + value : value
}

/** One token: its folded text and the code points it spans, `[start, end)`. */
export interface Token {
  readonly text: string
  readonly start: number
  readonly end: number
}

/**
 * Split text, given as code points, the way FTS5's `unicode61` does.
 *
 * A token starts at a token character and runs until a separator. The 25 diacritics continue a token and are dropped
 * from it, but cannot start one — so `e` followed by U+0301 is the token `e`, and U+0301 alone is nothing.
 */
export function tokenize(chars: readonly string[]): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < chars.length) {
    const first = chars[index]!.codePointAt(0)!
    if (isSeparator(first) || DIACRITIC_SET.has(first)) {
      index += 1
      continue
    }
    const start = index
    let text = ''
    while (index < chars.length) {
      const cp = chars[index]!.codePointAt(0)!
      if (DIACRITIC_SET.has(cp)) {
        index += 1
        continue
      }
      if (isSeparator(cp)) break
      text += String.fromCodePoint(foldCodePoint(cp))
      index += 1
    }
    tokens.push({ text, start, end: index })
  }
  return tokens
}

// ---------------------------------------------------------------------------------------------------------------------
// The corpus: a session's current user and assistant messages.

/** One searchable message: DSH's semantic document for a `user/message` or `assistant/message` on the current surface. */
export interface SearchDocument {
  readonly seq: number
  readonly type: 'user/message' | 'assistant/message'
  /** The event's `at`; both builds write it as `toISOString` does, so ordering the text orders the time. */
  readonly time: string
  readonly text: string
}

/** `joinText` (dsh-session-query lib/index.js:586-588): trimmed, empty parts dropped, joined with newlines. */
function joinText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n')
}

/**
 * The reserved highlight markers and NUL become U+FFFD before text is indexed (`sanitizeFtsText`, lib/index.js:295-297),
 * and a lone surrogate becomes U+FFFD on its way into SQLite, so a snippet shows what DSH's would.
 */
function sanitize(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD').replace(/[\0\uFDD0\uFDD1]/g, '\uFFFD')
}

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function stringField(value: unknown, key: string): string {
  const field = (value as Record<string, unknown> | null | undefined)?.[key]
  return typeof field === 'string' ? field : ''
}

/** A message's text parts and its tool calls' name and arguments, in order (`blockText`, lib/index.js:578-585). */
function messageParts(message: unknown): string[] {
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const part of content) {
    const type = stringField(part, 'type')
    if (type === 'text') parts.push(stringField(part, 'text'))
    else if (type === 'tool-call') parts.push(stringField(part, 'name'), stringField(part, 'arguments'))
  }
  return parts
}

/**
 * A streamed answer's parts, settled the way DSH settles a stream into one `assistant/message`: consecutive text
 * deltas are one text block, a reasoning delta or a tool call ends it, and a tool call adds its name and arguments.
 * The time is the run's last chunk — DSH writes its message when the stream settles.
 */
function chunkRun(bySeq: ReadonlyMap<number, SessionEvent>, seq: number): { parts: string[]; time: string } {
  const parts: string[] = []
  let open: string | undefined
  let time = ''
  for (let index = seq; ; index += 1) {
    const event = bySeq.get(index)
    if (event === undefined || event.type !== 'assistant/chunk') break
    time = typeof event.at === 'string' ? event.at : ''
    const chunk = event.chunk
    const type = stringField(chunk, 'type')
    if (type === 'text-delta') {
      open = (open ?? '') + stringField(chunk, 'text')
      continue
    }
    if (type === 'reasoning-delta' || type === 'tool-call' || type === 'done') {
      if (open !== undefined) parts.push(open)
      open = undefined
    }
    if (type === 'tool-call') parts.push(stringField(chunk, 'name'), stringField(chunk, 'arguments'))
    if (type === 'done') break
  }
  if (open !== undefined) parts.push(open)
  return { parts, time }
}

/**
 * The searchable documents of one log, in surface order.
 *
 * A log whose surface cannot be folded contributes nothing: it is unreadable to every view, and a search that threw on
 * it would hide every other session's answer.
 */
export function searchDocuments(events: readonly SessionEvent[]): SearchDocument[] {
  let nodes: readonly number[]
  try {
    nodes = foldSurface(events).nodes
  } catch {
    return []
  }
  const bySeq = indexBySeq(events)
  const documents: SearchDocument[] = []
  for (const seq of nodes) {
    const document = documentAt(bySeq, seq)
    if (document !== null) documents.push(document)
  }
  return documents
}

/**
 * The document one surface node is, or null when it is none: a `message` whose role is `user` or `assistant`, or a
 * streamed answer's chunk run, with some text. It reads the node's event and, for a run, the chunks that follow it.
 */
function documentAt(bySeq: ReadonlyMap<number, SessionEvent>, seq: number): SearchDocument | null {
  const event = bySeq.get(seq)
  if (event === undefined) return null
  let type: SearchDocument['type']
  let parts: string[]
  let time: string
  if (event.type === 'message') {
    const role = stringField(event.message, 'role')
    if (role !== 'user' && role !== 'assistant') return null
    type = role === 'user' ? 'user/message' : 'assistant/message'
    parts = messageParts(event.message)
    time = typeof event.at === 'string' ? event.at : ''
  } else if (event.type === 'assistant/chunk') {
    type = 'assistant/message'
    ;({ parts, time } = chunkRun(bySeq, seq))
  } else return null
  const text = joinText(parts)
  if (text.length === 0) return null
  return { seq, type, time, text: sanitize(text) }
}

/** A document split once, so a query only compares tokens. */
export interface PreparedDocument extends SearchDocument {
  readonly chars: readonly string[]
  readonly tokens: readonly Token[]
}

export function prepareDocument(document: SearchDocument): PreparedDocument {
  const chars = Array.from(document.text)
  return { ...document, chars, tokens: tokenize(chars) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching, the snippet and the order.

const OPEN = '\uFDD0'
const CLOSE = '\uFDD1'

/**
 * The phrase's occurrences in a document, marked as FTS5's `highlight()` marks them, or `null` when it has none.
 *
 * Overlapping occurrences share one mark and adjacent ones do not (FTS5's `fts5CInstIterNext`), and `matchCount` — the
 * first ranking key — is the number of marks, which is how DSH counts it (lib/index.js:969-975).
 */
export function markPhrase(document: PreparedDocument, phrase: readonly string[]): { matchCount: number; marked: string } | null {
  const groups = phraseGroups(document, phrase)
  return groups.length === 0 ? null : { matchCount: groups.length, marked: markGroups(document, groups) }
}

/** The marks {@link markPhrase} makes, as token ranges `[first, last]`; none for an empty phrase. */
function phraseGroups(document: PreparedDocument, phrase: readonly string[]): [number, number][] {
  const size = phrase.length
  const groups: [number, number][] = []
  if (size === 0) return groups
  const { tokens } = document
  for (let index = 0; index + size <= tokens.length; index += 1) {
    let equal = true
    for (let offset = 0; offset < size; offset += 1) {
      if (tokens[index + offset]!.text !== phrase[offset]) {
        equal = false
        break
      }
    }
    if (!equal) continue
    const last = groups[groups.length - 1]
    if (last !== undefined && index <= last[1]) last[1] = index + size - 1
    else groups.push([index, index + size - 1])
  }
  return groups
}

/** The document's text with each mark of `groups` wrapped in the highlight markers. */
function markGroups(document: PreparedDocument, groups: readonly (readonly [number, number])[]): string {
  const { tokens, chars } = document
  const pieces: string[] = []
  let cursor = 0
  for (const [first, last] of groups) {
    const start = tokens[first]!.start
    const end = tokens[last]!.end
    pieces.push(chars.slice(cursor, start).join(''), OPEN, chars.slice(start, end).join(''), CLOSE)
    cursor = end
  }
  pieces.push(chars.slice(cursor).join(''))
  return pieces.join('')
}

/** `normalizeMarkedText` (lib/index.js:349-367): whitespace collapsed, markers removed, where the first match starts. */
function normalizeMarkedText(markedText: string): { text: string; matchStart: number } {
  const characters: string[] = []
  let matchStart: number | undefined
  for (const character of markedText) {
    if (character === OPEN) {
      matchStart ??= characters.length
      continue
    }
    if (character === CLOSE) continue
    if (/\s/u.test(character)) {
      if (characters.length > 0 && characters.at(-1) !== ' ') characters.push(' ')
    } else characters.push(character)
  }
  if (characters.at(-1) === ' ') characters.pop()
  return { text: characters.join(''), matchStart: matchStart ?? 0 }
}

/** `makeSnippet` (lib/index.js:325-348), line for line. */
export function makeSnippet(markedText: string, maxChars: number): string {
  const { text: clean, matchStart } = normalizeMarkedText(markedText)
  const characters = Array.from(clean)
  if (characters.length <= maxChars) return clean
  if (maxChars === 1) return '…'
  const matchedIndex = Math.min(matchStart, characters.length - 1)
  let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  let suffix = '…'
  let contentLength = maxChars - prefix.length - suffix.length
  if (contentLength < 1) {
    start = matchedIndex
    suffix = ''
    contentLength = maxChars - prefix.length - suffix.length
  } else if (matchedIndex >= start + contentLength) start = matchedIndex - contentLength + 1
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maxChars - prefix.length
    start = Math.max(0, end - contentLength)
  }
  end = Math.min(characters.length, start + contentLength)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

/** `truncateUnicodeCodePoints` (dsh-api-session-controller lib/index.js:1886-1895). */
function truncateCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count += 1
    end += codePoint.length
  }
  return value
}

/** The query's phrase: whitespace collapsed and sanitized as the provider does (`normalizeQuery`, :368-374), then tokenized. */
export function queryPhrase(normalizedQuery: string): string[] {
  return tokenize(Array.from(sanitize(normalizedQuery.replace(/\s+/gu, ' ')))).map((token) => token.text)
}

interface Candidate {
  readonly sessionId: string
  readonly matchCount: number
  readonly length: number
  readonly time: string
  readonly seq: number
  /** The document and its marks: the marked text is made for the twenty sessions answered only (#257). */
  readonly document: PreparedDocument
  readonly groups: readonly (readonly [number, number])[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A session's best document: most marks, fewest code points, latest, highest seq (lib/index.js:824-827). */
function betterEvent(left: Candidate, right: Candidate): number {
  return right.matchCount - left.matchCount || left.length - right.length || compareText(right.time, left.time) || right.seq - left.seq
}

/** The sessions' order: the same keys, then the id (lib/index.js:832). */
function betterSession(left: Candidate, right: Candidate): number {
  return (
    right.matchCount - left.matchCount ||
    left.length - right.length ||
    compareText(right.time, left.time) ||
    compareText(left.sessionId, right.sessionId)
  )
}

/** Rank prepared sessions for an already-normalized query: at most 20, and whether a 21st matched. */
export function rankSessions(
  sessions: Iterable<{ readonly id: string; readonly documents: readonly PreparedDocument[] }>,
  normalizedQuery: string,
): SessionSearchPage {
  return runNow(rankSteps(sessions, normalizedQuery))
}

/**
 * {@link rankSessions} as steps, pausing after each session and each snippet: the order does not depend on where it
 * paused, because the sessions' order ends with the id and a session's best document with its seq. A document's marked
 * text, which for a long answer is the whole answer again, is made only for the twenty sessions answered (#257): made
 * for every matching document, a common word over a large store allocated hundreds of megabytes per query.
 */
function* rankSteps(
  sessions: Iterable<{ readonly id: string; readonly documents: readonly PreparedDocument[] }>,
  normalizedQuery: string,
): Steps<SessionSearchPage> {
  const phrase = queryPhrase(normalizedQuery)
  if (phrase.length === 0) return { items: [], hasMore: false }
  const best: Candidate[] = []
  for (const session of sessions) {
    yield
    let top: Candidate | undefined
    for (const document of session.documents) {
      const groups = phraseGroups(document, phrase)
      if (groups.length === 0) continue
      const candidate: Candidate = {
        sessionId: session.id,
        matchCount: groups.length,
        length: document.chars.length,
        time: document.time,
        seq: document.seq,
        document,
        groups,
      }
      if (top === undefined || betterEvent(candidate, top) < 0) top = candidate
    }
    if (top !== undefined) best.push(top)
  }
  best.sort(betterSession)
  const items: SessionSearchHit[] = []
  for (const hit of best.slice(0, SESSION_SEARCH_RESULT_LIMIT)) {
    yield
    const marked = markGroups(hit.document, hit.groups)
    items.push({ sessionId: hit.sessionId, snippet: truncateCodePoints(makeSnippet(marked, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS), SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS) })
  }
  return { items, hasMore: best.length > SESSION_SEARCH_RESULT_LIMIT }
}

// ---------------------------------------------------------------------------------------------------------------------
// Work in steps: what lets a long index build share the event loop (#257).

/**
 * Index work as steps. Each `yield` is a point where the work may pause; it carries nothing.
 *
 * The same steps run two ways: {@link runNow} runs them through at once, which is the synchronous {@link
 * SessionSearchIndex.search}; {@link runSliced} lets the event loop run whenever a slice of work has taken
 * {@link SEARCH_SLICE_MS}, which is what the server's route uses. One code path, so both answer the same.
 */
type Steps<T> = Generator<void, T, undefined>

/**
 * How long index work holds the event loop before it lets other work run.
 *
 * Measured (#257): the first content search after a start decoded every log on the event loop, 12.9 s on a store the
 * size of the live one and 34-76 s on one twice that, and the supervisor kills a server that misses three 2 s health
 * probes 5 s apart. With a pause every 20 ms the server answers its probes throughout.
 */
export const SEARCH_SLICE_MS = 20

/** How many frames a log's read decodes between pauses: a frame is a few microseconds. */
const FRAMES_PER_STEP = 64


function runNow<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}

/** Thrown into a search whose index was stopped (the server is closing), so no build outlives its server. */
export class SessionSearchStopped extends Error {
  constructor() {
    super('the session search index was stopped')
    this.name = 'SessionSearchStopped'
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function runSliced<T>(steps: Steps<T>, stopped: () => boolean): Promise<T> {
  let slice = performance.now()
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
    if (performance.now() - slice < SEARCH_SLICE_MS) continue
    await turn()
    if (stopped()) {
      steps.return(undefined as never)
      throw new SessionSearchStopped()
    }
    slice = performance.now()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One log, read as it grows.

/** How many bytes at each end of what was read are kept to tell an appended log from a rewritten one. */
const MARK_BYTES = 16

/**
 * What a framed log's next read needs, so it decodes only what was appended (#257).
 *
 * A log is append-only frames, and the surface fold is quiet after a step's end or a replacement
 * ({@link quietsSurface}): nothing held, no run open. So what is kept is the surface folded through the log's last
 * quiet event, the documents of the nodes placed by then (final: a node placed there never changes, it can only be
 * shadowed), and the events after it. The next read folds those events and the appended ones from there, and gives
 * exactly the documents a whole read would.
 */
interface FollowState {
  /** Bytes read whole, as frames: the next read starts here. */
  readonly offset: number
  /** Where the first frame ends, and its last bytes: a log whose head changed was rewritten. */
  readonly headEnd: number
  readonly headMark: Buffer
  /** The last bytes before `offset`: a log whose last frame read is gone was cut back or rewritten. */
  readonly lastMark: Buffer
  /** The surface folded through the last quiet event. */
  readonly surface: SurfaceState
  /** The document of every node of `surface`, or null for a node that is none. */
  readonly settled: ReadonlyMap<number, PreparedDocument | null>
  /** The events after the last quiet event, folded again with the next read's. */
  readonly pending: readonly SessionEvent[]
  /** The highest seq read: the follow assumes seqs only grow, and a log where they do not is read whole instead. */
  readonly lastSeq: number
  /**
   * A line that is not JSON, or a surface that does not fold: the log contributes nothing, as a whole read gives
   * nothing, and since nothing is ever taken out of an appended log it stays so until the log is rewritten.
   */
  readonly broken: boolean
}

/** One log as the index keeps it: the file's identity when read, its documents, and how to read it next. */
interface LogEntry {
  readonly transcript: string
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
  readonly documents: readonly PreparedDocument[]
  /** Absent for a log read whole every time it changes: plain text, a torn first frame, or seqs that do not grow. */
  readonly follow?: FollowState
}

/** What an index read: kept so a check can see that a grown log was read from where it stopped (#257). */
export interface SessionSearchCounts {
  /** Builds begun over the store: the synchronous search's and the shared ones. */
  builds: number
  /** Frames decoded. */
  frames: number
  /** Logs read from their first byte. */
  wholeReads: number
  /** Logs read from where the last read stopped. */
  tailReads: number
}

const EMPTY_SURFACE: SurfaceState = { nodes: [], contentGeneration: 0, replaceGeneration: 0, replacements: [] }

const IRREGULAR = Symbol('irregular')

function mark(bytes: Buffer, end: number): Buffer {
  return Buffer.from(bytes.subarray(Math.max(0, end - MARK_BYTES), end))
}

function prepared(document: SearchDocument | null): PreparedDocument | null {
  return document === null ? null : prepareDocument(document)
}

/**
 * Read the frames of `bytes` (the log from `base` on) and carry `follow` forward over them.
 *
 * `IRREGULAR` when a line's seq does not grow: the fold then reads the whole log, as before this existed.
 */
function* extend(
  follow: FollowState,
  bytes: Buffer,
  base: number,
  counts: SessionSearchCounts,
): Steps<{ follow: FollowState; documents: readonly PreparedDocument[] } | typeof IRREGULAR> {
  const fresh: SessionEvent[] = []
  let broken = follow.broken
  let lastSeq = follow.lastSeq
  let end = 0
  let frames = 0
  for (const frame of readFrames(bytes, 0)) {
    if (!broken) {
      for (const line of frame.lines) {
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          broken = true
          break
        }
        const seq = (record as { seq?: unknown } | null)?.seq
        if (typeof seq !== 'number' || !(seq > lastSeq)) return IRREGULAR
        lastSeq = seq
        fresh.push(record as SessionEvent)
      }
    }
    end = frame.end
    frames += 1
    counts.frames += 1
    if (frames % FRAMES_PER_STEP === 0) yield
  }
  const read = { offset: base + end, lastMark: end > 0 ? mark(bytes, end) : follow.lastMark, lastSeq }
  if (broken) {
    return { follow: { ...follow, ...read, surface: EMPTY_SURFACE, settled: new Map(), pending: [], broken: true }, documents: [] }
  }
  const tail = follow.pending.length === 0 ? fresh : [...follow.pending, ...fresh]
  let quiet = tail.length - 1
  while (quiet >= 0 && !quietsSurface(tail[quiet]!)) quiet -= 1
  let surface: SurfaceState
  let nodes: readonly number[]
  try {
    surface = quiet >= 0 ? foldSurface(tail.slice(0, quiet + 1), follow.surface) : follow.surface
    nodes = foldSurface(quiet >= 0 ? tail.slice(quiet + 1) : tail, surface).nodes
  } catch {
    // The fold throws at the same event however much of the log follows it: a whole read gives nothing too.
    return { follow: { ...follow, ...read, surface: EMPTY_SURFACE, settled: new Map(), pending: [], broken: true }, documents: [] }
  }
  yield
  const bySeq = indexBySeq(tail)
  yield
  /** A node's document: the one settled already, else made now — a pause after each, as a long answer's tokens take milliseconds. */
  const settled = new Map<number, PreparedDocument | null>()
  let made = false
  const documentOf = (seq: number): PreparedDocument | null => {
    const known = settled.has(seq) ? settled.get(seq) : follow.settled.get(seq)
    if (known !== undefined) return known
    made = true
    return prepared(documentAt(bySeq, seq))
  }
  for (const seq of surface.nodes) {
    settled.set(seq, documentOf(seq))
    if (made) {
      made = false
      yield
    }
  }
  const documents: PreparedDocument[] = []
  for (const seq of nodes) {
    const document = documentOf(seq)
    if (document !== null) documents.push(document)
    if (made) {
      made = false
      yield
    }
  }
  return { follow: { ...follow, ...read, surface, settled, pending: tail.slice(quiet + 1), broken: false }, documents }
}

/** The bytes appended since `follow.offset`, or undefined when the log was rewritten (its marks moved) or cannot be read. */
function appended(transcript: string, follow: FollowState, size: number): Buffer | undefined {
  let fd: number
  try {
    fd = openSync(transcript, 'r')
  } catch {
    return undefined
  }
  try {
    const holds = (at: number, expected: Buffer): boolean => {
      if (expected.length === 0) return true
      const found = Buffer.alloc(expected.length)
      return readSync(fd, found, 0, expected.length, at) === expected.length && found.equals(expected)
    }
    if (!holds(follow.headEnd - follow.headMark.length, follow.headMark)) return undefined
    if (!holds(follow.offset - follow.lastMark.length, follow.lastMark)) return undefined
    const bytes = Buffer.alloc(Math.max(0, size - follow.offset))
    let read = 0
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, follow.offset + read)
      if (count === 0) break
      read += count
    }
    return bytes.subarray(0, read)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** A log read whole, as the index always read it before it followed logs: every frame, then the surface's documents. */
function* wholeDocuments(bytes: Buffer, counts: SessionSearchCounts): Steps<readonly PreparedDocument[]> {
  try {
    let lines: readonly string[]
    if (looksCompressed(bytes)) {
      const read: string[] = []
      for (const frame of readFrames(bytes, 0)) {
        read.push(...frame.lines)
        counts.frames += 1
        if (counts.frames % FRAMES_PER_STEP === 0) yield
      }
      lines = read
    } else lines = decodeTranscript(bytes).lines
    const events = lines.map((line) => JSON.parse(line) as SessionEvent)
    yield
    const documents: PreparedDocument[] = []
    for (const document of searchDocuments(events)) {
      documents.push(prepareDocument(document))
      yield
    }
    return documents
  } catch {
    // A log that does not parse is not searchable, and must not cost the other sessions their answer.
    return []
  }
}

/**
 * One log's entry, brought up to date: the same entry when the file has not changed, a read of what was appended when
 * it only grew, else a read of the whole log. `undefined` when the file cannot be looked at (the search answers no
 * documents for it, as before).
 */
function* readLog(previous: LogEntry | undefined, transcript: string, counts: SessionSearchCounts): Steps<LogEntry | undefined> {
  let identity: { transcript: string; size: number; mtimeMs: number; ino: number }
  try {
    const stats = statSync(transcript)
    identity = { transcript, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino }
  } catch {
    return undefined
  }
  const same = previous !== undefined && previous.transcript === transcript && previous.ino === identity.ino
  if (same && previous.size === identity.size && previous.mtimeMs === identity.mtimeMs) return previous
  const follow = same ? previous.follow : undefined
  if (follow !== undefined && identity.size >= follow.offset) {
    const bytes = appended(transcript, follow, identity.size)
    if (bytes !== undefined) {
      counts.tailReads += 1
      const next = yield* extend(follow, bytes, follow.offset, counts)
      if (next !== IRREGULAR) return { ...identity, documents: next.documents, follow: next.follow }
    }
  }
  counts.wholeReads += 1
  let bytes: Buffer
  try {
    bytes = readFileSync(transcript)
  } catch {
    return { ...identity, documents: [] }
  }
  const headEnd = looksCompressed(bytes) ? frameEnd(bytes, 0) : undefined
  if (headEnd !== undefined) {
    const start: FollowState = {
      offset: 0,
      headEnd,
      headMark: mark(bytes, headEnd),
      lastMark: Buffer.alloc(0),
      surface: EMPTY_SURFACE,
      settled: new Map(),
      pending: [],
      lastSeq: -Infinity,
      broken: false,
    }
    const read = yield* extend(start, bytes, 0, counts)
    if (read !== IRREGULAR) return { ...identity, documents: read.documents, follow: read.follow }
  }
  return { ...identity, documents: yield* wholeDocuments(bytes, counts) }
}

// ---------------------------------------------------------------------------------------------------------------------
// The index over a store.

/** One searchable session of a build: its listed meta and its documents. */
interface Indexed {
  readonly id: string
  readonly meta: SessionMeta
  readonly documents: readonly PreparedDocument[]
}

/**
 * A store's sessions, searchable: each log's prepared documents, kept between queries and brought up to date by
 * reading only what was appended.
 *
 * The log is read straight from its file and decoded on its own, so a search neither fills the store's fold with every
 * session nor repairs or locks anything: a torn tail is simply not read, as every reader leaves it to the writer.
 *
 * **Off the event loop's back** (#257). The first search in a process reads every log, which took 12.9 s on a store
 * the size of the live one, all of it on the event loop: the supervisor killed the server as hung. So the server's
 * search ({@link searchAsync}) does the same work in slices of {@link SEARCH_SLICE_MS}, pausing between frames of a
 * long log as well as between logs, and between sessions while it ranks; a grown log is read from where the last read
 * stopped; and the reads are **one shared build**: a search that arrives while one is under way waits for the build
 * after it, which every search arriving meanwhile shares, because the build under way may already have passed a log
 * written since. Searches that arrive together share one build. The server starts a build soon after it starts
 * ({@link warm}), so the first person to search does not wait for the first read of every log.
 */
export class SessionSearchIndex {
  private readonly logs = new Map<string, LogEntry>()
  private readonly store: SessionStore
  /** The build under way or about to begin, and whether it has begun reading. */
  private build: { readonly corpus: Promise<readonly Indexed[]>; begun: boolean } | undefined
  /** The build after it, which the searches that arrived during it share. */
  private next: Promise<readonly Indexed[]> | undefined
  /** Bumped by {@link stop}: a build or ranking begun before it throws {@link SessionSearchStopped} at its next pause. */
  private generation = 0
  /** What the index has read, for a check. */
  readonly counts: SessionSearchCounts = { builds: 0, frames: 0, wholeReads: 0, tailReads: 0 }

  constructor(store: SessionStore) {
    this.store = store
  }

  /** DSH's `session.search`: the query validated with DSH's sentences, then the ranked page. Synchronous: it reads in one go. */
  search(query: unknown): SessionSearchPage {
    const normalized = normalizeSearchQuery(query)
    this.counts.builds += 1
    return runNow(rankSteps(runNow(this.buildSteps()), normalized))
  }

  /** The same answer as {@link search}, read and ranked in slices that let the event loop run between them (#257). */
  async searchAsync(query: unknown): Promise<SessionSearchPage> {
    const normalized = normalizeSearchQuery(query)
    const corpus = await this.refresh()
    const generation = this.generation
    return runSliced(rankSteps(corpus, normalized), () => this.generation !== generation)
  }

  /** Bring the index up to date in the background; the server calls it soon after it starts. Never rejects. */
  async warm(): Promise<void> {
    await this.refresh().catch(() => undefined)
  }

  /** The documents the index holds for a session, as of the last build that read it; undefined before one did. */
  documents(id: string): readonly PreparedDocument[] | undefined {
    return this.logs.get(id)?.documents
  }

  /** Stop the build under way, at its next pause, and any build queued after it: the server is closing. */
  stop(): void {
    this.generation += 1
  }

  /** The corpus as of a build that began after this call, or that began with it. */
  private refresh(): Promise<readonly Indexed[]> {
    const build = this.build
    if (build === undefined || !build.begun) return (this.build ??= this.begin()).corpus
    const generation = this.generation
    this.next ??= build.corpus
      .catch(() => undefined)
      .then(() => {
        this.next = undefined
        if (this.generation !== generation) throw new SessionSearchStopped()
        return this.refresh()
      })
    return this.next
  }

  private begin(): { readonly corpus: Promise<readonly Indexed[]>; begun: boolean } {
    const generation = this.generation
    const stopped = (): boolean => this.generation !== generation
    const build: { corpus: Promise<readonly Indexed[]>; begun: boolean } = { corpus: Promise.resolve([]), begun: false }
    build.corpus = (async () => {
      try {
        /** One turn of the loop first, so the searches that arrive with this one share it. */
        await turn()
        if (stopped()) throw new SessionSearchStopped()
        build.begun = true
        this.counts.builds += 1
        return await runSliced(this.buildSteps(), stopped)
      } finally {
        if (this.build === build) this.build = undefined
      }
    })()
    return build
  }

  /** Every listed session with a `cwd`, its log brought up to date. */
  private *buildSteps(): Steps<readonly Indexed[]> {
    const corpus: Indexed[] = []
    const seen = new Set<string>()
    const metas = this.store.list()
    yield
    for (const meta of metas) {
      /** DSH searches the visible sessions only: those whose header carries a `cwd` (lib/index.js:2018). */
      if (typeof meta.cwd !== 'string' || meta.cwd.length === 0) continue
      const handle = this.store.open(meta.id)
      if (handle === null) continue
      seen.add(meta.id)
      const before = this.logs.get(meta.id)
      const after = yield* readLog(before, handle.transcript, this.counts)
      /** A search that ran while this one paused may have read the log since: its entry is the newer, and stays. */
      const current = this.logs.get(meta.id)
      if (current === before) {
        if (after === undefined) this.logs.delete(meta.id)
        else this.logs.set(meta.id, after)
      }
      corpus.push({ id: meta.id, meta, documents: (current === before ? after : current)?.documents ?? [] })
      yield
    }
    for (const id of this.logs.keys()) if (!seen.has(id)) this.logs.delete(id)
    return corpus
  }
}

const indexes = new WeakMap<SessionStore, SessionSearchIndex>()

/** A store's one search index, so a server's repeated queries reuse what earlier ones read. */
export function sessionSearchIndex(store: SessionStore): SessionSearchIndex {
  let index = indexes.get(store)
  if (index === undefined) {
    index = new SessionSearchIndex(store)
    indexes.set(store, index)
  }
  return index
}

/** Search a store through its one index, in one go. */
export function searchSessions(store: SessionStore, query: unknown): SessionSearchPage {
  return sessionSearchIndex(store).search(query)
}

/** Search a store through its one index without holding the event loop: the server's route (#257). */
export function searchSessionsAsync(store: SessionStore, query: unknown): Promise<SessionSearchPage> {
  return sessionSearchIndex(store).searchAsync(query)
}
