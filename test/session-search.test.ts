import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  makeSnippet,
  markPhrase,
  normalizeSearchQuery,
  prepareDocument,
  queryPhrase,
  rankSessions,
  SESSION_SEARCH_RESULT_LIMIT,
  SessionSearchIndex,
  SessionSearchQueryError,
  searchDocuments,
  tokenize,
  type PreparedDocument,
} from '../src/session/search.ts'
import { SessionStore, type SessionEvent, type SessionHandle } from '../src/session/store.ts'
import { DIACRITICS, FOLDS, SEPARATORS } from '../src/session/unicode61.ts'

/**
 * Content search (R-developer-eight-19): DSH's `session.search`, judged without a server.
 *
 * The reference is SQLite itself wherever this Node has `node:sqlite` — the engine DSH's session index runs on — so the
 * tokenizer and the phrase marks are held to FTS5's own answers rather than to a reading of its documentation. The
 * order and the snippet are held to DSH's code (dsh-session-query-sqlite lib/index.js:325-367, :818-834).
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-search-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `node:sqlite`, or `undefined` on a Node without it (the check is then skipped, never passed). */
async function sqlite(): Promise<typeof import('node:sqlite') | undefined> {
  try {
    return await import('node:sqlite')
  } catch {
    return undefined
  }
}

function doc(text: string, extra: Partial<PreparedDocument> = {}): PreparedDocument {
  return { ...prepareDocument({ seq: extra.seq ?? 1, type: 'assistant/message', time: extra.time ?? '2026-10-30T00:00:00.000Z', text }), ...extra }
}

test('the query is refused with DSH\'s sentences: empty, over 500 UTF-16 units, or holding NUL', () => {
  const refusal = (query: unknown): string => {
    try {
      normalizeSearchQuery(query)
    } catch (error) {
      assert.ok(error instanceof SessionSearchQueryError, 'a refusal is the bad-request error')
      return error.message
    }
    return 'accepted'
  }
  assert.equal(refusal('   '), 'session search query must not be empty')
  assert.equal(refusal(undefined), 'session search query must not be empty')
  assert.equal(refusal('q'.repeat(501)), 'session search query must contain at most 500 UTF-16 code units')
  assert.equal(refusal(` ${'q'.repeat(500)} `), 'accepted', 'the bound is measured after the trim')
  assert.equal(refusal('a\0b'), 'session search query must not contain NUL')
  assert.equal(normalizeSearchQuery('  quokka ledger \n'), 'quokka ledger')
})

test('a phrase is matched by tokens, case-folded and without diacritics, never as a substring', () => {
  const phrase = queryPhrase('Quokka   LEDGER')
  assert.deepEqual(phrase, ['quokka', 'ledger'], 'whitespace collapses and case folds')
  assert.equal(markPhrase(doc('The Quökka-Ledger balanced.'), phrase)?.marked, 'The \uFDD0Quökka-Ledger\uFDD1 balanced.', 'punctuation separates, ö folds to o')
  assert.equal(markPhrase(doc('quokkaledger'), phrase), null, 'one token is not the phrase')
  assert.equal(markPhrase(doc('quokka and the ledger'), phrase), null, 'the words must be adjacent')
  assert.equal(markPhrase(doc('ledger quokka'), phrase), null, 'and in order')
  assert.equal(markPhrase(doc('anything'), queryPhrase('!!! ---')), null, 'a query with no token matches nothing, as an empty FTS5 phrase')
  assert.deepEqual(
    tokenize(Array.from('e\u0301te\u0301 \u0301x İstanbul')).map((token) => token.text),
    ['ete', 'x', 'istanbul'],
    'a combining acute continues a token and is dropped, and alone it is nothing',
  )
  const counted = markPhrase(doc('quokka quokka, quokka'), queryPhrase('quokka quokka'))
  assert.equal(counted?.matchCount, 1, 'overlapping occurrences share one mark')
  assert.equal(markPhrase(doc('quokka x quokka'), queryPhrase('quokka'))?.matchCount, 2, 'separate ones count twice')
})

