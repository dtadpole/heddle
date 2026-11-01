import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { boot, settle } from '../src/boot.ts'
import { startWebServer } from '../src/server/web.ts'
import type { SessionMeta } from '../src/session/store.ts'
import { unreadableRegistryLine, WorkspaceRegistryUnreadable, WorkspaceService } from '../src/workspace/service.ts'

/**
 * A workspace list whose file cannot be read is refused, never read as no workspaces (GitHub issue #196).
 *
 * Measured before (developer-six, J176): one trailing comma in `$HEDDLE_HOME/workspaces.json`, or the empty file a failed
 * in-place write leaves, read as an empty list on both builds; the next turn wrote `[that folder, auto]` over it, and a
 * restart rebuilt it from the sessions alone and wrote at once. Every registration, title and order was lost, and nothing
 * said so. J176b: a file the server may not read (mode 000) or a folder at its path listed nothing too.
 *
 * DSH fails closed: a stored record that does not match its schema is `invalid-record` (dsh-storage-domain
 * lib/index.js:419-433), a file that is not JSON is `malformed-medium` (dsh-storage-json lib/index.js:91-98), and moving
 * a bad document aside is opt-in (`invalidRecords: 'backup-and-skip'`, dsh-storage-domain lib/index.js:69-72), which the
 * workspace domain does not take (dsh-workspace lib/index.js:255-268). So reads throw, writes are refused, the start
 * rebuilds nothing, one line names the file, and a missing file is still the empty list of a fresh home. The reasons are
 * the Rust build's word for word (`rust/crates/heddle-workspace/src/service.rs`, the same table).
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-registry-unreadable-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function service(): { workspaces: WorkspaceService; lines: string[] } {
  counter += 1
  const dir = join(scratch, `home-${counter}`)
  mkdirSync(dir, { recursive: true })
  const workspaces = new WorkspaceService(new Context(), { file: join(dir, 'workspaces.json') })
  const lines: string[] = []
  workspaces.warn = (line) => void lines.push(line)
  return { workspaces, lines }
}

function folder(name: string): string {
  const path = join(scratch, `folder-${counter}-${name}`)
  mkdirSync(path, { recursive: true })
  return path
}

function session(id: string, cwd: string): SessionMeta {
  return { id, created: new Date().toISOString(), cwd, turns: 1 }
}

/** J176's setup: four registered, one renamed, one moved. */
function fourRegistered(workspaces: WorkspaceService): string[] {
  const ids = ['w1', 'w2', 'w3', 'w4'].map((name) => workspaces.add(folder(name)).record.id)
  workspaces.rename(ids[1]!, 'Second (renamed)')
  workspaces.reorder(ids[2]!, ids[0])
  return ids
}

/** Every write the service offers, each of which must be refused over an unreadable file. */
function everyWrite(workspaces: WorkspaceService, ids: readonly string[]): Array<[string, () => unknown]> {
  const fresh = folder('fresh')
  return [
    ['add', () => workspaces.add(fresh)],
    ['ensureOwner (a turn adopting its folder)', () => workspaces.ensureOwner(fresh)],
    ['rename', () => workspaces.rename(ids[0] ?? 'w-1', 'Another title')],
    ['remove', () => workspaces.remove(ids[0] ?? 'w-1', { all: [], force: true })],
    ['reorder', () => workspaces.reorder(ids[0] ?? 'w-1')],
    ['initializeDefault', () => workspaces.initializeDefault([], join(scratch, `default-${counter}`))],
  ]
}

const unreadable = (reason: string) => ({
  name: 'WorkspaceRegistryUnreadable',
  code: 'workspace/registry-unreadable',
  message: `the workspace list could not be read: workspaces.json: ${reason}`,
  reason,
})

test('a missing file is the empty list of a fresh home, says nothing, and the first write creates it', () => {
  const { workspaces, lines } = service()
  assert.deepEqual(workspaces.list(), [])
  assert.deepEqual(workspaces.views([]), [])
  workspaces.check()
  const { record, created } = workspaces.add(folder('first'))
  assert.equal(created, true)
  assert.deepEqual(workspaces.list().map((entry) => entry.id), [record.id])
  assert.deepEqual(lines, [], 'a fresh home is not a damage')
})

