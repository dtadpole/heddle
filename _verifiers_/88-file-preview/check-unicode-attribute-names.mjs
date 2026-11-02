/*
---
title: Unicode attribute name HTTP regression
version: 1.0.0
description: Unknown Unicode attribute names are stripped while ordinary Markdown and allowed paragraph attributes remain rendered
grounded_in:
  - source: owner requested actual CLI regression for sanitizer attribute name UTF-8 scan
  - source: c13e28dcdb4755d6a5b093f7f70289a38ac185da
---
*/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

import { endChild, heddleCommand, repoRoot, scratchRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Actual built TypeScript or HEDDLE_BIN Rust CLI /api/file, never an imported
 * renderer or source-module substitute. The caller builds the selected CLI.
 * Authored from source c13e28dcdb4755d6a5b093f7f70289a38ac185da; authoring is
 * not before/after endpoint evidence. Existing Unicode anchor VALUE coverage
 * remains independent: this check targets unknown Unicode attribute NAMES.
 * Both cases use ordinary paragraphs and no notes, anchors, URIs or scripts.
 * This judges rendered output, not XSS, process abort, full parser correctness
 * or an overall security pass. No browser, model request or private payload.
 */
const UNKNOWN_NAMES = ['é', '文字', '😀', 'unknowné', 'unknown文字', 'unknown😀']
const TITLE = 'é 文字 😀'
const REQUEST_MS = 10_000
const MAX_BODY_BYTES = 1_000_000

function document(keepAllowed) {
  const unknown = UNKNOWN_NAMES.map((name) => `${name}="ordinary"`).join(' ')
  return [
    '# Unicode attribute names',
    '',
    'Normal **prose** before the paragraph.',
    '',
    `<p ${unknown}${keepAllowed ? ` title="${TITLE}" width="12"` : ''}>ok</p>`,
    '',
    'Following *words* after the paragraph.',
    '',
  ].join('\n')
}

// The timeout covers headers AND body consumption; never retain an unlimited body.
async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) })
  const chunks = []
  let bytes = 0
  const reader = response.body?.getReader()
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        assert.ok(bytes <= MAX_BODY_BYTES, 'fixture HTTP body stays below one megabyte')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }
}

