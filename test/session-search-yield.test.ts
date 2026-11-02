import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, test } from 'node:test'
import { createZstdCompress } from 'node:zlib'

import * as search from '../src/session/search.ts'
import { workspaceKey } from '../src/session/layout.ts'
import { logName, metaName, SessionStore, type SessionEvent, type SessionHandle } from '../src/session/store.ts'
import * as transcript from '../src/session/transcript.ts'
import { decodeTranscript, encodeFrame, splitFrames } from '../src/session/transcript.ts'

/**
 * Issue #257: the live TS server stopped answering for about 12 s and its supervisor killed it. Measured on scratch
 * servers, the cause is the first content search in a process: it decoded every session log on the event loop, one
 * zstd call per event frame, 12.9 s on a store the size of the live one and 34-76 s on one twice that.
 *
 * Judged here without a server: the first search over a store large enough to stall must leave the event loop free
 * between short slices and answer what reading every log whole answers; a log that grew is read from where the last
 * read stopped, and one rewritten or cut is read whole again; searches that arrive together share one read of the
 * store. The server-level check is in verifier 70 (`/healthz` while the first search runs).
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-search-yield-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const quiet = { warn: () => {} }
const WORDS = 'the quick brown fox jumps over lazy dog session server answer request stream listing folder tree record index token'.split(' ')
const word = (index: number): string => WORDS[(index * 7919) % WORDS.length]!

/** A session's documents as reading its whole log gives them: main's search, from the pieces it exports. */
function wholeRead(transcript: string): search.SearchDocument[] {
  try {
    return search.searchDocuments(decodeTranscript(readFileSync(transcript)).lines.map((line) => JSON.parse(line) as SessionEvent))
  } catch {
    return []
  }
}

/** The answer main's search gives: every listed session with a `cwd`, its log read whole, then ranked. */
function reference(store: SessionStore, query: string): search.SessionSearchPage {
  const corpus: { id: string; documents: search.PreparedDocument[] }[] = []
  for (const meta of store.list()) {
    if (typeof meta.cwd !== 'string' || meta.cwd.length === 0) continue
    const handle = store.open(meta.id)
    if (handle === null) continue
    corpus.push({ id: meta.id, documents: wholeRead(handle.transcript).map(search.prepareDocument) })
  }
  return search.rankSessions(corpus, search.normalizeSearchQuery(query))
}

/** A session that answered `answers` questions, each streamed as `deltas` text chunks. */
function answered(store: SessionStore, cwd: string, answers: number, deltas: number, title = 'answered'): SessionHandle {
  const handle = store.create({ cwd, title })
  for (let turn = 0; turn < answers; turn += 1) {
    store.message(handle, { role: 'user', content: [{ type: 'text', text: `question ${turn} about the ${word(turn)}` }] })
    store.append(handle, { type: 'model/request', endpoint: 'scripted', messages: turn * 2 + 1, tools: [] })
    for (let index = 0; index < deltas; index += 1) store.assistantChunk(handle, { type: 'text-delta', text: ` ${word(turn * deltas + index)}` })
    store.assistantChunk(handle, { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: deltas } })
    store.append(handle, { type: 'assistant/completed', text: 'x', finishReason: 'stop' })
    store.append(handle, { type: 'turn/completed' })
  }
  store.release(handle)
  return handle
}

/**
 * The large store: one answered session written through the store, copied under 120 more ids in six workspaces, as a
 * long-lived store holds many similar sessions; 25 of the copies then answer a line of their own. About 310,000 events,
 * which main's search read on the event loop in one go (measured: over 1 s here).
 */
const LARGE_COPIES = 120
let largeRoot: string | undefined
function largeStore(): string {
  if (largeRoot !== undefined) return largeRoot
  const root = join(scratch, 'large')
  const writer = new SessionStore(root, quiet)
  const template = answered(writer, join(scratch, 'large-template'), 10, 250, 'template')
  const cwds = Array.from({ length: 6 }, (_, index) => join(scratch, `large-ws-${index}`))
  const created = Date.parse('2026-10-22T00:00:00Z')
  const ids: string[] = []
  for (let index = 0; index < LARGE_COPIES; index += 1) {
    const id = `session-${randomUUID()}`
    const cwd = cwds[index % cwds.length]!
    const dir = join(root, workspaceKey(cwd))
    mkdirSync(dir, { recursive: true })
    copyFileSync(template.transcript, join(dir, logName(id)))
    writeFileSync(join(dir, metaName(id)), `${JSON.stringify({ id, created: new Date(created + index * 60_000).toISOString(), cwd, title: `copy ${index}`, turns: 10 })}\n`)
    ids.push(id)
  }
  for (const [index, id] of ids.slice(0, 25).entries()) {
    const handle = writer.open(id)!
    writer.message(handle, { role: 'assistant', content: [{ type: 'text', text: `the kestrel ledger, entry ${index}${' and more'.repeat(index)}` }] })
    writer.release(handle)
  }
  largeRoot = root
  return root
}