test('the tokenizer and the marks are SQLite FTS5 unicode61\'s own, code point by code point', async (context) => {
  const engine = await sqlite()
  if (engine === undefined) {
    context.skip('this Node has no node:sqlite to compare with')
    return
  }
  const db = new engine.DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE d USING fts5(text, tokenize = 'unicode61')")
  db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(d, 'instance')")
  const insert = db.prepare('INSERT INTO d(rowid, text) VALUES (?, ?)')
  const START = 0x200000
  const points: number[] = []
  for (let cp = 0; cp <= 0x1ffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) points.push(cp)
  db.exec('BEGIN')
  for (const cp of points) {
    insert.run(cp, `a${String.fromCodePoint(cp)}b`)
    insert.run(START + cp, `${String.fromCodePoint(cp)}b`)
  }
  db.exec('COMMIT')
  const terms = new Map<number, string[]>()
  for (const row of db.prepare('SELECT term, doc FROM v ORDER BY doc, offset').iterate() as Iterable<{ term: string; doc: number }>) {
    terms.set(row.doc, [...(terms.get(row.doc) ?? []), row.term])
  }
  const wrong: string[] = []
  for (const cp of points) {
    for (const [id, text] of [
      [cp, `a${String.fromCodePoint(cp)}b`],
      [START + cp, `${String.fromCodePoint(cp)}b`],
    ] as const) {
      const mine = tokenize(Array.from(text)).map((token) => token.text).join('|')
      const theirs = (terms.get(id) ?? []).join('|')
      if (mine !== theirs && wrong.length < 10) wrong.push(`U+${cp.toString(16)} in ${JSON.stringify(text)}: ${mine} vs ${theirs}`)
    }
  }
  assert.deepEqual(wrong, [], 'every code point of planes 0 and 1 tokenizes as FTS5 tokenizes it')

  /** Random documents built from the awkward pieces, and the phrase marks `highlight()` puts in them. */
  db.exec('DELETE FROM d')
  const pieces = ['quokka', 'Quökka', 'QUOKKA', 'ledger', 'le\u0301dger', ' ', '\n', '-', '_', '.', 'İstanbul', 'ǖ', 'ΣΑΣ', 'ﬁle', '日本語', '😀', '\u0301', '\u0338', '42', 'ß', 'Æsir', '\u00a0', 'quokka-ledger', 'quokkaledger']
  const queries = ['quokka', 'quokka ledger', 'QUOKKA LEDGER', 'ledger quokka', 'istanbul', 'Ǖ', 'σας', 'file', '日本語', 'quokka quokka', 'æsir', 'ss', '-']
  let seed = 11
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const documents: string[] = []
  for (let id = 1; id <= 1500; id += 1) {
    let text = ''
    for (let count = 1 + next(12); count > 0; count -= 1) text += pieces[next(pieces.length)]
    documents.push(text)
    insert.run(id, text)
  }
  const differences: string[] = []
  for (const query of queries) {
    const expression = `"${query.replaceAll('"', '""')}"`
    const rows = db.prepare("SELECT rowid AS id, highlight(d, 0, '\uFDD0', '\uFDD1') AS marked FROM d WHERE d MATCH ?").all(expression) as {
      id: number
      marked: string
    }[]
    const theirs = new Map(rows.map((row) => [row.id, row.marked]))
    const phrase = queryPhrase(query)
    documents.forEach((text, index) => {
      const mine = markPhrase(doc(text), phrase)?.marked ?? null
      if (mine !== (theirs.get(index + 1) ?? null) && differences.length < 10) differences.push(`${query} in ${JSON.stringify(text)}`)
    })
  }
  assert.deepEqual(differences, [], 'every document matches, and is marked, exactly where FTS5 marks it')
  db.close()
})

