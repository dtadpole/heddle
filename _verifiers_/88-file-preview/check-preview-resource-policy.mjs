/*
---
title: Preview resource policy verifier
version: 1.0.0
description: Actual CLI headers and controlled HTTPS resources distinguish main and fixed preview frame policies
grounded_in:
  - source: owner approved alternate local resource origin in policy probe 2b2f
  - source: fixed preview shell design 808e and separately owned main policy tightening
---
*/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:https'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, run, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verification contract for the default built CLI or HEDDLE_BIN-selected delivered CLI.
 * Judges exact main/frame headers, child resource loading, main CSS/media refusal and Markdown images.
 * Exact headers require the separate main policy, with HTTPS retained only for main images.
 * An owner-approved alternate loopback HTTPS port stands for remote. HTTP would also fail under
 * the old policy and cannot establish its HTTPS regression. No production policy is widened.
 * Certificate errors are ignored only in this isolated browser for generated fake TLS material.
 * No CSP bypass, additional CSP, srcdoc, certificate installation or image library is used.
 * Valid WAV is a separate policy fixture injected into the actual fixed shell, NOT a product
 * audio/video renderer claim; DOMPurify does not support those source tags.
 * Optional valid font bytes must already exist inside the workspace; absence is UNJUDGED,
 * not a passing decode claim. Exact font-src headers are always judged independently.
 */
const PREVIEW = "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src 'self' https:; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'"
const FRAME = `${PREVIEW}; frame-ancestors 'self'; sandbox allow-same-origin`
const MAIN = {
  'default-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'], 'font-src': ["'self'", 'data:'],
  'media-src': ["'self'"], 'frame-src': ["'self'"], 'object-src': ["'none'"],
  'base-uri': ["'self'"], 'frame-ancestors': ["'none'"], 'form-action': ["'self'"],
}
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms) })]).finally(() => clearTimeout(timer))
}
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) })
function directives(value) {
  assert.equal(typeof value, 'string', 'actual response has a CSP header')
  const result = {}
  for (const row of value.split(';').map(row => row.trim()).filter(Boolean)) {
    const [name, ...sources] = row.split(/\s+/)
    assert.ok(!Object.hasOwn(result, name), `no duplicate ${name}`)
    result[name] = sources
  }
  return result
}
function exactMain(policy, html) {
  // Independent hashing of actual served inline scripts, no product policy constant import.
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]))
    .map(match => `'sha256-${createHash('sha256').update(match[2], 'utf8').digest('base64')}'`)
  assert.ok(hashes.length > 0, 'actual page has application scripts')
  assert.deepEqual(directives(policy), { ...MAIN, 'script-src': ["'self'", ...hashes] }, 'exact main directives and ordered sources; HTTPS retained only for images')
}
async function stopCli(child) {
  const ended = await endChild(child, { graceMs: 1000 })
  child.stdout?.destroy(); child.stderr?.destroy()
  assert.notEqual(ended, 'stuck', 'managed CLI exits within cleanup bound')
}
async function startCli(home, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
    cwd: repoRoot, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    const url = await bounded(new Promise((resolveUrl, reject) => {
      const collect = chunk => {
        output = (output + chunk.toString()).slice(-65536)
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match) resolveUrl(match[1])
      }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`CLI exited ${code}\n${output}`)))
    }), 20000, 'CLI startup')
    const handshake = await request(url, { redirect: 'manual' })
    await handshake.arrayBuffer()
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, 'actual CLI handshake supplies a cookie')
    return { child, url, origin: new URL(url).origin, cookie }
  } catch (error) { await stopCli(child); throw error }
}
function wav() {
  // Valid 100 ms mono PCM WAV, synthesized with Node stdlib.
  const bytes = Buffer.alloc(44 + 800 * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40)
  for (let i = 0; i < 800; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / 8000)), 44 + i * 2)
  return bytes
}
function fontFixture() {
  if (!process.env.HEDDLE_PREVIEW_FONT_FIXTURE) return null
  const path = resolve(repoRoot, process.env.HEDDLE_PREVIEW_FONT_FIXTURE)
  for (const checked of [path]) {
    const rel = relative(realpathSync(repoRoot), checked)
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'font fixture is inside workspace')
  }
  // Also refuse a symlink that points into a private/system directory, before reading bytes.
  const actual = realpathSync(path)
  const rel = relative(realpathSync(repoRoot), actual)
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'font symlink target stays in workspace')
  const stat = statSync(actual)
  assert.ok(stat.isFile() && stat.size <= 2 * 1024 * 1024, 'bounded existing font fixture')
  const bytes = readFileSync(actual)
  const magic = bytes.subarray(0, 4)
  assert.ok(['wOFF', 'wOF2', 'OTTO', 'true'].includes(magic.toString()) || magic.equals(Buffer.from([0, 1, 0, 0])), 'recognized font container; browser must still decode it')
  return bytes
}
async function resources(work, font) {
  const key = join(work, 'fake-test-key.pem'), cert = join(work, 'fake-test-cert.pem')
  const generated = await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { cwd: work, timeoutMs: 10000 })
  assert.equal(generated.failed, false, `bounded fake certificate generation: ${generated.stderr}`)
  const hits = []
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = new URL(req.url, 'https://localhost').pathname
    hits.push(path)
    let type, bytes
    if (path.endsWith('.css')) { type = 'text/css'; bytes = Buffer.from('#remote-css { color: rgb(17, 83, 149) !important; } #css-image { width: 8px; height: 8px; background-image: url("/child-css-image.png"); }') }
    else if (path.endsWith('.png')) { type = 'image/png'; bytes = PIXEL }
    else if (path.endsWith('.wav')) { type = 'audio/wav'; bytes = wav() }
    else if (path.endsWith('.font') && font) { type = 'application/octet-stream'; bytes = font }
    else { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(bytes)
  })
  server.requestTimeout = 8000; server.headersTimeout = 8000
  try {
    await bounded(new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) }), 5000, 'TLS startup')
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  return { origin: `https://127.0.0.1:${server.address().port}`, hits, server }
}
async function tlsBytes(url) {
  return bounded(new Promise((done, reject) => {
    const req = get(url, { rejectUnauthorized: false, timeout: 8000 }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('TLS request timed out'))); req.on('error', reject)
  }), 9000, 'controlled TLS bytes')
}
async function cleanup(browser, server, endpoint, work, home) {
  try { if (browser) await bounded(browser.close(), 10000, 'browser cleanup') }
  finally {
    try { if (server) await stopCli(server.child) }
    finally {
      try {
        if (endpoint) {
          endpoint.server.closeAllConnections()
          await bounded(new Promise((done, reject) => endpoint.server.close(error => error ? reject(error) : done())), 5000, 'TLS cleanup')
        }
      } finally {
        // Exact unique fixture allocations only, not the shared scratch root or a computed parent.
        if (work) removeDir(work)
        removeDir(home)
      }
    }
  }
}

