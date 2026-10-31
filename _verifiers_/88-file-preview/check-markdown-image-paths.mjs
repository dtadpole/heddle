import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Issue #131 HTTP regression, no browser. Run with node --test; HEDDLE_BIN selects the Rust build.
 * Read the Markdown preview's actual image URLs, fetch their raw bytes with and without a session cookie,
 * and distinguish space, literal %20, and Unicode/ampersand filenames. This does not judge browser rendering,
 * standalone PNG preview (#126), or query-suffix semantics. Every server and fixture belongs to this run.
 */

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A valid one-pixel RGB PNG, distinct by color, using only Node's standard library. */
function png(rgb) {
  const chunk = (name, data) => {
    const type = Buffer.from(name)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, ...rgb]))), chunk('IEND', Buffer.alloc(0)),
  ])
}

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
}

async function startServer(home, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
    cwd: repoRoot,
    env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server startup timed out\n${output}`)), 20_000)
      const finish = (fn, value) => { clearTimeout(timer); fn(value) }
      const onData = (data) => {
        output += data.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match) finish(resolve, match[1])
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => finish(reject, new Error(`server exited ${code}\n${output}`)))
    })
    return { child, url }
  } catch (error) {
    await stopServer(child)
    throw error
  }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  let timer
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server cleanup timed out')), 5_000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('Markdown encoded image URLs serve distinct exact PNG bytes behind cookie and workspace authorization', { timeout: 60_000 }, async () => {
  const home = isolatedHome('markdown-image-paths')
  const work = fixtureDir('markdown-image-paths')
  const cases = [
    ['shot%20one.png#part%20one', 'shot one.png', png([255, 0, 0])],
    ['shot%2520one.png', 'shot%20one.png', png([0, 255, 0])],
    ['%E6%96%87%E5%AD%97%26image.png', '文字&image.png', png([0, 0, 255])],
  ]
  let server
  try {
    for (const [, name, bytes] of cases) writeFileSync(join(work, name), bytes)
    const documentPath = join(work, 'images.md')
    writeFileSync(documentPath, cases.map(([destination], index) => `![image ${index}](${destination})`).join('\n\n'))
    const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
    server = await startServer(home, config)
    const handshake = await request(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `handshake HTTP ${handshake.status}`)
    const origin = new URL(server.url).origin
    const registered = await request(`${origin}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ path: work }),
    })
    assert.ok(registered.ok, `register HTTP ${registered.status}: ${await registered.text()}`)
    const preview = await request(`${origin}/api/file?path=${encodeURIComponent(documentPath)}`, { headers: { cookie } })
    assert.equal(preview.status, 200)
    const rendered = await preview.json()
    assert.equal(rendered.renderer, 'markdown')
    const urls = [...String(rendered.html).matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&'))
    assert.equal(urls.length, 3, rendered.html)
    assert.equal(new Set(urls).size, 3)
    for (let index = 0; index < cases.length; index++) {
      const [, name, bytes] = cases[index]
      const url = new URL(urls[index], origin)
      assert.equal(url.origin, origin)
      assert.equal(url.pathname, '/api/raw')
      assert.equal(url.searchParams.get('path'), join(work, name))
      assert.equal(url.hash, index === 0 ? '#part%20one' : '')
      const raw = await request(url, { headers: { cookie } })
      assert.equal(raw.status, 200)
      assert.match(raw.headers.get('content-type') ?? '', /^image\/png\b/)
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes)
      const denied = await request(url)
      assert.equal(denied.status, 401, 'raw bytes require the session cookie')
    }
    // A malformed escape in a link is a literal filename, not permission to navigate away from the app.
    writeFileSync(join(work, '100%.md'), 'literal-percent link target\n')
    writeFileSync(documentPath, '[budget](100%.md)')
    const linkPreview = await request(`${origin}/api/file?path=${encodeURIComponent(documentPath)}`, { headers: { cookie } })
    assert.equal(linkPreview.status, 200)
    const linkHtml = String((await linkPreview.json()).html)
    const linkAddress = /<a[^>]*\bhref="([^"]+)"/.exec(linkHtml)?.[1]
    assert.ok(linkAddress, linkHtml)
    assert.ok(linkHtml.includes('data-heddle-path='), 'local link retains in-panel routing metadata')
    const linked = new URL(linkAddress.replaceAll('&amp;', '&'), origin)
    assert.equal(linked.searchParams.get('path'), join(work, '100%.md'))
    const linkResponse = await request(linked, { headers: { cookie } })
    assert.equal(linkResponse.status, 200)
    assert.equal(await linkResponse.text(), 'literal-percent link target\n')
    const unsafePath = join(home, 'outside.png')
    writeFileSync(unsafePath, png([20, 30, 40]))
    const outside = await request(`${origin}/api/raw?path=${encodeURIComponent(unsafePath)}`, { headers: { cookie } })
    assert.equal(outside.status, 404, 'authenticated requests cannot read outside registered workspace roots')
    writeFileSync(documentPath, '![bad](bad%20%GG.png)\n\n![bad](bad%FF.png)\n\n![scheme](http%3A%2F%2Fexample.png)')
    const malformed = await request(`${origin}/api/file?path=${encodeURIComponent(documentPath)}`, { headers: { cookie } })
    assert.equal(malformed.status, 200)
    const refused = await malformed.json()
    assert.ok(!/<img[^>]*\bsrc=/.test(String(refused.html)), refused.html)
  } finally {
    if (server) await stopServer(server.child)
    // These are the exact unique fixture directories allocated above, never a computed parent or shared root.
    removeDir(work)
    removeDir(home)
  }
})