test('a trailing comma: every read is refused with the file and the reason, and no write lands over it (J176)', () => {
  const { workspaces, lines } = service()
  const ids = fourRegistered(workspaces)
  const good = readFileSync(workspaces.file, 'utf8')
  const damaged = good.replace('"version": 3,', '"version": 3,,')
  assert.notEqual(damaged, good)
  writeFileSync(workspaces.file, damaged)
  const before = statSync(workspaces.file)
  const reason = 'not valid JSON'

  for (const [what, read] of [
    ['list', () => workspaces.list()],
    ['views', () => workspaces.views([])],
    ['find', () => workspaces.find(ids[0]!)],
    ['owner', () => workspaces.owner(folder('w1'))],
    ['check', () => workspaces.check()],
  ] as Array<[string, () => unknown]>) {
    assert.throws(read, unreadable(reason), `${what} answers the error, not an empty list`)
  }
  for (const [what, write] of everyWrite(workspaces, ids)) {
    assert.throws(write, WorkspaceRegistryUnreadable, `${what} is refused`)
  }
  const report = workspaces.bootstrap([session('session-1', folder('w1')), session('session-2', folder('elsewhere'))])
  assert.equal(report.skipped, true, 'the start rebuilds nothing from the sessions')
  assert.equal(readFileSync(workspaces.file, 'utf8'), damaged, 'the damaged file is byte for byte what it was')
  assert.equal(statSync(workspaces.file).mtimeMs, before.mtimeMs, 'and was not written at all')
  assert.equal(lines.length, 1, `one line, however often it is read\n${lines.join('\n')}`)
  assert.ok(lines[0]!.startsWith(`heddle workspace: unreadable workspace list ${workspaces.file}: not valid JSON (`), lines[0])
  assert.match(lines[0]!, /line 2 column 16/, 'the parser says where, in the server\'s line')
  assert.ok(lines[0]!.endsWith('; it is left as it is, and every workspace change is refused until it reads'), lines[0])

  writeFileSync(workspaces.file, good)
  assert.deepEqual(workspaces.list().map((record) => record.id), [ids[3], ids[1], ids[2], ids[0]], 'the comma fixed, all four are back in their order')
  assert.equal(workspaces.find(ids[1]!)!.title, 'Second (renamed)', 'with the title a person gave')
  writeFileSync(workspaces.file, '')
  assert.throws(() => workspaces.list(), unreadable('the file is empty'))
  assert.equal(lines.length, 2, 'a damage after a good read is named again')
})

test('an empty file (what a failed truncate-then-write left) is refused, and the start writes nothing over it', () => {
  for (const text of ['', ' \n\t\n']) {
    const { workspaces, lines } = service()
    writeFileSync(workspaces.file, text)
    assert.throws(() => workspaces.list(), unreadable('the file is empty'))
    const report = workspaces.bootstrap([session('session-1', folder('w1')), session('session-2', folder('w2'))])
    assert.deepEqual(report, { workspaces: 0, attached: 0, created: 0, skipped: true })
    for (const [what, write] of everyWrite(workspaces, [])) {
      assert.throws(write, unreadable('the file is empty'), `${what} is refused`)
    }
    assert.equal(readFileSync(workspaces.file, 'utf8'), text, 'the file is left as it was')
    assert.deepEqual(lines, [unreadableRegistryLine(workspaces.file, 'the file is empty')])
  }
})

/** The same table as the Rust service's test, so both builds give the same reason for the same bytes. */
const REASONS: Array<[string, string | Buffer, string]> = [
  ['an empty file', '', 'the file is empty'],
  ['whitespace', '  \n', 'the file is empty'],
  ['a doubled comma', '{\n  "version": 3,,\n  "workspaceIds": []\n}\n', 'not valid JSON'],
  ['a trailing comma', '{\n  "version": 3,\n  "workspaceIds": [],\n}\n', 'not valid JSON'],
  ['a cut file', '{\n  "version": 3,\n  "workspaceIds": [\n    "w-1"', 'not valid JSON'],
  ['text after the JSON', '{}\nx', 'not valid JSON'],
  ['a word', 'workspaces', 'not valid JSON'],
  ['an array', '[]', 'not a workspace list: it is not a JSON object'],
  ['null', 'null', 'not a workspace list: it is not a JSON object'],
  ['ids that are not a list', '{"workspaceIds": "w-1"}', 'not a workspace list: "workspaceIds" is not a list of ids'],
  ['an id that is not a string', '{"workspaceIds": [1]}', 'not a workspace list: "workspaceIds" is not a list of ids'],
  ['records that are not an object', '{"workspaces": []}', 'not a workspace list: "workspaces" is not an object'],
  ['a record without a title', '{"workspaceIds": ["w-1"], "workspaces": {"w-1": {"path": "/a"}}}', 'not a workspace list: workspace "w-1" needs a path and a title'],
  ['a record that is not an object', '{"workspaces": {"w-1": "/a"}}', 'not a workspace list: workspace "w-1" needs a path and a title'],
  ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), 'not UTF-8 text'],
  ['a byte-order mark before the JSON', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'not valid JSON'],
]

