import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { boot, settle } from '../src/boot.ts'
import { startWebServer } from '../src/server/web.ts'
import { readFileText } from '../src/session/tree.ts'

/** Issue #45: owned-file OS permission failures are neither missing files nor unsupported text.
 * Only fixture-owned files have their mode changed, restored in finally before cleanup.
 * A host that can still read mode 000 reports this permission test unjudged (skipped), never passing.
 */
test('file preview permission refusal is named, path-free and distinct from nonfile/nontext', async (t) => {
  mkdirSync(resolve('.heddle-tmp'), { recursive: true })
  const scratch = mkdtempSync(join(resolve('.heddle-tmp'), 'file-preview-errors-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const denied = join(workspace, 'denied.txt')
  writeFileSync(denied, 'private fixture text')
  const mode = statSync(denied).mode & 0o777
  let app: Awaited<ReturnType<typeof boot>> | undefined
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  const previous = { HEDDLE_HOME: process.env.HEDDLE_HOME, HEDDLE_CONFIG: process.env.HEDDLE_CONFIG }
  try {
    chmodSync(denied, 0)
    try {
      readFileSync(denied)
      t.skip('OS permits reading mode 000; real permission denial is unjudged')
      return
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'EACCES', 'real host denial, not a mock')
    }
    const expected = { code: 'workspace-file/unreadable', message: 'cannot read file: permission denied' }
    assert.throws(() => readFileText(denied), expected)
    process.env.HEDDLE_HOME = join(scratch, 'home')
    process.env.HEDDLE_CONFIG = join(scratch, 'config.json')
    writeFileSync(join(scratch, 'script.json'), JSON.stringify({ steps: [{ text: 'ready' }] }))
    writeFileSync(process.env.HEDDLE_CONFIG, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(scratch, 'script.json'), model: 'scripted' }] }))
    app = await boot({ base: resolve('cordis.yml'), includeProjectPatch: true, configDir: scratch, logLevel: 0,
      overrides: [{ patch: [{ id: 'session', config: { root: join(scratch, 'sessions') } }] }] })
    await settle(app.ctx)
    app.ctx.workspace!.add(workspace)
    server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'preview-check-token', secretPath: join(scratch, 'secret') })
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const call = (path: string, authorized = true) => fetch(new URL(`/api/file?path=${encodeURIComponent(path)}`, server!.url), { headers: authorized ? { cookie } : {} })
    const loop = join(workspace, 'loop.txt')
    symlinkSync('loop.txt', loop)
    assert.throws(() => readFileText(loop), { code: 'workspace-file/read-failed', message: 'cannot read file: I/O error' })
    const failed = await call(loop)
    assert.equal(failed.status, 500, 'unexpected filesystem failures are not nonfile or unsupported')
    assert.deepEqual(await failed.json(), { error: 'cannot read file: I/O error', code: 'workspace-file/read-failed' })
    const refusal = await call(denied)
    assert.equal(refusal.status, 403)
    assert.deepEqual(await refusal.json(), { error: expected.message, code: expected.code })
    assert.equal((await call(denied, false)).status, 401, 'authentication still precedes file access')
    for (const path of [workspace, join(workspace, 'missing.txt')]) assert.equal((await call(path)).status, 404)
    const binary = join(workspace, 'binary.bin')
    writeFileSync(binary, Buffer.from([0, 1]))
    assert.equal((await call(binary)).status, 415)
    const invalid = join(workspace, 'invalid.txt')
    writeFileSync(invalid, Buffer.from([0xff]))
    assert.equal((await call(invalid)).status, 415)
    const outside = join(scratch, 'outside.txt')
    writeFileSync(outside, 'outside')
    const link = join(workspace, 'escape.txt')
    symlinkSync(outside, link)
    assert.equal((await call(outside)).status, 400)
    assert.equal((await call(link)).status, 400, 'canonical ownership still refuses an outside symlink')
    chmodSync(denied, mode)
    assert.equal(readFileText(denied).text, 'private fixture text')
    assert.equal((await call(denied)).status, 200)
  } finally {
    chmodSync(denied, mode)
    await server?.close()
    await app?.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.equal(resolve(scratch).startsWith(`${resolve('.heddle-tmp')}/file-preview-errors-`), true)
    rmSync(scratch, { recursive: true, force: true })
  }
})
