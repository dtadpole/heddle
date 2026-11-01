import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boot, settle } from '../src/boot.ts'
import { PREVIEW_CSP, PREVIEW_FRAME_CSP, PREVIEW_SHELL } from '../src/server/html.ts'
import { startWebServer } from '../src/server/web.ts'

// Authored under D067 STATICONLY. Do not run until the owner's resource gate permits suites.
test('fixed HTML shell is authenticated, private, empty and independent of query paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heddle-preview-shell-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const prior = { HOME: process.env.HOME, HEDDLE_HOME: process.env.HEDDLE_HOME, HEDDLE_CONFIG: process.env.HEDDLE_CONFIG }
  process.env.HOME = home
  process.env.HEDDLE_HOME = home
  process.env.HEDDLE_CONFIG = join(root, 'config.json')
  writeFileSync(join(root, 'script.json'), JSON.stringify({ steps: [{ text: 'ready' }] }))
  writeFileSync(process.env.HEDDLE_CONFIG, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(root, 'script.json'), model: 'scripted' }] }))
  const privatePath = join(root, 'private.html')
  writeFileSync(privatePath, '<h1>PRIVATE SENTINEL</h1>')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined
  try {
    app = await boot({ base: join(import.meta.dirname, '..', 'cordis.yml'), includeProjectPatch: true, configDir: root, logLevel: 0, overrides: [{ patch: [{ id: 'session', config: { root: join(root, 'sessions') } }] }] })
    await settle(app.ctx)
    server = await startWebServer(app.ctx, { port: 0, quiet: true, token: 'preview-shell-test', secretPath: join(root, 'secret') })
    const origin = new URL('/', server.url)
    const refusal = await fetch(new URL('/api/html/frame', origin))
    assert.equal(refusal.status, 401)
    assert.equal(await refusal.text(), 'unauthorized\n')
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    assert.ok(cookie)
    for (const suffix of ['', '?path=' + encodeURIComponent(privatePath), '?path=%00&file=../../private.html', '?path=%FF', '?path=/does/not/exist']) {
      const response = await fetch(new URL('/api/html/frame' + suffix, origin), { headers: { cookie } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(response.headers.get('content-security-policy'), PREVIEW_FRAME_CSP)
      const text = await response.text()
      assert.equal(text, PREVIEW_SHELL)
      assert.doesNotMatch(text, /PRIVATE|script|path|src|href/i)
    }
    assert.equal((await fetch(new URL('/api/html/frame', origin), { method: 'POST', headers: { cookie } })).status, 404)
  } finally {
    await server?.close()
    await app?.dispose()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('TS and Rust fixed shell share body and CSP and neither handler reads files', () => {
  const web = readFileSync(new URL('../src/server/web.ts', import.meta.url), 'utf8')
  const rust = readFileSync(new URL('../rust/crates/heddle-server/src/server.rs', import.meta.url), 'utf8')
  const preview = readFileSync(new URL('../rust/crates/heddle-server/src/preview.rs', import.meta.url), 'utf8')
  assert.equal(PREVIEW_FRAME_CSP, PREVIEW_CSP + "; frame-ancestors 'self'; sandbox allow-same-origin")
  assert.ok(preview.includes(JSON.stringify(PREVIEW_SHELL)))
  const tsHandler = web.slice(web.indexOf("if (url.pathname === '/api/html/frame'"), web.indexOf("if (url.pathname === '/api/html'"))
  const rustHandler = rust.slice(rust.indexOf('async fn html_frame()'), rust.indexOf('async fn html_preview('))
  assert.ok(web.indexOf('if (!decision.ok)') < web.indexOf("if (url.pathname === '/api/html/frame'"))
  for (const handler of [tsHandler, rustHandler]) {
    assert.doesNotMatch(handler, /readFile|std::fs|canonical|searchParams|Query\(|workspace/)
    for (const header of ['content-security-policy', 'referrer-policy', 'x-content-type-options']) assert.ok(handler.includes(header))
  }
  assert.ok(rust.includes('.route("/api/html/frame", get(html_frame))'))
})