/** Main's answers over the large store as it was written, each computed once: a whole read of it takes a second or two. */
const pristine = new Map<string, search.SessionSearchPage>()
function largeReference(store: SessionStore, query: string): search.SessionSearchPage {
  let page = pristine.get(query)
  if (page === undefined) {
    page = reference(store, query)
    pristine.set(query, page)
  }
  return page
}

/** The longest gap between turns of the event loop while `run` runs, seen by a 5 ms timer. */
async function longestGap<T>(run: () => Promise<T>): Promise<{ value: T; gap: number; elapsed: number }> {
  let last = performance.now()
  let gap = 0
  const ticker = setInterval(() => {
    const now = performance.now()
    gap = Math.max(gap, now - last)
    last = now
  }, 5)
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    gap = 0
    last = performance.now()
    const started = performance.now()
    const value = await run()
    const elapsed = performance.now() - started
    /** A timer records a stall only when it next runs, so it gets a turn before the gap is read. */
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { value, gap, elapsed }
  } finally {
    clearInterval(ticker)
  }
}

/**
 * The search the server's route runs. Read from the module rather than imported by name, so the same test measured
 * main, whose route called the synchronous search.
 */
const serverSearch = (store: SessionStore, query: string): Promise<search.SessionSearchPage> => {
  const sliced = (search as { searchSessionsAsync?: (store: SessionStore, query: string) => Promise<search.SessionSearchPage> }).searchSessionsAsync
  return sliced !== undefined ? sliced(store, query) : Promise.resolve(search.searchSessions(store, query))
}

/** What an index read, which main's index did not say. */
function countsOf(index: search.SessionSearchIndex): search.SessionSearchCounts {
  const counts = (index as { counts?: search.SessionSearchCounts }).counts
  assert.ok(counts !== undefined, 'the index says what it read (main has no counts: it read every changed log whole)')
  return counts
}

const plain = (documents: readonly search.SearchDocument[] | undefined): unknown =>
  (documents ?? []).map(({ seq, type, time, text }) => ({ seq, type, time, text }))

test('the first search over a large store leaves the event loop free, and answers what reading every log whole answers (#257)', async (context) => {
  const root = largeStore()
  const store = new SessionStore(root, quiet)
  const first = await longestGap(() => serverSearch(store, 'kestrel ledger'))
  context.diagnostic(`first search: longest event-loop gap ${first.gap.toFixed(0)} ms, ${first.elapsed.toFixed(0)} ms in all`)
  /**
   * Main held the loop for the whole read (measured here: 1.2-2.0 s; on a live-sized store 12.9 s, which cost the
   * server its supervisor's three probes). Sliced, a gap is one slice of 20 ms plus the longest single step; the bound
   * leaves room for a machine running a whole suite.
   */
  assert.ok(first.gap < 150, `the event loop stood still for ${first.gap.toFixed(0)} ms during the first search (${first.elapsed.toFixed(0)} ms in all)`)
  const expected = largeReference(store, 'kestrel ledger')
  assert.equal(expected.items.length, 20, 'the query finds twenty of the twenty-five sessions that hold it')
  assert.equal(expected.hasMore, true)
  assert.deepEqual(first.value, expected, 'the answer is the one a whole read of every log gives, in its order and with its snippets')
  const second = await longestGap(() => serverSearch(store, 'question 3 about'))
  context.diagnostic(`second search: longest event-loop gap ${second.gap.toFixed(0)} ms, ${second.elapsed.toFixed(0)} ms in all`)
  assert.ok(second.gap < 150, `the event loop stood still for ${second.gap.toFixed(0)} ms during a second search`)
  assert.deepEqual(second.value, largeReference(store, 'question 3 about'), 'and so is the next one, from what the first read')
})