test('the Rust build carries the same tables', () => {
  const source = readFileSync(join(repo, 'rust', 'crates', 'heddle-session', 'src', 'unicode61.rs'), 'utf8')
  const block = (name: string): number[][] => {
    const match = new RegExp(`pub const ${name}: [^=]+= &\\[([^\\]]*)\\];`).exec(source)
    assert.ok(match, `the Rust file declares ${name}`)
    const body = match[1]!
    if (!body.includes('(')) return body.split(',').map((item) => item.trim()).filter(Boolean).map((item) => [Number(item)])
    return [...body.matchAll(/\(([^)]*)\)/g)].map((tuple) => tuple[1]!.split(',').map((item) => Number(item.trim())))
  }
  assert.deepEqual(block('SEPARATORS'), SEPARATORS.map((range) => [...range]))
  assert.deepEqual(block('DIACRITICS'), DIACRITICS.map((cp) => [cp]))
  assert.deepEqual(block('FOLDS'), FOLDS.map((run) => [...run]))
})

test('the snippet is DSH\'s: whitespace collapsed, 240 code points, a third of the window before the match', () => {
  const short = markPhrase(doc('  The   quokka\n\nledger  '), queryPhrase('quokka'))!
  assert.equal(makeSnippet(short.marked, 240), 'The quokka ledger', 'a short document is the whole of it, collapsed')

  const middle = markPhrase(doc(`${'x'.repeat(150)} quokka ledger ${'y'.repeat(150)}`), queryPhrase('quokka ledger'))!
  const cut = makeSnippet(middle.marked, 240)
  assert.equal(cut, `…${'x'.repeat(79)} quokka ledger ${'y'.repeat(144)}…`, 'the window opens 80 before the match, with both ellipses')
  assert.equal(Array.from(cut).length, 240)

  const late = markPhrase(doc(`${'y'.repeat(300)} quokka`), queryPhrase('quokka'))!
  assert.equal(makeSnippet(late.marked, 240), `…${'y'.repeat(232)} quokka`, 'a window that reaches the end keeps no trailing ellipsis')

  const wide = markPhrase(doc(`${'😀 '.repeat(130)}quokka`), queryPhrase('quokka'))!
  assert.equal(Array.from(makeSnippet(wide.marked, 240)).length, 240, 'the bound counts code points, not UTF-16 units')
})

test('a session is ranked by its best message: marks, then length, then time, then the id', () => {
  const phrase = 'quokka'
  const page = rankSessions(
    [
      { id: 'session-c', documents: [doc('one quokka here', { time: '2026-10-30T00:00:01.000Z' })] },
      { id: 'session-a', documents: [doc('two quokka quokka marks, a longer message than the rest', { time: '2026-10-30T00:00:00.000Z' })] },
      { id: 'session-b', documents: [doc('one quokka here', { time: '2026-10-30T00:00:05.000Z' })] },
      { id: 'session-d', documents: [doc('one quokka here', { time: '2026-10-30T00:00:01.000Z' })] },
      { id: 'session-e', documents: [doc('one quokka, but longer'), doc('no match at all')] },
      { id: 'session-f', documents: [doc('nothing')] },
    ],
    phrase,
  )
  assert.deepEqual(
    page.items.map((item) => item.sessionId),
    ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'],
    'more marks first; then shorter; then newer; then by id; a session with no match is absent',
  )
  assert.equal(page.hasMore, false)

  const best = rankSessions(
    [
      {
        id: 'session-x',
        documents: [
          doc('quokka in a long message that goes on and on', { seq: 3 }),
          doc('quokka, short', { seq: 5, time: '2026-10-30T00:00:00.000Z' }),
          doc('quokka, short', { seq: 7, time: '2026-10-30T00:00:00.000Z' }),
        ],
      },
    ],
    phrase,
  )
  assert.equal(best.items[0]?.snippet, 'quokka, short', 'the session quotes its best message')

  const many = rankSessions(
    Array.from({ length: SESSION_SEARCH_RESULT_LIMIT + 1 }, (_, index) => ({ id: `session-${String(index).padStart(2, '0')}`, documents: [doc('a quokka')] })),
    phrase,
  )
  assert.equal(many.items.length, 20, 'at most twenty sessions')
  assert.equal(many.hasMore, true, 'and a twenty-first says there is more')
})

