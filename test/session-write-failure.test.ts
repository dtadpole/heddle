import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * A rename, pin or archive the session store cannot save (GitHub issue #149).
 *
 * With the store read-only, as a full disk or a permission mistake leaves it, the routes the tree's Rename, Pin and
 * Archive call answered Node's raw error as `500 internal error: EACCES: permission denied, open '<absolute path into the
 * store>'` (and the Rust build a rename `404 no session`, a pin `409 code: "archived"`). DSH reports a storage fault as
 * `gateway/internal` (dsh-api-session-controller lib/index.js:839, dsh-api-gateway lib/index.js:1673-1690), so both builds
 * answer it `500 { error: 'failed to <verb> session "<id>": <reason>', code: 'gateway/internal' }`, the reason in words
 * and never the store's path. The store is made read-only the way the issue does it, `chmod -R a-w` on the session root.
 *
 * Creating a session failed the same raw way (J180): New session in a workspace whose store folder is at mode 000 answered
 * `500 internal error: EACCES … '<absolute store path>/session-<id>.json'` here and a `400` with the path in the Rust build.
 * Both answer it `500 { error: 'failed to create session: <reason>', code: 'gateway/internal' }`, DSH's `rejectCreation`
 * (dsh-api-session-controller lib/index.js:1085), on every route that creates one.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-write-failure-')))
const sessionRoot = join(scratch, 'sessions')
after(() => {
  try {
    writable(sessionRoot, true)
  } catch {}
  rmSync(scratch, { recursive: true, force: true })
})

const script = join(scratch, 'script.json')
const config = join(scratch, 'heddle.json')
writeFileSync(config, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' }] }))
writeFileSync(script, JSON.stringify({ steps: [{ text: 'an answer' }] }))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
const env = { ...process.env, HOME: scratch, HEDDLE_HOME: scratch, HEDDLE_CONFIG: config, NO_COLOR: '1' }
/** Root ignores a read-only folder, so the failure cannot be made there. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** `chmod -R a-w` (or back to writable) over a tree. */
function writable(path: string, on: boolean): void {
  const stat = statSync(path)
  if (stat.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name), on)
  chmodSync(path, stat.isDirectory() ? (on ? 0o755 : 0o555) : on ? 0o644 : 0o444)
}

/** `src/cli.ts web` on a free port, resolved once it prints its URL. */
function startServer(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'src', 'cli.ts'), 'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', sessionRoot],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the server printed no URL within 30s\n${output}`))
    }, 30_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolvePromise({ url: match[1], child })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
    })
  })
}

test('a write the store cannot save is reasoned in words, never with a path, and a refusal is not one', async () => {
  const failure = await import('../src/session/write-failure.ts')
  const errno = (code: string) => Object.assign(new Error(`${code}: something, open '/home/someone/.heddle/sessions/x.json'`), { code, syscall: 'open', path: '/home/someone/.heddle/sessions/x.json' })
  assert.equal(failure.writeFailureReason(errno('EACCES')), 'permission denied')
  assert.equal(failure.writeFailureReason(errno('EPERM')), 'permission denied', 'EPERM reads as #106 reads it, and as Rust folds it')
  assert.equal(failure.writeFailureReason(errno('EROFS')), 'read-only file system')
  assert.equal(failure.writeFailureReason(errno('ENOSPC')), 'no space left on device')
  assert.equal(failure.writeFailureReason(errno('EIO')), 'the session store could not be written', 'any other file-system failure')
  assert.equal(failure.writeFailureReason(Object.assign(new Error('session x is archived and cannot be pinned'), { code: 'archived' })), undefined, 'a refusal carries a code, but no syscall')
  assert.equal(failure.writeFailureReason(new Error('plain')), undefined)
  assert.equal(failure.writeFailureReason(undefined), undefined)

  const written = failure.storeWriteFailure('rename', 'session-00000000-0000-0000-0000-000000000001', errno('EACCES'))
  assert.ok(written instanceof failure.SessionWriteError)
  assert.equal(written.message, 'failed to rename session "session-00000000-0000-0000-0000-000000000001": permission denied', "DSH's rename sentence")
  assert.equal(written.code, 'gateway/internal', "and DSH's code")
  assert.equal(written.name, 'SessionWriteError')
  assert.equal(failure.storeWriteFailure('pin', 'session-x', new Error('plain')), undefined, 'what is not a write failure is not dressed as one')

  assert.equal(failure.flagVerb({ pinned: true }), 'pin')
  assert.equal(failure.flagVerb({ pinned: false }), 'unpin')
  assert.equal(failure.flagVerb({ archived: true }), 'archive')
  assert.equal(failure.flagVerb({ archived: false }), 'unarchive')
  assert.equal(failure.flagVerb({ archived: true, pinned: true }), 'archive', 'an archive change names a write that changes both')
})

test('a session the store cannot create is DSH\'s creation sentence in words, and a branch heddle cannot write is not one', async () => {
  const failure = await import('../src/session/write-failure.ts')
  const { SessionUnwritableError } = await import('../src/session/definition.ts')
  const errno = (code: string, syscall: string) => Object.assign(new Error(`${code}: something, ${syscall} '/home/someone/.heddle/sessions/x'`), { code, syscall })
  const created = failure.storeCreateFailure(errno('EACCES', 'open'))
  assert.ok(created instanceof failure.SessionWriteError)
  assert.equal(created.message, 'failed to create session: permission denied', "DSH's rejectCreation sentence, which names no session")
  assert.equal(created.code, 'gateway/internal')
  assert.equal(failure.storeCreateFailure(errno('ENOSPC', 'write'))?.message, 'failed to create session: no space left on device')
  assert.equal(failure.storeCreateFailure(errno('EACCES', 'mkdir'))?.message, 'failed to create session: permission denied', 'a store folder that cannot be made')
  assert.equal(failure.storeCreateFailure(new SessionUnwritableError('work')), undefined, "#106's refusal keeps its own code and sentence")
  assert.equal(failure.storeCreateFailure(new Error("no session 'x' under /home/someone/.heddle/sessions")), undefined)
})

test('a store root that cannot take a new workspace folder fails a creation the route reads as one (#149)', { skip: asRoot ? 'root ignores a read-only folder' : false }, async () => {
  const { SessionStore } = await import('../src/session/store.ts')
  const failure = await import('../src/session/write-failure.ts')
  const root = join(scratch, 'readonly-root')
  mkdirSync(root, { recursive: true })
  chmodSync(root, 0o555)
  let thrown: unknown
  try {
    new SessionStore(root).create({ cwd: join(scratch, 'elsewhere') })
  } catch (error) {
    thrown = error
  } finally {
    chmodSync(root, 0o755)
  }
  assert.ok(thrown !== undefined, 'the store could not make the folder')
  assert.equal(failure.storeCreateFailure(thrown)?.message, 'failed to create session: permission denied')
  assert.deepEqual(readdirSync(root), [], 'and nothing was recorded')
})

test('Rename, Pin, Unpin, Archive and Unarchive on a read-only store answer 500 gateway/internal in words, and change nothing (#149)', { skip: asRoot ? 'root ignores a read-only folder' : false }, async () => {
  const { url, child } = await startServer()
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const post = (path: string, body: object) =>
      fetch(new URL(path, url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const list = async () => (await (await fetch(new URL('/api/sessions', url), { headers: { cookie } })).json()) as { id: string; cwd: string; title?: string; pinned?: boolean; archived?: boolean }[]

    const ran = await post('/api/turn', { prompt: 'a session to rename, pin and archive', folder: work })
    assert.equal(ran.status, 200, 'a turn made the session')
    await ran.text()
    const before = (await list()).find((meta) => meta.cwd === work)
    assert.ok(before !== undefined, 'and it is listed')
    const id = before.id

    writable(sessionRoot, false)
    try {
      const cases: [string, string, object, string][] = [
        ['Rename', 'title', { title: 'A new name' }, 'rename'],
        ['Pin', 'flags', { pinned: true }, 'pin'],
        ['Unpin', 'flags', { pinned: false }, 'unpin'],
        ['Archive', 'flags', { archived: true }, 'archive'],
        ['Unarchive', 'flags', { archived: false }, 'unarchive'],
      ]
      for (const [name, route, body, verb] of cases) {
        const response = await post(`/api/sessions/${id}/${route}`, body)
        const text = await response.text()
        assert.equal(response.status, 500, `${name}: the store could not save it, which is not the caller's fault\n${text}`)
        assert.match(String(response.headers.get('content-type')), /^application\/json/, `${name}: answered as JSON, as every refusal is`)
        assert.deepEqual(JSON.parse(text), { error: `failed to ${verb} session "${id}": permission denied`, code: 'gateway/internal' }, `${name}: DSH's code, and the reason in words`)
        assert.ok(!text.includes(scratch) && !text.includes('/sessions/'), `${name}: no path into the store\n${text}`)
      }
    } finally {
      writable(sessionRoot, true)
    }
    const after = (await list()).find((meta) => meta.id === id)
    assert.deepEqual(
      { title: after?.title, pinned: after?.pinned === true, archived: after?.archived === true },
      { title: before.title, pinned: false, archived: false },
      'nothing was changed',
    )
    const renamed = await post(`/api/sessions/${id}/title`, { title: 'A new name' })
    assert.equal(renamed.status, 200, `once the store is writable again the same rename is saved\n${await renamed.text()}`)
  } finally {
    child.kill('SIGKILL')
  }
})