test('a grown log is read from where the last read stopped, and a rewritten or cut one is read whole (#257)', async () => {
  const store = new SessionStore(join(scratch, 'grow'), quiet)
  const grown = answered(store, join(scratch, 'grow-a'), 3, 100)
  answered(store, join(scratch, 'grow-b'), 1, 5)
  /** A longer log, copied over the grown one's file below to rewrite it in place. */
  const longer = answered(store, join(scratch, 'grow-c'), 4, 120)
  const index = new search.SessionSearchIndex(store)
  const counts = countsOf(index)
  const same = (label: string): void => assert.deepEqual(plain(index.documents(grown.id)), plain(wholeRead(grown.transcript)), label)

  await index.searchAsync('question')
  assert.equal(counts.wholeReads, 3, 'the first read reads every log whole')
  same('the documents are the whole read\'s')

  let frames = counts.frames
  store.message(grown, { role: 'assistant', content: [{ type: 'text', text: 'a fresh quokka sighting' }] })
  const found = await index.searchAsync('fresh quokka')
  assert.deepEqual(found.items.map((item) => item.sessionId), [grown.id], 'the appended answer is found')
  assert.equal(counts.frames - frames, 1, 'by decoding the one frame appended, not the log')
  assert.deepEqual([counts.wholeReads, counts.tailReads], [3, 1], 'read from where the last read stopped')
  same('and the documents are still the whole read\'s')

  /** A streamed answer that is still streaming at one search and finished at the next. */
  store.append(grown, { type: 'model/request', endpoint: 'scripted', messages: 9, tools: [] })
  store.assistantChunk(grown, { type: 'text-delta', text: 'Half an osp' })
  store.message(grown, { role: 'user', content: [{ type: 'text', text: 'a steer that lands mid-stream' }] })
  store.assistantChunk(grown, { type: 'text-delta', text: 'rey' })
  frames = counts.frames
  assert.deepEqual((await index.searchAsync('half an osp')).items.map((item) => item.sessionId), [grown.id], 'a run still streaming is searchable')
  assert.equal(counts.frames - frames, 4)
  same('mid-stream, with a message held for the step boundary')
  store.assistantChunk(grown, { type: 'text-delta', text: ' nest' })
  store.assistantChunk(grown, { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 3 } })
  store.append(grown, { type: 'assistant/completed', text: 'x', finishReason: 'stop' })
  store.append(grown, { type: 'turn/completed' })
  await index.searchAsync('osprey nest')
  same('and once the run settled')

  /** A replacement shadows what it replaces, as a compaction does. */
  const nodes = store.surface(grown).nodes
  store.append(grown, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'a summary of the heron' }] } }, { surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[4]! } })
  store.release(grown)
  await index.searchAsync('heron')
  same('a replaced span drops out')

  /** A torn tail is not read until its frame is whole; then only that frame is. */
  const next = store.count(grown)
  const frame = encodeFrame(`${JSON.stringify({ seq: next, at: new Date().toISOString(), type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'a torn egret' }] } })}\n`)
  appendFileSync(grown.transcript, frame.subarray(0, 9))
  frames = counts.frames
  assert.deepEqual((await index.searchAsync('torn egret')).items, [], 'half a frame is not read')
  assert.equal(counts.frames, frames)
  appendFileSync(grown.transcript, frame.subarray(9))
  assert.deepEqual((await index.searchAsync('torn egret')).items.map((item) => item.sessionId), [grown.id], 'the finished frame is')
  assert.equal(counts.frames - frames, 1)
  same('after the torn tail was finished')

  /** Cut back to an earlier frame: shorter than what was read, so read whole. */
  const wholeBefore = counts.wholeReads
  const cut = splitFrames(readFileSync(grown.transcript))[200]!.end
  truncateSync(grown.transcript, cut)
  await index.searchAsync('question')
  assert.equal(counts.wholeReads - wholeBefore, 1, 'a log shorter than what was read is read whole')
  same('and gives the whole read\'s documents')

  /** Rewritten in place with another log, longer, whose head differs: read whole. */
  writeFileSync(grown.transcript, readFileSync(longer.transcript))
  await index.searchAsync('question')
  assert.equal(counts.wholeReads - wholeBefore, 2, 'a log whose head changed is read whole')
  same('and gives the whole read\'s documents')
  frames = counts.frames
  appendFileSync(grown.transcript, encodeFrame(`${JSON.stringify({ seq: store.count(longer), at: new Date().toISOString(), type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'a curlew' }] } })}\n`))
  assert.deepEqual((await index.searchAsync('curlew')).items.map((item) => item.sessionId), [grown.id], 'and the rewritten log is followed again from its end')
  assert.deepEqual([counts.frames - frames, counts.wholeReads - wholeBefore], [1, 2])

  /** A frame whose seq does not grow is not a log the follow can trust: read whole, as main read it. */
  const seqs = decodeTranscript(readFileSync(grown.transcript)).lines.map((line) => (JSON.parse(line) as SessionEvent).seq)
  appendFileSync(grown.transcript, encodeFrame(`${JSON.stringify({ seq: seqs[3], at: new Date().toISOString(), type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'a duplicate plover' }] } })}\n`))
  await index.searchAsync('plover')
  same('a seq written twice')
})