test('each kind of damage has one reason, the Rust build\'s words', () => {
  for (const [what, bytes, reason] of REASONS) {
    const { workspaces } = service()
    writeFileSync(workspaces.file, bytes)
    assert.throws(() => workspaces.list(), unreadable(reason), what)
  }
})

test('what a version-1 or hand-made file may leave out still reads with its defaults', () => {
  for (const text of ['{}', '{"version": 3}', '{"workspaceIds": []}', '{"workspaces": {}}', '{"version":1,"workspaceIds":["w-1"],"workspaces":{"w-1":{"path":"/work/one","title":"one","sessionIds":["s"]}}}']) {
    const { workspaces, lines } = service()
    writeFileSync(workspaces.file, text)
    assert.doesNotThrow(() => workspaces.list(), text)
    assert.deepEqual(lines, [], text)
  }
})

test('a file the server may not read, or a folder where the file should be, is refused with a reason and no path (J176b)', (context) => {
  const asFolder = service()
  mkdirSync(asFolder.workspaces.file)
  assert.throws(() => asFolder.workspaces.list(), unreadable('it is a folder, not a file'))
  assert.throws(() => asFolder.workspaces.add(folder('w5')), WorkspaceRegistryUnreadable)
  assert.ok(statSync(asFolder.workspaces.file).isDirectory(), 'the folder is still a folder')

  const denied = service()
  fourRegistered(denied.workspaces)
  const good = readFileSync(denied.workspaces.file)
  chmodSync(denied.workspaces.file, 0)
  try {
    try {
      readFileSync(denied.workspaces.file)
      context.skip('this host reads mode 000 (root): a permission refusal is unjudged here')
      return
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'EACCES')
    }
    assert.throws(() => denied.workspaces.list(), unreadable('permission denied'))
    for (const [what, write] of everyWrite(denied.workspaces, [])) {
      assert.throws(write, WorkspaceRegistryUnreadable, `${what} is refused`)
    }
    try {
      denied.workspaces.list()
    } catch (error) {
      assert.ok(!(error as Error).message.includes(scratch), 'the error names the file, never its folder')
    }
  } finally {
    chmodSync(denied.workspaces.file, 0o600)
  }
  assert.ok(readFileSync(denied.workspaces.file).equals(good), 'the file is byte for byte what it was')
  assert.equal(denied.workspaces.list().length, 4)
})

test('a write replaces the file whole through a temporary file beside it, and a write that fails leaves the old file', (context) => {
  const { workspaces } = service()
  workspaces.add(folder('one'))
  const first = statSync(workspaces.file)
  workspaces.add(folder('two'))
  const second = statSync(workspaces.file)
  assert.notEqual(second.ino, first.ino, 'a new file renamed over the old one, not the old one truncated and rewritten')
  const home = join(workspaces.file, '..')
  assert.deepEqual(readdirSync(home).filter((name) => name !== 'workspaces.json'), [], 'and nothing is left beside it')

  const kept = readFileSync(workspaces.file)
  chmodSync(home, 0o500)
  try {
    try {
      writeFileSync(join(home, 'probe'), '')
      context.skip('this host writes into a read-only folder (root): a failed write is unjudged here')
      return
    } catch {
      // the folder refuses a new file, as a full disk would
    }
    assert.throws(() => workspaces.add(folder('three')), { code: 'EACCES' })
  } finally {
    chmodSync(home, 0o700)
  }
  assert.ok(readFileSync(workspaces.file).equals(kept), 'the failed write left the old list whole, never an empty file')
  assert.deepEqual(readdirSync(home).filter((name) => name !== 'workspaces.json'), [], 'and no temporary file')
  assert.equal(workspaces.list().length, 2)
})

/**
 * The routes (#196): every route that reads or writes the list answers `500 {error, code: 'workspace/registry-unreadable'}`
 * with the file's name and the reason; a turn that names a folder is refused before a session is opened; a turn that names
 * only a session reads no list and runs; the file is untouched, and the server's line is printed once.
 */