test('the corpus is the current user and assistant messages, never notes, tool results or a shadowed span', () => {
  let seq = 0
  const at = (): string => `2026-10-30T00:00:${String(seq).padStart(2, '0')}.000Z`
  const event = (fields: Record<string, unknown>, surfaceOp?: unknown): SessionEvent => {
    const record = { seq, at: at(), ...fields, ...(surfaceOp !== undefined ? { surfaceOp } : {}) } as SessionEvent
    seq += 1
    return record
  }
  const events: SessionEvent[] = [
    event({ type: 'session/created', cwd: '/w' }),
    event({ type: 'context/note', message: { role: 'user', content: [{ type: 'text', text: 'quokka note' }] } }),
    event({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '  the user asked about a quokka  ' }] } }),
    event({ type: 'assistant/chunk', chunk: { type: 'reasoning-delta', text: 'thinking of quokka' } }),
    event({ type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'Quo' } }),
    event({ type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'kka ledger' } }),
    event({ type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"q.md"}' } }),
    event({ type: 'assistant/chunk', chunk: { type: 'done', finishReason: 'tool-calls' } }),
    event({ type: 'message', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'quokka in a tool result' }] } }),
    event({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'an old quokka question' }] } }),
    event({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'an old quokka answer' }] } }),
  ]
  events.push(event({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }, { op: 'replace', startSeq: 9, endSeq: 10 }))
  const documents = searchDocuments(events)
  assert.deepEqual(
    documents.map((document) => [document.seq, document.type, document.text]),
    [
      [2, 'user/message', 'the user asked about a quokka'],
      [3, 'assistant/message', 'Quokka ledger\nread_file\n{"path":"q.md"}'],
      [11, 'user/message', 'summary'],
    ],
    'a streamed answer settles into one text block plus its tool call, reasoning is not text, and the replaced span is gone',
  )
  assert.equal(documents[1]?.time, '2026-10-30T00:00:07.000Z', 'a streamed answer is timed when it settled')
})

test('the index searches a real store, and a log written since is read again', () => {
  const store = new SessionStore(join(scratch, 'store'))
  const first = store.create({ cwd: join(scratch, 'work-one') })
  store.message(first, { role: 'user', content: [{ type: 'text', text: 'what lives in the hills?' }] })
  store.message(first, { role: 'assistant', content: [{ type: 'text', text: 'The marsupial ledger lists a quokka colony.' }] })
  const second = store.create({ cwd: join(scratch, 'work-two') })
  store.message(second, { role: 'user', content: [{ type: 'text', text: 'and the ledger?' }] })

  const index = new SessionSearchIndex(store)
  assert.deepEqual(index.search('Quokka Colony'), {
    items: [{ sessionId: first.id, snippet: 'The marsupial ledger lists a quokka colony.' }],
    hasMore: false,
  })
  assert.deepEqual(index.search('ledger').items.map((item) => item.sessionId), [second.id, first.id], 'the shorter message ranks first')

  store.message(second, { role: 'assistant', content: [{ type: 'text', text: 'a quokka colony, twice: quokka colony' }] })
  assert.deepEqual(index.search('quokka colony').items.map((item) => item.sessionId), [second.id, first.id], 'the new answer is found and outranks')
  assert.throws(() => index.search(' '), SessionSearchQueryError)
})

/**
 * #189, developer-six's J170: one visible session holds the word in a longer answer, 21 archived ones hold it in shorter
 * answers, so all 21 outrank it. DSH's answer — every session with a `cwd` — is twenty archived sessions with `hasMore`,
 * and the page, which hides archived sessions by default, showed "No matching sessions". Given the page's filter, the
 * search ranks only the rows the page draws, before the twenty are cut.
 */
const say = (store: SessionStore, handle: SessionHandle, role: 'user' | 'assistant', text: string) => store.message(handle, { role, content: [{ type: 'text', text }] })