test('read as it grows, a log gives the documents a whole read gives, over random logs (#257)', async () => {
  /**
   * Random logs written through the store: prompts, streamed runs with reasoning and tool calls, tool results,
   * messages that land mid-stream and are held, notes, failed runs, and replacements over random spans. After every
   * batch each log's documents must equal the whole read's.
   */
  let seed = 257
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const store = new SessionStore(join(scratch, 'random'), quiet)
  const sessions = Array.from({ length: 8 }, (_, index) => ({ handle: store.create({ cwd: join(scratch, `random-${index}`) }), open: false, calls: [] as string[] }))
  const index = new search.SessionSearchIndex(store)
  const text = (): string => Array.from({ length: 1 + random(4) }, () => word(random(1000))).join(' ')
  for (let batch = 0; batch < 80; batch += 1) {
    for (const session of sessions) {
      const { handle } = session
      for (let step = random(10); step > 0; step -= 1) {
        const pick = random(13)
        if (pick === 0) store.message(handle, { role: 'user', content: [{ type: 'text', text: text() }] })
        else if (pick === 1) {
          store.append(handle, { type: 'model/request', endpoint: 'scripted', messages: 1, tools: [] })
          session.open = true
        } else if (pick <= 4) {
          store.assistantChunk(handle, { type: 'text-delta', text: ` ${text()}` })
          session.open = true
        } else if (pick === 5) store.assistantChunk(handle, { type: 'reasoning-delta', text: text() })
        else if (pick === 6) {
          const id = `call-${batch}-${step}`
          store.assistantChunk(handle, { type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command: text() }) })
          session.calls.push(id)
        } else if (pick === 7) {
          store.assistantChunk(handle, { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })
          session.open = false
        } else if (pick === 8 && session.calls.length > 0) {
          store.message(handle, { role: 'tool', toolCallId: session.calls.shift()!, content: [{ type: 'text', text: text() }] })
        } else if (pick === 9) store.append(handle, { type: 'context/note', message: { role: 'user', content: [{ type: 'text', text: text() }] } })
        else if (pick === 10) {
          store.append(handle, { type: 'turn/completed' })
          session.open = false
          session.calls = []
        } else if (pick === 11) store.message(handle, { role: 'assistant', content: [{ type: 'text', text: text() }] })
        else {
          const nodes = store.surface(handle).nodes
          if (nodes.length < 2) continue
          const start = random(nodes.length)
          const end = start + random(nodes.length - start)
          store.append(
            handle,
            { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `summary ${text()}` }] } },
            { surfaceOp: { op: 'replace', startSeq: nodes[start]!, endSeq: nodes[end]! } },
          )
        }
      }
    }
    if (batch % 2 === 0) index.search('quick')
    else await index.searchAsync('quick')
    for (const session of sessions) {
      assert.deepEqual(plain(index.documents(session.handle.id)), plain(wholeRead(session.handle.transcript)), `session ${session.handle.id} after batch ${batch}`)
    }
  }
  const counts = countsOf(index)
  assert.equal(counts.wholeReads, sessions.length, 'every log was read whole once, and only from where it stopped after that')
  for (const session of sessions) store.release(session.handle)
})