test('actual CLI main and fixed frame headers pin exact separate resource policies', { timeout: 60000 }, async () => {
  const home = isolatedHome('preview-policy-headers')
  let server
  try {
    const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
    server = await startCli(home, config)
    const denied = await request(`${server.origin}/api/html/frame`)
    assert.equal(denied.status, 401); await denied.arrayBuffer()
    const shell = await request(`${server.origin}/api/html/frame?path=ignored`, { headers: { cookie: server.cookie } })
    assert.equal(shell.status, 200)
    assert.deepEqual(directives(shell.headers.get('content-security-policy')), directives(FRAME), 'every actual frame directive and source is pinned')
    assert.equal(shell.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(shell.headers.get('cache-control'), 'no-store')
    assert.equal(shell.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(await shell.text(), '<!doctype html><html><head></head><body></body></html>\n')
    const main = await request(`${server.origin}/`, { headers: { cookie: server.cookie } })
    assert.equal(main.status, 200)
    exactMain(main.headers.get('content-security-policy'), await main.text())
  } finally { await cleanup(null, server, null, null, home) }
})

test('alternate HTTPS resources work in actual preview frame while main rejects CSS and media but keeps Markdown images', { timeout: 150000 }, async context => {
  if (!browserAvailable()) {
    context.skip(process.env.HEDDLE_VERIFY_UI === '0' ? 'skipped by standard UI=0 target' : 'headless browser unavailable; resources UNJUDGED')
    return
  }
  const home = isolatedHome('preview-policy-browser'), work = fixtureDir('preview-policy-browser')
  let server, endpoint, browser
  try {
    const font = fontFixture()
    endpoint = await resources(work, font)
    for (const suffix of ['css', 'wav', ...(font ? ['font'] : [])]) {
      const control = await tlsBytes(`${endpoint.origin}/control.${suffix}`)
      assert.equal(control.status, 200)
      assert.equal(control.headers['access-control-allow-origin'], '*')
      assert.ok(control.bytes.length > 0)
      if (suffix === 'wav') assert.deepEqual(control.bytes, wav())
      if (suffix === 'font') assert.deepEqual(control.bytes, font)
    }
    const htmlPath = join(work, 'policy.html'), markdownPath = join(work, 'remote.md')
    writeFileSync(htmlPath, `<link rel="stylesheet" href="${endpoint.origin}/child.css"><h1 id="remote-css">Remote CSS</h1><div id="css-image"></div><img id="child-image" src="${endpoint.origin}/child-image.png"><script>globalThis.__sourceScriptRan = true</script>`)
    writeFileSync(markdownPath, `![legitimate remote Markdown image](${endpoint.origin}/markdown-image.png)\n`)
    const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
    server = await startCli(home, config)
    assert.notEqual(endpoint.origin, server.origin, 'approved alternate local origin, not self')
    const registered = await request(`${server.origin}/api/workspaces`, { method: 'POST', headers: { cookie: server.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: work }) })
    assert.ok(registered.ok, `register HTTP ${registered.status}: ${await registered.text()}`)
    browser = await openBrowser({ width: 1200, height: 800 })
    await bounded(browser.send('Security.setIgnoreCertificateErrors', { ignore: true }), 8000, 'test-only fake certificate allowance')
    await browser.goto(server.url)
    await browser.waitFor('typeof showFile === "function" && document.body.dataset.ready === "true"', 20000)
    await browser.evaluate(`globalThis.showFile({path: ${JSON.stringify(htmlPath)}})`)
    await browser.waitFor(`(() => { const f = document.getElementById('html-view'); const d = f?.contentDocument; return d?.URL === ${JSON.stringify(`${server.origin}/api/html/frame`)} && d.querySelector('#remote-css') && d.defaultView.getComputedStyle(d.querySelector('#remote-css')).color === 'rgb(17, 83, 149)' && d.querySelector('#child-image')?.naturalWidth === 1 })()`, 20000)
    // Imported stylesheet resources need not appear in this frame's Resource Timing timeline.
    // Below, require a decoded CSS image and an actual request recorded by its asset server.
    const framed = await browser.evaluate(`(() => { const f = document.getElementById('html-view'), d = f.contentDocument; return {src: f.getAttribute('src'), url: d.URL, sandbox: f.getAttribute('sandbox'), scripts: d.querySelectorAll('script').length, meta: d.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length, image: d.defaultView.getComputedStyle(d.querySelector('#css-image')).backgroundImage, sourceScript: globalThis.__sourceScriptRan === true} })()`)
    assert.equal(framed.src, '/api/html/frame'); assert.equal(framed.url, `${server.origin}/api/html/frame`)
    assert.equal(framed.sandbox, 'allow-same-origin'); assert.equal(framed.scripts, 0); assert.equal(framed.meta, 0); assert.equal(framed.sourceScript, false)
    assert.ok(framed.image.includes('/child-css-image.png'))
    const cssDecoded = await browser.evaluate(`(async () => { const d = document.getElementById('html-view').contentDocument; const url = d.defaultView.getComputedStyle(d.querySelector('#css-image')).backgroundImage.match(/^url\\(["']?(.+?)["']?\\)$/)?.[1]; if (!url) return false; const image = new d.defaultView.Image(); image.src = url; await image.decode(); return image.naturalWidth === 1; })()`, 10000)
    assert.equal(cssDecoded, true, 'the actual child CSS image URL resolves to valid decoded image bytes')
    assert.ok(['/child.css', '/child-css-image.png', '/child-image.png'].every(path => endpoint.hits.includes(path)), 'imported child CSS and CSS image reached alternate endpoint')
    // Separate media policy fixture in ACTUAL shell, not source DOMPurify player support.
    await browser.evaluate(`(() => { const d = document.getElementById('html-view').contentDocument; const a = d.createElement('audio'); a.id = 'policy-audio'; a.preload = 'auto'; a.crossOrigin = 'anonymous'; a.src = ${JSON.stringify(`${endpoint.origin}/child.wav`)}; d.body.append(a); a.load(); })()`)
    await browser.waitFor('(() => { const a = document.getElementById("html-view").contentDocument.querySelector("#policy-audio"); return a.readyState >= 2 && Number.isFinite(a.duration) && a.duration > 0 && !a.error })()', 10000)
    assert.ok(endpoint.hits.includes('/child.wav'), 'valid WAV decoded under child policy before main rejection')
    await browser.evaluate(`(() => {
      globalThis.__policyViolations = [];
      document.addEventListener('securitypolicyviolation', e => globalThis.__policyViolations.push({directive: e.effectiveDirective, blocked: e.blockedURI, policy: e.originalPolicy}));
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(`${endpoint.origin}/main.css`)}; document.head.append(link);
      const audio = document.createElement('audio'); audio.preload = 'auto'; audio.src = ${JSON.stringify(`${endpoint.origin}/main.wav`)}; document.body.append(audio); audio.load();
    })()`)
    await browser.waitFor('["style-src-elem", "media-src"].every(name => globalThis.__policyViolations.some(e => e.directive === name))', 10000)
    const response = await request(`${server.origin}/`, { headers: { cookie: server.cookie } })
    const mainPolicy = response.headers.get('content-security-policy')
    exactMain(mainPolicy, await response.text())
    const violations = await browser.evaluate('globalThis.__policyViolations')
    for (const [directive, suffix] of [['style-src-elem', 'css'], ['media-src', 'wav']]) {
      assert.ok(violations.some(e => e.directive === directive && [endpoint.origin, `${endpoint.origin}/main.${suffix}`].includes(e.blocked) && e.policy === mainPolicy), `MAIN response itself blocked ${directive}`)
      assert.ok(!endpoint.hits.includes(`/main.${suffix}`), 'blocked resource never reached alternate TLS endpoint')
    }
    await context.test('valid existing font loads in actual frame and MAIN font-src rejects its alternate HTTPS URL', { timeout: 30000 }, async child => {
      if (!font) { child.skip('UNJUDGED valid font fixture absent; set HEDDLE_PREVIEW_FONT_FIXTURE to an existing workspace TTF/WOFF/WOFF2; do not install or read system/private fonts'); return }
      const loaded = await browser.evaluate(`(async () => { const d = document.getElementById('html-view').contentDocument; const face = new d.defaultView.FontFace('PolicyPositiveFont', 'url(${endpoint.origin}/child.font)'); d.fonts.add(face); await face.load(); return {status: face.status, usable: d.fonts.check('16px PolicyPositiveFont')}; })()`, 10000)
      assert.deepEqual(loaded, { status: 'loaded', usable: true }, 'browser decoded valid existing font')
      assert.ok(endpoint.hits.includes('/child.font'))
      await browser.evaluate(`(() => { const face = new FontFace('PolicyBlockedFont', 'url(${endpoint.origin}/main.font)'); document.fonts.add(face); face.load().catch(() => {}); })()`)
      await browser.waitFor('globalThis.__policyViolations.some(e => e.directive === "font-src")', 10000)
      const events = await browser.evaluate('globalThis.__policyViolations')
      assert.ok(events.some(e => e.directive === 'font-src' && [endpoint.origin, `${endpoint.origin}/main.font`].includes(e.blocked) && e.policy === mainPolicy))
      assert.ok(!endpoint.hits.includes('/main.font'))
    })
    await browser.evaluate(`globalThis.showFile({path: ${JSON.stringify(markdownPath)}})`)
    await browser.waitFor('(() => { const img = document.querySelector("#file-body img"); return img?.alt === "legitimate remote Markdown image" && img.complete && img.naturalWidth === 1 })()', 15000)
    assert.ok(endpoint.hits.includes('/markdown-image.png'), 'legitimate MAIN remote HTTPS Markdown image still decodes')
  } finally { await cleanup(browser, server, endpoint, work, home) }
})
