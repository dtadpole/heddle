import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { boot, settle } from '../src/boot.ts'
import { readAttachment } from '../src/server/attachments.ts'
import { startWebServer } from '../src/server/web.ts'

/** #42: bounded in-process HTTP unit over the actual upload route and attachment admission.
 * Scratch configuration only; no browser, build, model request or live state.
 */
test('#42: ordinary empty uploads are stored/admitted; empty raster uploads fail without storing', { timeout: 15000 }, async () => {
  const scratch = realpathSync(mkdtempSync(join(import.meta.dirname, '..', '.heddle-tmp-upload-')))
  const keys = ['HOME', 'HEDDLE_HOME', 'HEDDLE_CONFIG'] as const
  const previous = keys.map(key => process.env[key])
  process.env.HOME = scratch
  process.env.HEDDLE_HOME = join(scratch, 'heddle')
  process.env.HEDDLE_CONFIG = join(scratch, 'heddle.json')
  writeFileSync(join(scratch, 'script.json'), JSON.stringify({ steps: [{ text: 'ready' }] }))
  writeFileSync(process.env.HEDDLE_CONFIG, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(scratch, 'script.json'), model: 'scripted' }] }))
  let app: Awaited<ReturnType<typeof boot>> | undefined
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  try {
    app = await boot({
      base: join(import.meta.dirname, '..', 'cordis.yml'), includeProjectPatch: true, configDir: scratch, logLevel: 0,
      overrides: [{ patch: [{ id: 'session', config: { root: join(scratch, 'sessions') } }] }],
    })
    await settle(app.ctx)
    server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'upload-check-token', secretPath: join(scratch, 'secret') })
    const handshake = await fetch(server.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const upload = (name: string, type: string) => fetch(new URL(`/api/uploads?name=${name}`, server!.url), {
      method: 'POST', headers: { cookie, 'content-type': type }, body: '', signal: AbortSignal.timeout(5000),
    })
    const empty = await upload('empty.txt', 'text/plain')
    assert.equal(empty.status, 200, await empty.clone().text())
    const saved = await empty.json() as { path: string; bytes: number }
    assert.equal(saved.bytes, 0)
    assert.equal(readFileSync(saved.path).length, 0)
    assert.equal(readAttachment(saved.path).type, 'file')
    for (const [name, type] of [['empty.PNG', 'application/octet-stream'], ['empty.txt', 'image/png']]) {
      const refused = await upload(name!, type!)
      assert.equal(refused.status, 400)
      assert.equal(await refused.text(), 'an empty image is not valid\n')
    }
    assert.equal(readdirSync(join(process.env.HEDDLE_HOME, 'uploads')).length, 1, 'refused empty images leave no orphan upload')
  } finally {
    await server?.close()
    await app?.dispose()
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    // The resolved scratch path was created above, under this isolated repository, and is the only cleanup target.
    assert.ok(scratch.startsWith(realpathSync(join(import.meta.dirname, '..')) + '/.heddle-tmp-upload-'))
    rmSync(scratch, { recursive: true, force: true })
  }
})
