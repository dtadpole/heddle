import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, settle } from '../src/boot.ts'
import { startWebServer, type WebServer } from '../src/server/web.ts'

/**
 * `POST /api/workspaces` with a `~` path registers the folder under the home (GitHub issue #1).
 *
 * The route accepted `~/x` — it checked `statSync(expandHome(path))` — and then stored the raw string, which
 * `canonicalPath` resolved against the server's working directory: the record pointed at `<cwd>/~/x`, a folder
 * that does not exist, and the answer was `200 created: true`. The Rust route stores
 * `canonical_path(expand_home(raw))` (heddle-server `add_workspace`), and heddle keeps that `~` rule on purpose
 * (`rust/crates/heddle-config/INDEX.md` §7). DSH refuses a path that is not fully qualified instead
 * (dsh-workspace `realpathNormalize`), so this is the two builds agreeing, not DSH parity.
 *
 * Judged over the route itself, in process: the shipped profile booted with a scripted endpoint, the server on a
 * free port, `HOME` and `HEDDLE_HOME` pointing into a scratch directory before anything reads them.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-workspace-tilde-')))
const home = join(scratch, 'home')
const folder = join(home, 'probe-ws')
mkdirSync(folder, { recursive: true })
process.env.HOME = home
process.env.HEDDLE_HOME = join(scratch, 'heddle')
process.env.HEDDLE_CONFIG = join(scratch, 'heddle.json')
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
  server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'tilde-check-token', secretPath: join(scratch, 'secret') })
  const handshake = await fetch(server.url, { redirect: 'manual' })
  cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
})

after(async () => {
  await server?.close()
  await app?.dispose()
  rmSync(scratch, { recursive: true, force: true })
})

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  assert.ok(server !== undefined, 'the server is up')
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const add = (body: Record<string, unknown>) => call('/api/workspaces', { method: 'POST', body: JSON.stringify(body) })

test('a ~ path is the folder under the home, stored canonical, and its other spellings are the same workspace', async () => {
  const canonical = realpathSync(folder)

  const added = await add({ path: '~/probe-ws', name: 'probe-ws' })
  assert.equal(added.status, 200, `the folder is added (${JSON.stringify(added.body)})`)
  assert.equal(added.body.created, true, 'and this call created it')
  assert.equal(added.body.record.path, canonical, 'under the canonical path of the folder in the home, not under the server folder')
  assert.equal(added.body.record.title, 'probe-ws')

  const listed = (await call('/api/workspaces')).body.workspaces as { id: string; path: string }[]
  assert.deepEqual(listed.map((view) => view.path), [canonical], 'the listing holds that one folder')
  assert.ok(existsSync(listed[0]!.path), 'and the stored path exists')

  const expanded = await add({ path: folder })
  assert.equal(expanded.status, 200)
  assert.equal(expanded.body.created, false, 'the expanded spelling is the workspace already there')
  assert.equal(expanded.body.record.id, added.body.record.id)

  const slashed = await add({ path: '~/probe-ws/' })
  assert.equal(slashed.body.created, false, 'and so is a trailing slash after ~')
  assert.equal(slashed.body.record.id, added.body.record.id)

  if (existsSync(join(home, 'PROBE-WS'))) {
    // A case-insensitive volume (macOS by default): the native realpath answers with the spelling the disk stores.
    const variant = await add({ path: '~/PROBE-WS' })
    assert.equal(variant.body.created, false, 'a letter-case variant is that workspace too')
    assert.equal(variant.body.record.id, added.body.record.id)
  }
})

test('a ~ path that does not exist is refused with the path as it was written', async () => {
  const missing = await add({ path: '~/nowhere' })
  assert.equal(missing.status, 400)
  assert.deepEqual(missing.body, { error: '~/nowhere does not exist' })
})
