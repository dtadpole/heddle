import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, settle } from '../src/boot.ts'
import { startWebServer } from '../src/server/web.ts'
import { workspaceKey } from '../src/session/layout.ts'
import * as storeModule from '../src/session/store.ts'
import { logName, metaName, SessionStore, type SessionMeta } from '../src/session/store.ts'

/**
 * Hang 5 of issue #257, captured: the live TS server's event loop stood still in `SessionStore.list()`, called from
 * `TeamService.leadOf` by the `/api/team` route. Every open tab polls that route every 2 s for its session, and one
 * poll listed the whole store four times or more (`state` asks `leadOf` twice, `list` and `tasks` once each): about
 * 1,700 records read and 1,700 logs judged per scan, on a cold file cache three minutes after a restart.
 *
 * So a session's record is found by its id without listing the store (`metaById`), and `list()` keeps its answer
 * for a moment, so requests that list at once share one read of the store; a write through the store ends it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-list-memo-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const quiet = { warn: () => {} }
/** Read from the module, so the file loads on main, which has no memo: there the checks that need it fail alone. */
const LIST_MEMO_MS = (storeModule as { LIST_MEMO_MS?: number }).LIST_MEMO_MS ?? 1_000

/** How many times a store has read itself whole, which main's store did not count. */
function scansOf(store: SessionStore): number {
  const scans = (store as { listScans?: number }).listScans
  assert.equal(typeof scans, 'number', 'the store counts its whole reads (main has no count)')
  return scans as number
}

/** `metaById` when the store has it; main's answer was always the scan. */
function byId(store: SessionStore, id: string): SessionMeta | undefined {
  const lookup = (store as { metaById?: (id: string) => SessionMeta | undefined }).metaById
  assert.equal(typeof lookup, 'function', 'the store finds one record by its id')
  return lookup!.call(store, id)
}

/** `count` sessions copied from one written through the store, filed over `folders` workspaces. */
function seeded(root: string, count: number, folders: number): { store: SessionStore; ids: string[] } {
  const store = new SessionStore(root, quiet)
  const template = store.create({ cwd: join(scratch, 'template-work'), title: 'template' })
  store.message(template, { role: 'user', content: [{ type: 'text', text: 'a short question' }] })
  store.release(template)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `session-${randomUUID()}`
    const cwd = join(scratch, `work-${index % folders}`)
    const dir = join(root, workspaceKey(cwd))
    mkdirSync(dir, { recursive: true })
    copyFileSync(template.transcript, join(dir, logName(id)))
    const created = new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1_000).toISOString()
    writeFileSync(join(dir, metaName(id)), `${JSON.stringify({ id, created, cwd, title: `copy ${index}`, turns: 1 })}\n`)
    ids.push(id)
  }
  return { store: new SessionStore(root, quiet), ids }
}