test('the routes answer the error, a turn naming a folder is refused before anything is written, and the file is untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heddle-registry-routes-'))
  const work = join(root, 'w1')
  const other = join(root, 'w5')
  mkdirSync(work)
  mkdirSync(other)
  const file = join(root, 'home', 'workspaces.json')
  const previous = { HEDDLE_HOME: process.env.HEDDLE_HOME, HEDDLE_CONFIG: process.env.HEDDLE_CONFIG }
  let app: Awaited<ReturnType<typeof boot>> | undefined
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  try {
    process.env.HEDDLE_HOME = join(root, 'home')
    process.env.HEDDLE_CONFIG = join(root, 'config.json')
    writeFileSync(join(root, 'script.json'), JSON.stringify({ steps: [{ text: 'answered' }, { text: 'answered again' }, { text: 'and again' }, { text: 'once more' }] }))
    writeFileSync(process.env.HEDDLE_CONFIG, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(root, 'script.json'), model: 'scripted' }] }))
    app = await boot({
      base: resolve('cordis.yml'),
      includeProjectPatch: true,
      configDir: root,
      logLevel: 0,
      overrides: [{ patch: [{ id: 'session', config: { root: join(root, 'sessions') } }, { id: 'workspace', config: { file, generated: ['dist'] } }] }],
    })
    await settle(app.ctx)
    const workspaces = app.ctx.workspace!
    const lines: string[] = []
    workspaces.warn = (line) => void lines.push(line)
    server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'registry-check-token', secretPath: join(root, 'secret') })
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(new URL(path, server!.url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
      return { status: response.status, text: await response.text() }
    }
    const post = (path: string, body: unknown, method = 'POST') => call(path, { method, body: JSON.stringify(body) })

    const id = JSON.parse((await post('/api/workspaces', { path: work })).text).record.id as string
    const first = await post('/api/turn', { folder: work, new: true, prompt: 'hello' })
    assert.equal(first.status, 200, first.text)
    const sessionId = app.ctx.session.list()[0]!.id
    const sessions = app.ctx.session.list().length

    const damaged = readFileSync(file, 'utf8').replace('"version": 3,', '"version": 3,,')
    writeFileSync(file, damaged)
    const expected = { error: 'the workspace list could not be read: workspaces.json: not valid JSON', code: 'workspace/registry-unreadable' }
    for (const [what, answer] of [
      ['GET /api/workspaces', () => call('/api/workspaces')],
      ['GET /api/tree', () => call('/api/tree')],
      ['GET /api/tree?path=', () => call(`/api/tree?path=${encodeURIComponent(work)}`)],
      ['POST /api/workspaces', () => post('/api/workspaces', { path: other })],
      ['PATCH /api/workspaces/:id', () => post(`/api/workspaces/${id}`, { title: 'Renamed' }, 'PATCH')],
      ['DELETE /api/workspaces/:id', () => call(`/api/workspaces/${id}`, { method: 'DELETE' })],
      ['POST /api/workspaces/insertBefore', () => post('/api/workspaces/insertBefore', { workspaceId: id })],
      ['POST /api/workspaces/default', () => call('/api/workspaces/default', { method: 'POST' })],
      ['POST /api/sessions', () => post('/api/sessions', { branch: work })],
      ['a turn in a known folder', () => post('/api/turn', { folder: work, prompt: 'again' })],
      ['a new turn in a known folder', () => post('/api/turn', { folder: work, new: true, prompt: 'again' })],
      ['a turn in a new folder', () => post('/api/turn', { folder: other, new: true, prompt: 'again' })],
    ] as Array<[string, () => Promise<{ status: number; text: string }>]>) {
      const { status, text } = await answer()
      assert.equal(status, 500, `${what}: ${text}`)
      assert.deepEqual(JSON.parse(text), expected, what)
      assert.ok(!text.includes(root), `${what} names the file, not its folder`)
    }
    assert.equal(app.ctx.session.list().length, sessions, 'no refused turn opened or created a session')
    const resumed = await post('/api/turn', { session: sessionId, prompt: 'continue' })
    assert.equal(resumed.status, 200, `a turn naming only its session reads no list and runs: ${resumed.text}`)
    assert.equal(readFileSync(file, 'utf8'), damaged, 'the damaged file is byte for byte what it was')
    assert.equal(lines.length, 1, `one server line\n${lines.join('\n')}`)
    assert.ok(lines[0]!.startsWith(`heddle workspace: unreadable workspace list ${file}: not valid JSON (`), lines[0])

    writeFileSync(file, damaged.replace('"version": 3,,', '"version": 3,'))
    const listed = await call('/api/workspaces')
    assert.equal(listed.status, 200, listed.text)
    assert.deepEqual(JSON.parse(listed.text).workspaces.map((view: { id: string }) => view.id), [id], 'fixed, the list is back as it was')
  } finally {
    await server?.close()
    await app?.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
