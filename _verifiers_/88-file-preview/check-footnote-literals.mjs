/*
---
title: Footnote author literal HTTP regression
version: 1.0.0
description: Footnote hooks preserve author marker lookalikes and ordinary prose through the actual JSON Markdown renderer
grounded_in:
  - source: owner requested narrow delivered CLI footnote marker regression
  - source: d7101503c26daa28df7f3402a8667abd19e06be0
---
*/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

import { endChild, heddleCommand, repoRoot, scratchRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Narrow complement to check-footnotes.mjs, not full grammar/budget coverage.
 * Authored at d7101503c26daa28df7f3402a8667abd19e06be0, without an endpoint
 * verdict. The caller builds; this starts the actual CLI and honors HEDDLE_BIN.
 * No browser, model request, private input, unsafe URI or script payload.
 * TS must retain literal NUL. A selected alternate CLI (including Comrak Rust)
 * may normalize NUL to U+FFFD: an unrelated control must establish that behavior
 * before the same normalization is allowed in marker prose. This is not an
 * automatic exact-byte TS/Rust parity claim or a new product NUL policy.
 */
const REQUEST_MS = 10_000
const MAX_BODY_BYTES = 1_000_000
const CONTROL = 'Harmless\0control with <strong>ordinary prose</strong>.'
const LITERALS = [
  { source: 'proper-prefix\0heddle-footnote:', rendered: 'proper-prefix\0heddle-footnote:' },
  { source: 'bare heddle-footnote:', rendered: 'bare heddle-footnote:' },
  { source: 'bare-double heddle-footnote::', rendered: 'bare-double heddle-footnote::' },
  { source: 'numeric\0heddle-footnote:0\0', rendered: 'numeric\0heddle-footnote:0\0' },
  { source: 'empty\0heddle-footnote:\0', rendered: 'empty\0heddle-footnote:\0' },
  { source: 'unrelated\0text', rendered: 'unrelated\0text' },
  // No exact numeric marker occurs in this source; ordinary parsing creates it.
  { source: 'escaped\0heddle-footnote\\:0\0', rendered: 'escaped\0heddle-footnote:0\0' },
]

function document(hasNote) {
  return [
    '# Footnote author literals', '',
    'Harmless\0control with **ordinary prose**.', '',
    ...LITERALS.flatMap(({ source }) => [`${source}${hasNote ? '[^n]' : ''}`, '']),
    ...(hasNote ? ['[^n]: One **actual note**.', ''] : []),
  ].join('\n')
}

// Bound both headers and body time, and retained response bytes.
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
        assert.ok(bytes <= MAX_BODY_BYTES, 'fixture response stays below one megabyte')
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
    const onExit = (code, signal) => finish(new Error(`footnote literal server exited (${code ?? signal}) before startup\n${output}`))
    const timer = setTimeout(() => finish(new Error(`footnote literal server printed no URL within 20 seconds\n${output}`)), 20_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function withFileServer(hasNote, check) {
  mkdirSync(scratchRoot, { recursive: true })
  const root = realpathSync(scratchRoot)
  const owned = []
  const allocate = (label) => {
    const prefix = `footnote-literals-${label}-`
    const path = realpathSync(mkdtempSync(join(root, prefix)))
    assert.equal(dirname(path), root, 'allocation resolves directly under checkout scratch root')
    assert.ok(basename(path).startsWith(prefix), 'allocation has this verifier prefix')
    owned.push({ path, prefix })
    return path
  }
  let child
  try {
    const home = allocate('home')
    const work = allocate('workspace')
    const path = join(work, hasNote ? 'with-note.md' : 'without-note.md')
    const source = document(hasNote)
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
    assert.ok(address.port && address.port !== '0', 'OS assigned the requested ephemeral port')
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
    // The file reader correctly refuses NUL bytes as nontext. Exercise the real
    // answer-rendering endpoint instead; do not weaken file admission for this fixture.
    const file = await request(`${address.origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })
    assert.equal(file.status, 415, 'NUL-bearing files remain nontext; JSON rendering does not widen file admission')
    const response = await request(`${address.origin}/api/markdown`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: source }),
    })
    assert.equal(response.status, 200, 'actual answer renderer accepts synthetic Markdown JSON')
    const body = JSON.parse(response.text)
    assert.equal(typeof body.html, 'string')
    assert.notEqual(body.html, source, 'source proxy is not rendered output')
    check(body.html)
  } finally {
    let stopped = true
    if (child?.pid) stopped = await endChild(child, { graceMs: 3000 }) !== 'stuck'
    // Delete only recorded, checked mkdtemp allocations after the child stops.
    if (stopped) {
      for (const { path, prefix } of owned) {
        assert.equal(resolve(path), path, 'cleanup target is recorded absolute allocation')
        assert.equal(realpathSync(path), path, 'cleanup target has not become a symlink')
        assert.equal(dirname(path), root, 'cleanup remains under checkout scratch root')
        assert.ok(basename(path).startsWith(prefix), 'cleanup target is this owned fixture')
        rmSync(path, { recursive: true, force: false })
      }
    }
    assert.ok(stopped, 'bounded child cleanup; retain allocations if child is stuck')
  }
}

function assertRendered(html, hasNote, context) {
  assert.doesNotMatch(html, /\bclass\s*=\s*["'][^"']*\bunrendered\b/i, 'no whole-document fallback')
  assert.match(html, /<h1>Footnote author literals<\/h1>/, 'heading proves actual Markdown rendering')
  // Establish NUL behavior independently of footnote-marker text. The default
  // TypeScript CLI must retain it; alternate CLI normalization is explicit.
  let nul = '\0'
  if (process.env.HEDDLE_BIN && html.includes(`<p>${CONTROL.replaceAll('\0', '\uFFFD')}</p>`)) nul = '\uFFFD'
  assert.ok(html.includes(`<p>${CONTROL.replaceAll('\0', nul)}</p>`), 'unrelated control retains prose and establishes NUL behavior')
  context.diagnostic(`Selected CLI NUL control — ${nul === '\0' ? 'literal U+0000 retained' : 'U+FFFD normalization; not exact TS byte parity'}`)
  let remainder = html.replace(`<p>${CONTROL.replaceAll('\0', nul)}</p>`, '')
  for (const { rendered } of LITERALS) {
    const expected = `<p>${rendered.replaceAll('\0', nul)}${hasNote ? '<sup>1</sup>' : ''}</p>`
    assert.equal(html.split(expected).length - 1, 1, `author literal retained once with ${hasNote ? 'adjacent plain citation' : 'no invented citation'} — ${JSON.stringify(rendered)}`)
    remainder = remainder.replace(expected, '')
  }
  assert.doesNotMatch(remainder, /heddle-footnote|\0|\uFFFD/, 'no generated marker leak outside exact author paragraphs')
  assert.doesNotMatch(html, /<a\b|\b(?:id|href)\s*=/i, 'anchor-free fixtures acquire no generated IDs or hrefs')
  assert.doesNotMatch(html, /\[\^n\]/, 'no leftover actual citation or definition syntax')
  const superscripts = [...html.matchAll(/<sup\b[^>]*>[\s\S]*?<\/sup>/g)].map((match) => match[0])
  assert.deepEqual(superscripts, hasNote ? LITERALS.map(() => '<sup>1</sup>') : [], 'only actual citations become current plain numeric superscripts')
  if (hasNote) {
    const sections = [...html.matchAll(/<section class="footnotes">([\s\S]*?)<\/section>/g)]
    assert.equal(sections.length, 1, 'one actual footnote section')
    assert.equal((sections[0][1].match(/<li\b/g) ?? []).length, 1, 'only the one cited note entry is generated')
    assert.equal(html.split('One <strong>actual note</strong>.').length - 1, 1, 'one rendered shared note body')
    assert.match(sections[0][1], /<ol>\s*<li>\s*<p>One <strong>actual note<\/strong>\./, 'actual note prose and emphasis render')
    assert.equal((sections[0][1].match(/↩/g) ?? []).length, LITERALS.length, 'one plain return marker per actual citation')
    assert.equal((html.match(/↩/g) ?? []).length, LITERALS.length, 'no invented return markers outside actual note')
  } else {
    assert.doesNotMatch(html, /<section\b|actual note|↩/, 'note-free parser-created marker lookalikes invent no notes or return markers')
  }
}

for (const hasNote of [true, false]) {
  test(`author footnote marker literals survive ${hasNote ? 'adjacent actual citations' : 'without any footnote'} through /api/markdown`, { timeout: 90_000 }, async (context) => {
    await withFileServer(hasNote, (html) => assertRendered(html, hasNote, context))
  })
}
