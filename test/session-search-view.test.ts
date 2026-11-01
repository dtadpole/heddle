import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, settle } from '../src/boot.ts'
import { startWebServer, type WebServer } from '../src/server/web.ts'
import type { SessionHandle, SessionStore } from '../src/session/store.ts'

/**
 * `GET /api/sessions/search?archived=` (#189): the page's archive filter on the content search route.
 *
 * The page sends the filter it draws the tree with, and the route skips the sessions the page would not draw — subagent
 * children, blanks, archived ones per the filter — before it cuts its twenty, so a visible match is not pushed out by
 * hidden ones. Without the parameter the route answers as DSH's `session.search` does, every session with a `cwd`.
 * The parameter is read as `/api/tree` reads it: `only`, `show` (or `1`), anything else `hide`.
 *
 * The Rust route is judged the same way, on the same sessions, in heddle-server's
 * `content_search_finds_a_phrase_inside_an_answer`.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-search-view-')))
process.env.HOME = join(scratch, 'home')
process.env.HEDDLE_HOME = join(scratch, 'heddle')
process.env.HEDDLE_CONFIG = join(scratch, 'heddle.json')
mkdirSync(process.env.HOME, { recursive: true })
writeFileSync(join(scratch, 'script.json'), JSON.stringify({ steps: [{ text: 'ready' }] }))
writeFileSync(
  process.env.HEDDLE_CONFIG,
  JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(scratch, 'script.json'), model: 'scripted' }] }),
)

let app: Awaited<ReturnType<typeof boot>> | undefined
let server: WebServer | undefined
let cookie = ''

before(async () => {
  app = await boot({
    base: join(repoRoot, 'cordis.yml'),
    includeProjectPatch: true,
    configDir: scratch,
    logLevel: 0,
    overrides: [{ patch: [{ id: 'session', config: { root: join(scratch, 'sessions') } }] }],
  })
  await settle(app.ctx)
  server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'search-view-token', secretPath: join(scratch, 'secret') })
  const handshake = await fetch(server.url, { redirect: 'manual' })
  cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
})

after(async () => {
  await server?.close()
  await app?.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

function store(): SessionStore {
  assert.ok(app !== undefined, 'the app booted')
  return (app.ctx as unknown as { session: { store: SessionStore } }).session.store
}

async function search(query: string): Promise<{ status: number; body: { items: { sessionId: string; snippet: string }[]; hasMore: boolean } }> {
  assert.ok(server !== undefined, 'the server is up')
  const response = await fetch(new URL(`/api/sessions/search?${query}`, server.url), { headers: { cookie } })
  return { status: response.status, body: (await response.json()) as never }
}

const ids = (body: { items: { sessionId: string }[] }) => body.items.map((item) => item.sessionId)

function say(handle: SessionHandle, role: 'user' | 'assistant', text: string): void {
  store().message(handle, { role, content: [{ type: 'text', text }] })
}

test('the archive filter skips blanks and follows the filter; without it the answer is unchanged', async () => {
  /** Three sessions with an answer and no prompt — the Rust route test's — which the page draws as blanks. */
  const answered = (folder: string, text: string): string => {
    const handle = store().create({ cwd: join(scratch, folder) })
    say(handle, 'assistant', text)
    return handle.id
  }
  const one = answered('one', 'The quokka ledger is balanced.')
  const two = answered('two', 'A quokka ledger here, another QUOKKA LEDGER there.')
  answered('three', 'quokkaledger, or the quokka and its ledger.')

  const dsh = await search('q=Quokka%20Ledger')
  assert.equal(dsh.status, 200)
  assert.deepEqual(ids(dsh.body), [two, one], 'no filter: DSH\'s answer, blanks included, as before')
  assert.deepEqual(await search('q=Quokka%20Ledger&archived=hide'), { status: 200, body: { items: [], hasMore: false } }, 'the page draws no blank, so none is a hit')

  /** A title makes each a row; then the second is archived. */
  store().rename(one, 'the first')
  store().rename(two, 'the second')
  store().flags(two, { archived: true })
  for (const [filter, expected] of [
    ['hide', [one]],
    ['show', [two, one]],
    ['only', [two]],
    ['1', [two, one]],
    ['bogus', [one]],
    ['', [one]],
  ] as const) {
    const answer = await search(`q=Quokka%20Ledger&archived=${filter}`)
    assert.equal(answer.status, 200, filter)
    assert.deepEqual(ids(answer.body), expected, `archived=${filter}`)
  }
  assert.deepEqual(ids((await search('q=Quokka%20Ledger')).body), [two, one], 'and without it, still every session')
  assert.equal((await search('archived=hide')).status, 400, 'the query is still required')
})

test('J170: one visible match and 21 archived ones that outrank it — Hide archived finds the visible one', async () => {
  const cwd = join(scratch, 'crowd')
  const visible = store().create({ cwd })
  say(visible, 'user', 'plain note 0')
  say(visible, 'assistant', 'zorbliquant, and a few more words than the archived ones have')
  const archived: string[] = []
  for (let index = 1; index <= 21; index += 1) {
    const handle = store().create({ cwd })
    say(handle, 'user', `plain note ${index}`)
    say(handle, 'assistant', 'zorbliquant noted')
    store().flags(handle.id, { archived: true })
    archived.push(handle.id)
  }

  const dsh = (await search('q=zorbliquant')).body
  assert.deepEqual([dsh.items.length, dsh.hasMore, ids(dsh).includes(visible.id)], [20, true, false], 'no filter: the archived sessions fill the twenty, as before')
  assert.deepEqual(
    (await search('q=zorbliquant&archived=hide')).body,
    { items: [{ sessionId: visible.id, snippet: 'zorbliquant, and a few more words than the archived ones have' }], hasMore: false },
    'Hide archived: the visible session, and nothing more',
  )
  const shown = (await search('q=zorbliquant&archived=show')).body
  assert.deepEqual([shown.items.length, shown.hasMore], [20, true], 'Show archived: twenty of 22, and more')
  const only = (await search('q=zorbliquant&archived=only')).body
  assert.deepEqual([only.items.length, only.hasMore, ids(only).every((id) => archived.includes(id))], [20, true, true], 'Archived only: twenty of the 21')
})