test('New session, the folder route and a new turn in a workspace whose store folder is mode 000 answer 500 gateway/internal in words, and record nothing (#149, J180)', { skip: asRoot ? 'root ignores a mode-000 folder' : false }, async () => {
  const { url, child } = await startServer()
  let storeFolder: string | undefined
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const post = (path: string, body: object) =>
      fetch(new URL(path, url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const list = async () => (await (await fetch(new URL('/api/sessions', url), { headers: { cookie } })).json()) as { id: string; cwd: string }[]

    const registered = await post('/api/workspaces', { path: work })
    assert.equal(registered.status, 200, `the workspace is registered\n${await registered.text()}`)
    const first = await post('/api/sessions', { branch: work })
    assert.equal(first.status, 200, `a session made the workspace's store folder\n${await first.text()}`)
    const before = (await list()).map((meta) => meta.id).sort()
    const folders = readdirSync(sessionRoot).filter((name) => statSync(join(sessionRoot, name)).isDirectory())
    assert.equal(folders.length, 1, `one store folder: ${folders.join(', ')}`)
    storeFolder = join(sessionRoot, folders[0]!)

    chmodSync(storeFolder, 0o000)
    const answers: { name: string; status: number; type: string; text: string }[] = []
    try {
      for (const [name, path, body] of [
        ['New session', '/api/sessions', { branch: work }],
        ['the folder route with new', '/api/folders/session', { folder: work, new: true }],
        ['a turn with new', '/api/turn', { prompt: 'a new conversation', folder: work, new: true }],
        ['a turn with no folder', '/api/turn', { prompt: 'a new conversation' }],
      ] as const) {
        const response = await post(path, body)
        answers.push({ name, status: response.status, type: String(response.headers.get('content-type')), text: await response.text() })
      }
    } finally {
      chmodSync(storeFolder, 0o755)
    }
    for (const { name, status, type, text } of answers) {
      assert.equal(status, 500, `${name}: the store could not record it, which is not the caller's fault\n${text}`)
      assert.match(type, /^application\/json/, `${name}: answered as JSON\n${text}`)
      assert.deepEqual(JSON.parse(text), { error: 'failed to create session: permission denied', code: 'gateway/internal' }, `${name}: DSH's code and creation sentence`)
      assert.ok(!text.includes(scratch) && !text.includes('/sessions/'), `${name}: no path into the store\n${text}`)
    }
    assert.deepEqual((await list()).map((meta) => meta.id).sort(), before, 'no session was recorded')
    const again = await post('/api/sessions', { branch: work })
    assert.equal(again.status, 200, `once the store folder is writable again, New session is saved\n${await again.text()}`)
  } finally {
    if (storeFolder !== undefined) chmodSync(storeFolder, 0o755)
    child.kill('SIGKILL')
  }
})
