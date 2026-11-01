import { readFileSync, statSync } from 'node:fs'

import { foldSurface, indexBySeq, type SessionEvent, type SessionStore } from './store.ts'
import { decodeTranscript } from './transcript.ts'
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
 * read again only when its size or modification time changed, and what is kept between queries is the documents'
 * text and tokens, never the whole event log — the store's own fold is not used, so a search does not load every
 * session into it or take any session's writer lock. The cost is a directory walk and a `stat` per session per query,
 * which a 250 ms debounced sidebar search affords.
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
    const event = bySeq.get(seq)
    if (event === undefined) continue
    let type: SearchDocument['type']
    let parts: string[]
    let time: string
    if (event.type === 'message') {
      const role = stringField(event.message, 'role')
      if (role !== 'user' && role !== 'assistant') continue
      type = role === 'user' ? 'user/message' : 'assistant/message'
      parts = messageParts(event.message)
      time = typeof event.at === 'string' ? event.at : ''
    } else if (event.type === 'assistant/chunk') {
      type = 'assistant/message'
      ;({ parts, time } = chunkRun(bySeq, seq))
    } else continue
    const text = joinText(parts)
    if (text.length === 0) continue
    documents.push({ seq, type, time, text: sanitize(text) })
  }
  return documents
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
  const size = phrase.length
  if (size === 0) return null
  const { tokens, chars } = document
  const groups: [number, number][] = []
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
  if (groups.length === 0) return null
  const pieces: string[] = []
  let cursor = 0
  for (const [first, last] of groups) {
    const start = tokens[first]!.start
    const end = tokens[last]!.end
    pieces.push(chars.slice(cursor, start).join(''), OPEN, chars.slice(start, end).join(''), CLOSE)
    cursor = end
  }
  pieces.push(chars.slice(cursor).join(''))
  return { matchCount: groups.length, marked: pieces.join('') }
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
  readonly marked: string
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
  const phrase = queryPhrase(normalizedQuery)
  if (phrase.length === 0) return { items: [], hasMore: false }
  const best: Candidate[] = []
  for (const session of sessions) {
    let top: Candidate | undefined
    for (const document of session.documents) {
      const marked = markPhrase(document, phrase)
      if (marked === null) continue
      const candidate: Candidate = {
        sessionId: session.id,
        matchCount: marked.matchCount,
        length: document.chars.length,
        time: document.time,
        seq: document.seq,
        marked: marked.marked,
      }
      if (top === undefined || betterEvent(candidate, top) < 0) top = candidate
    }
    if (top !== undefined) best.push(top)
  }
  best.sort(betterSession)
  return {
    items: best.slice(0, SESSION_SEARCH_RESULT_LIMIT).map((hit) => ({
      sessionId: hit.sessionId,
      snippet: truncateCodePoints(makeSnippet(hit.marked, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS), SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
    })),
    hasMore: best.length > SESSION_SEARCH_RESULT_LIMIT,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The index over a store.

/**
 * A store's sessions, searchable: each log's prepared documents, kept until the log's size or time changes.
 *
 * The log is read straight from its file and decoded on its own, so a search neither fills the store's fold with every
 * session nor repairs or locks anything: a torn tail is simply not read, as every reader leaves it to the writer.
 */
export class SessionSearchIndex {
  private readonly cache = new Map<string, { readonly key: string; readonly documents: readonly PreparedDocument[] }>()
  private readonly store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

  /** DSH's `session.search`: the query validated with DSH's sentences, then the ranked page. */
  search(query: unknown): SessionSearchPage {
    const normalized = normalizeSearchQuery(query)
    const corpus: { id: string; documents: readonly PreparedDocument[] }[] = []
    const seen = new Set<string>()
    for (const meta of this.store.list()) {
      /** DSH searches the visible sessions only: those whose header carries a `cwd` (lib/index.js:2018). */
      if (typeof meta.cwd !== 'string' || meta.cwd.length === 0) continue
      const handle = this.store.open(meta.id)
      if (handle === null) continue
      seen.add(meta.id)
      corpus.push({ id: meta.id, documents: this.documentsOf(meta.id, handle.transcript) })
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id)
    return rankSessions(corpus, normalized)
  }

  private documentsOf(id: string, transcript: string): readonly PreparedDocument[] {
    let key: string
    try {
      const stats = statSync(transcript)
      key = `${transcript}\0${stats.size}\0${stats.mtimeMs}`
    } catch {
      return []
    }
    const cached = this.cache.get(id)
    if (cached !== undefined && cached.key === key) return cached.documents
    let documents: readonly PreparedDocument[] = []
    try {
      const events = decodeTranscript(readFileSync(transcript)).lines.map((line) => JSON.parse(line) as SessionEvent)
      documents = searchDocuments(events).map(prepareDocument)
    } catch {
      // A log that does not parse is not searchable, and must not cost the other sessions their answer.
      documents = []
    }
    this.cache.set(id, { key, documents })
    return documents
  }
}

const indexes = new WeakMap<SessionStore, SessionSearchIndex>()

/** Search a store through its one index, so a server's repeated queries reuse what earlier ones read. */
export function searchSessions(store: SessionStore, query: unknown): SessionSearchPage {
  let index = indexes.get(store)
  if (index === undefined) {
    index = new SessionSearchIndex(store)
    indexes.set(store, index)
  }
  return index.search(query)
}