test('searches that arrive together share one build, and one that arrives during a build waits for the next (#257)', async () => {
  const root = largeStore()
  const store = new SessionStore(root, quiet)
  const sessions = store.list().length
  const index = new search.SessionSearchIndex(store)
  const counts = countsOf(index)
  const [first, second] = await Promise.all([index.searchAsync('kestrel ledger'), index.searchAsync('question 3 about')])
  assert.equal(counts.builds, 1, 'two searches that arrived together started one build')
  assert.equal(counts.wholeReads, sessions, 'which read each log once')
  assert.deepEqual(first, largeReference(store, 'kestrel ledger'))
  assert.deepEqual(second, largeReference(store, 'question 3 about'))

  /**
   * A build reads the newest session first. Once it has passed that one, the session answers again: a search that
   * arrives now must see the answer, so it waits for the build after this one, which every search arriving meanwhile
   * shares and which reads only what changed.
   */
  const fresh = new SessionStore(root, quiet)
  const later = new search.SessionSearchIndex(fresh)
  const laterCounts = countsOf(later)
  const early = later.searchAsync('kestrel ledger')
  while (laterCounts.wholeReads < 5) await new Promise((resolve) => setImmediate(resolve))
  const newest = fresh.list()[0]!
  const handle = fresh.open(newest.id)!
  fresh.message(handle, { role: 'assistant', content: [{ type: 'text', text: 'a heron arrived late' }] })
  fresh.release(handle)
  const [, heron, again] = await Promise.all([early, later.searchAsync('heron arrived'), later.searchAsync('kestrel ledger')])
  assert.equal(laterCounts.builds, 2, 'the two searches that arrived during the build shared the one after it')
  assert.deepEqual(heron.items.map((item) => item.sessionId), [newest.id], 'which saw the answer written after the first build had read that log')
  assert.deepEqual(again, reference(fresh, 'kestrel ledger'))
  assert.deepEqual([laterCounts.wholeReads, laterCounts.tailReads], [sessions, 1], 'and read only the one log that grew, from where it stopped')
})

test('a stopped index ends its build at the next pause, and a later search builds again (#257)', async () => {
  const store = new SessionStore(largeStore(), quiet)
  const index = new search.SessionSearchIndex(store)
  const counts = countsOf(index)
  const pending = index.searchAsync('kestrel ledger')
  while (counts.wholeReads < 3) await new Promise((resolve) => setImmediate(resolve))
  index.stop()
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'SessionSearchStopped', 'the search under way is refused')
  assert.ok(counts.wholeReads < store.list().length, `the build stopped part-way (${counts.wholeReads} logs read)`)
  assert.deepEqual(await index.searchAsync('kestrel ledger'), reference(store, 'kestrel ledger'), 'and the next search answers in full')
})

test('a read-only frame decode sizes its buffer to the frame, and reads exactly what a whole read reads (#257)', async () => {
  /** Read from the module, so the file loads on main, which has none of the three: there this test fails alone. */
  const { decodeFrameSized, frameContentSize, readFrames } = transcript
  assert.ok([decodeFrameSized, frameContentSize, readFrames].every((one) => typeof one === 'function'), 'the transcript module has a read-only, sized frame reader')
  const lines = ['{"seq":0}', `{"seq":1,"text":"${'x'.repeat(70_000)}"}`, '{"seq":2}']
  const frames = lines.map((line) => encodeFrame(`${line}\n`))
  assert.equal(frameContentSize(frames[0]!, 0), lines[0]!.length + 1, 'the store\'s frames declare their size')
  assert.equal(decodeFrameSized(frames[1]!, 0, frames[1]!.length), `${lines[1]}\n`, 'a frame larger than its first guess still decodes whole')
  /** A streaming compressor declares no content size: the read guesses from the frame, and zlib grows the buffer. */
  const stream = createZstdCompress()
  const parts: Buffer[] = []
  stream.on('data', (chunk: Buffer) => parts.push(chunk))
  const ended = new Promise<void>((resolve) => stream.on('end', () => resolve()))
  stream.end(Buffer.from(`{"seq":3,"text":"${'y'.repeat(50_000)}"}\n`))
  await ended
  const streamed = Buffer.concat(parts)
  assert.equal(frameContentSize(streamed, 0), undefined)
  const log = Buffer.concat([...frames, streamed])
  const read = [...readFrames(log)].flatMap((frame) => frame.lines)
  assert.deepEqual(read, decodeTranscript(log).lines, 'every frame, the same lines')
  for (let cut = 0; cut <= log.length; cut += 997) {
    const part = log.subarray(0, cut)
    const walked = [...readFrames(part)]
    assert.deepEqual(walked.flatMap((frame) => frame.lines), decodeTranscript(part).lines, `a log cut at ${cut} reads the same prefix`)
    assert.equal(walked.at(-1)?.end ?? 0, decodeTranscript(part).readableBytes, 'and stops where a whole read stops')
  }
  const corrupt = Buffer.from(log)
  corrupt[frames[0]!.length + 12] = (corrupt[frames[0]!.length + 12] ?? 0) ^ 0xff
  assert.deepEqual([...readFrames(corrupt)].flatMap((frame) => frame.lines), decodeTranscript(corrupt).lines, 'a frame that does not decode ends the read, as it ends a whole read')
})