test('lists that follow one another within the memo share one read of the store, and a write through any store over the root ends it (#257)', async () => {
  const { store, ids } = seeded(join(scratch, 'memo'), 40, 4)
  const before = scansOf(store)
  const first = store.list()
  const second = store.list()
  assert.equal(scansOf(store) - before, 1, 'two lists in a row read the store once')
  assert.deepEqual(second, first, 'and answer the same')
  ;(second[0] as { title?: string }).title = 'changed by a caller'
  assert.notEqual(store.list()[0]?.title, 'changed by a caller', 'a caller that changes what it was given changes nothing another reads')

  const target = store.open(ids[3]!)!
  store.flags(ids[3]!, { pinned: true })
  assert.equal(store.list().find((meta) => meta.id === ids[3])?.pinned, true, 'a write through this store shows at once')
  assert.equal(scansOf(store) - before, 2, 'because it ended the memo')

  /** Another store over the same root, in this process: its write ends this store's memo too. */
  const other = new SessionStore(store.root, quiet)
  other.rename(ids[5]!, 'renamed by another store')
  assert.equal(store.list().find((meta) => meta.id === ids[5])?.title, 'renamed by another store', 'a write through another store over the root shows at once')
  other.message(target, { role: 'user', content: [{ type: 'text', text: 'a prompt dates the row' }] })
  other.release(target)
  assert.equal(store.list().find((meta) => meta.id === ids[3])?.turns, 2, 'and so does the turn count a prompt writes')
  const created = other.create({ cwd: join(scratch, 'work-new') })
  other.release(created)
  assert.ok(store.list().some((meta) => meta.id === created.id), 'and a new session')

  /** Another process's write is not seen through the store: it shows once the memo has lived its life. */
  const settled = scansOf(store)
  const file = join(dirname(store.open(ids[7]!)!.meta), metaName(ids[7]!))
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), title: 'written by another process' })}\n`)
  store.list()
  assert.equal(scansOf(store), settled, 'within the memo the store is not read again')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, LIST_MEMO_MS + 50))
  assert.equal(store.list().find((meta) => meta.id === ids[7])?.title, 'written by another process', 'after it, the other process\'s write shows')
  assert.equal(byId(store, ids[7]!)?.title, 'written by another process', 'and a lookup by id reads the record itself, never the memo')
})

test('a lookup by id answers what list().find answers, without reading the whole store (#257)', () => {
  const root = join(scratch, 'lookup')
  const { store, ids } = seeded(root, 30, 3)
  const listed = store.list()
  const before = scansOf(store)
  for (const id of ids) assert.deepEqual(byId(store, id), listed.find((meta) => meta.id === id), `the record of ${id}`)
  assert.equal(byId(store, 'session-00000000-0000-0000-0000-000000000000'), undefined, 'an unknown id has no record')
  /** A record found in the old layout: a session's own directory with meta.json. */
  const legacyId = `session-${randomUUID()}`
  mkdirSync(join(root, legacyId), { recursive: true })
  writeFileSync(join(root, legacyId, 'meta.json'), `${JSON.stringify({ id: legacyId, created: '2026-09-01T00:00:00.000Z', cwd: scratch, turns: 0 })}\n`)
  assert.equal(byId(store, legacyId)?.id, legacyId, 'a session of the old layout is found')
  /** A session whose log is not a log is left out of the list (#130), and has no record by id either. */
  const broken = store.open(ids[4]!)!
  writeFileSync(broken.transcript, '{"not":"zstd"}\n')
  assert.equal(byId(store, ids[4]!), undefined, 'an unreadable log leaves its session out, as list() does')
  assert.equal(scansOf(store), before, 'and none of these lookups read the whole store')
  /** A record that moved (a fresh store has not seen it) is found where it now is. */
  const moved = store.open(ids[9]!)!
  const elsewhere = join(root, 'moved-folder')
  mkdirSync(elsewhere, { recursive: true })
  copyFileSync(moved.transcript, join(elsewhere, logName(ids[9]!)))
  writeFileSync(join(elsewhere, metaName(ids[9]!)), readFileSync(moved.meta))
  rmSync(moved.meta)
  rmSync(moved.transcript)
  assert.equal(byId(store, ids[9]!)?.id, ids[9], 'a record found again after it moved')
})

test('one /api/team poll over 2,000 sessions does not list the store (#257, hang 5)', async (context) => {
  const home = join(scratch, 'route')
  const root = join(home, 'sessions')
  mkdirSync(home, { recursive: true })
  const { ids } = seeded(root, 2_000, 40)
  process.env.HOME = home
  process.env.HEDDLE_HOME = join(home, 'heddle')
  process.env.HEDDLE_CONFIG = join(home, 'heddle.json')
  writeFileSync(join(home, 'script.json'), JSON.stringify({ steps: [{ text: 'answered' }] }))
  writeFileSync(
    process.env.HEDDLE_CONFIG,
    JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(home, 'script.json'), model: 'scripted' }] }),
  )
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const app = await boot({ base: join(repoRoot, 'cordis.yml'), includeProjectPatch: true, configDir: home, logLevel: 0, overrides: [{ patch: [{ id: 'session', config: { root } }] }] })
  await settle(app.ctx)
  const server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'list-memo-token', secretPath: join(home, 'secret') })
  try {
    const cookie = String((await fetch(server.url, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const store = app.ctx.session.store as SessionStore
    const original = store.list.bind(store)
    let lists = 0
    store.list = () => {
      lists += 1
      return original()
    }
    const poll = async (id: string): Promise<{ status: number; ms: number; body: { lead?: string } }> => {
      const started = performance.now()
      const response = await fetch(new URL(`/api/team?session=${id}`, server.url), { headers: { cookie } })
      const body = (await response.json()) as { lead?: string }
      return { status: response.status, ms: performance.now() - started, body }
    }
    const first = await poll(ids[17]!)
    assert.equal(first.status, 200, 'the poll is answered')
    assert.equal(first.body.lead, ids[17], 'a session with no team is its own lead')
    assert.equal(lists, 0, `one poll listed the store ${lists} times`)
    const times: number[] = []
    for (const id of ids.slice(100, 120)) {
      const answered = await poll(id)
      assert.equal(answered.status, 200)
      times.push(answered.ms)
    }
    assert.equal(lists, 0, `twenty polls listed the store ${lists} times`)
    times.sort((left, right) => left - right)
    const median = times[Math.floor(times.length / 2)]!
    context.diagnostic(`a poll over 2,000 sessions: median ${median.toFixed(1)} ms, slowest ${times.at(-1)!.toFixed(1)} ms (the HTTP round trip included)`)
    assert.ok(median < 50, `a poll took ${median.toFixed(1)} ms at the median`)
    store.list = original
  } finally {
    await server.close()
    await app.dispose()
  }
})