test('#189: with the page\'s archive filter the search ranks only the rows it draws, before the twenty are cut; without one it is unchanged', () => {
  const store = new SessionStore(join(scratch, 'store-189'))
  const cwd = join(scratch, 'work-189')
  const visible = store.create({ cwd })
  say(store, visible, 'user', 'plain note 0')
  say(store, visible, 'assistant', 'zorbliquant, and a few more words than the archived ones have')
  const archived = Array.from({ length: 21 }, (_, index) => {
    const handle = store.create({ cwd })
    say(store, handle, 'user', `plain note ${index + 1}`)
    say(store, handle, 'assistant', 'zorbliquant noted')
    store.flags(handle.id, { archived: true })
    return handle.id
  })
  const index = new SessionSearchIndex(store)
  const ids = (page: { items: readonly { sessionId: string }[] }) => page.items.map((item) => item.sessionId)

  const dsh = index.search('zorbliquant')
  assert.deepEqual(
    [dsh.items.length, dsh.hasMore, ids(dsh).every((id) => archived.includes(id))],
    [20, true, true],
    'no view: DSH\'s answer, as before — the archived sessions fill the twenty and the visible one is cut',
  )
  assert.deepEqual(
    index.search('zorbliquant', { archived: 'hide' }),
    { items: [{ sessionId: visible.id, snippet: 'zorbliquant, and a few more words than the archived ones have' }], hasMore: false },
    'Hide archived: the visible session is the answer, and nothing more is hidden behind it',
  )
  const shown = index.search('zorbliquant', { archived: 'show' })
  assert.deepEqual([shown.items.length, shown.hasMore], [20, true], 'Show archived: every session is a row, so twenty of 22 and more')
  assert.deepEqual(ids(shown), ids(dsh), 'in DSH\'s order')
  const only = index.search('zorbliquant', { archived: 'only' })
  assert.deepEqual(
    [only.items.length, only.hasMore, ids(only).every((id) => archived.includes(id))],
    [20, true, true],
    'Archived only: twenty of the 21 archived, and more; never the visible one',
  )
})

test('#189: a view skips subagent children and blank sessions as the page does, and keeps a fork and a titled, pinned or archived zero-turn session', () => {
  const store = new SessionStore(join(scratch, 'store-189-rows'))
  const cwd = join(scratch, 'work-189-rows')
  const parent = store.create({ cwd })
  say(store, parent, 'user', 'plain note')
  say(store, parent, 'assistant', 'a kestrel ledger, the parent')
  /** A subagent's child: its row is its parent's, so it is never a hit of its own. */
  const child = store.create({ cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: 1 })
  say(store, child, 'user', 'delegated')
  say(store, child, 'assistant', 'kestrel ledger')
  /** A blank: an answer but no turn and no title, which the page never draws as a hit. */
  const blank = store.create({ cwd })
  say(store, blank, 'assistant', 'kestrel ledger')
  /** Zero turns as well, but a person titled, pinned or archived each: rows the page draws. */
  const titled = store.create({ cwd, title: 'named by a person' })
  say(store, titled, 'assistant', 'kestrel ledger, titled')
  const pinned = store.create({ cwd })
  say(store, pinned, 'assistant', 'kestrel ledger, pinned')
  store.flags(pinned.id, { pinned: true })
  const shelved = store.create({ cwd })
  say(store, shelved, 'assistant', 'kestrel ledger, archived')
  store.flags(shelved.id, { archived: true })
  /** A fork names its source as `parentSession` but has no `origin`: a conversation with a row of its own. */
  const fork = store.create({ cwd, parentSession: parent.id })
  say(store, fork, 'user', 'forked')
  say(store, fork, 'assistant', 'kestrel ledger, the fork')
  const index = new SessionSearchIndex(store)
  const found = (view?: { archived: 'hide' | 'show' | 'only' }) =>
    index
      .search('kestrel ledger', view)
      .items.map((item) => item.sessionId)
      .sort()
  const sorted = (...handles: { id: string }[]) => handles.map((handle) => handle.id).sort()

  assert.deepEqual(found(), sorted(parent, child, blank, titled, pinned, shelved, fork), 'no view: every session with a cwd, as DSH answers')
  assert.deepEqual(found({ archived: 'hide' }), sorted(parent, titled, pinned, fork), 'Hide archived: no child, no blank, no archived session')
  assert.deepEqual(found({ archived: 'show' }), sorted(parent, titled, pinned, shelved, fork), 'Show archived: the archived one joins; an archived session is no blank')
  assert.deepEqual(found({ archived: 'only' }), sorted(shelved), 'Archived only: the archived one alone')
})