function printedUrl(child) {
  return new Promise((resolveUrl, reject) => {
    let output = ''
    let settled = false
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      child.stdout.resume()
      child.stderr.resume()
      if (error) reject(error)
      else resolveUrl(url)
    }
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-64_000)
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) finish(null, match[1])
    }
    const onError = (error) => finish(error)
    const onExit = (code, signal) => finish(new Error(`Unicode attribute name server exited (${code ?? signal}) before startup\n${output}`))
    const timer = setTimeout(() => finish(new Error(`Unicode attribute name server printed no URL within 20 seconds\n${output}`)), 20_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function withFileServer(keepAllowed, check) {
  mkdirSync(scratchRoot, { recursive: true })
  const root = realpathSync(scratchRoot)
  const owned = []
  const allocate = (label) => {
    const prefix = `unicode-attribute-names-${label}-`
    const path = realpathSync(mkdtempSync(join(root, prefix)))
    assert.equal(dirname(path), root, 'fixture resolves directly under this checkout scratch root')
    assert.ok(basename(path).startsWith(prefix), 'fixture has its own allocated prefix')
    owned.push({ path, prefix })
    return path
  }
  let child
  try {
    const home = allocate('home')
    const work = allocate('workspace')
    const path = join(work, keepAllowed ? 'allowed-attributes.md' : 'unknown-only.md')
    const source = document(keepAllowed)
    writeFileSync(path, source, 'utf8')
    const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
    child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = await printedUrl(child)
    const address = new URL(url)
    assert.equal(address.hostname, '127.0.0.1', 'server advertises its own loopback URL')
    assert.notEqual(address.port, '0', 'OS assigned the requested ephemeral port')
    const handshake = await request(url, { redirect: 'manual' })
    const setCookie = handshake.headers.get('set-cookie')
    assert.ok(setCookie, `private token handshake sets a cookie (HTTP ${handshake.status})`)
    const cookie = setCookie.split(';')[0]
    const registered = await request(`${address.origin}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: work }),
    })
    assert.equal(registered.status, 200, 'register only this verifier’s own workspace')
    const response = await request(`${address.origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })
    assert.equal(response.status, 200, 'actual file route accepts the synthetic Markdown fixture')
    const body = JSON.parse(response.text)
    assert.equal(body.renderer, 'markdown', 'endpoint selects the Markdown renderer')
    assert.equal(typeof body.html, 'string', 'endpoint returns rendered HTML')
    assert.notEqual(body.html, source, 'source text is not the preview')
    check(body.html)
  } finally {
    let stopped = true
    if (child?.pid) stopped = await endChild(child, { graceMs: 3000 }) !== 'stuck'
    // Check the exact resolved mkdtemp allocations immediately before deletion.
    // Never remove scratchRoot or a still-running child's home/workspace.
    if (stopped) {
      for (const { path, prefix } of owned) {
        assert.equal(resolve(path), path, 'cleanup target is the recorded absolute allocation')
        assert.equal(realpathSync(path), path, 'cleanup target has not become a symlink')
        assert.equal(dirname(path), root, 'cleanup stays in this checkout scratch root')
        assert.ok(basename(path).startsWith(prefix), 'cleanup target is this owned fixture')
        rmSync(path, { recursive: true, force: false })
      }
    }
    assert.ok(stopped, 'server exits within bounded cleanup; fixtures retained if stuck')
  }
}

function assertRendered(html, keepAllowed) {
  assert.doesNotMatch(html, /\bclass\s*=\s*["'][^"']*\bunrendered\b/i, 'no whole-document unrendered fallback')
  assert.match(html, /<h1\b[^>]*>Unicode attribute names<\/h1>/, 'heading proves real Markdown rendering')
  assert.match(html, /<p>Normal <strong>prose<\/strong> before the paragraph\.<\/p>/, 'normal prose emphasis renders before the raw paragraph')
  assert.match(html, /<p>Following <em>words<\/em> after the paragraph\.<\/p>/, 'following Markdown words still render')
  assert.doesNotMatch(html, /\*\*prose\*\*|\*words\*|&lt;p\b/i, 'escaped raw HTML or literal Markdown is not a source fallback')
  assert.doesNotMatch(html, /<a\b|<sup\b|class="footnotes"/i, 'note-free paragraph fixtures do not invent anchors or notes')
  const paragraphs = [...html.matchAll(/<p\b([^>]*)>ok<\/p>/g)]
  assert.equal(paragraphs.length, 1, 'one ordinary raw paragraph remains rendered')
  if (keepAllowed) {
    // Fixture-only exact allow-list comparison; not a second general HTML parser.
    const attrs = [...paragraphs[0][1].matchAll(/\s+(title|width)="([^"]*)"/g)]
    assert.equal(attrs.length, 2, 'both allowed attributes survive after unknown Unicode names')
    assert.equal(paragraphs[0][1], attrs.map((match) => match[0]).join(''), 'no unknown names or stray attribute fragments survive')
    assert.deepEqual(attrs.map((match) => [match[1], match[2]]).sort(), [['title', TITLE], ['width', '12']], 'Unicode title value and numeric width retain their exact values')
  } else {
    assert.equal(paragraphs[0][0], '<p>ok</p>', 'all unknown names are stripped to the exact ordinary paragraph')
  }
}

for (const keepAllowed of [false, true]) {
  test(`unknown Unicode attribute names are stripped ${keepAllowed ? 'while Unicode title and width 12 survive' : 'to <p>ok</p>'} through /api/file without footnotes`, { timeout: 90_000 }, async () => {
    await withFileServer(keepAllowed, (html) => assertRendered(html, keepAllowed))
  })
}
