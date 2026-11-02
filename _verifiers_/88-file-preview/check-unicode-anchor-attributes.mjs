/*
---
title: Unicode author anchor attribute HTTP regression
version: 1.0.0
description: ASCII anchor attribute names with Unicode values retain real Markdown rendering through the delivered file route
grounded_in:
  - source: owner requested regression for the Rust anchor helper byte scan
---
*/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

import { endChild, heddleCommand, repoRoot, scratchRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Actual built CLI /api/file, not a source-module proxy. HEDDLE_BIN selects the
 * Rust CLI; the caller builds first. No browser, model request or private data.
 * Both fixtures put é, 文字 and 😀 in ASCII-named id/title attributes BEFORE
 * href, then require real rendered prose and preserved safe author fragments.
 * The old Rust helper's panic was caught and caused whole-document unrendered
 * fallback; this is a rendering regression, not a claim that the server aborted.
 * This does not judge all sanitizer grammar or Unicode attribute names.
 */
const VALUES = ['é', '文字', '😀']
const REQUEST_MS = 10_000
const MAX_BODY_BYTES = 1_000_000

function document(withNotes) {
  return [
    '# Unicode author anchors',
    '',
    'Ordinary prose with **rendered emphasis** before the author anchors.',
    '',
    ...VALUES.map((value) => `Author prose <a id="author-${value}" title="${value}" href="#author-${value}">safe author ${value}</a> and <a id="unsafe-${value}" title="${value}" href="java&#x09;script:alert(1)">unsafe author ${value}</a>.`),
    '',
    ...(withNotes ? ['Citation prose[^n].', '', '[^n]: Preserved **note emphasis**.', ''] : []),
  ].join('\n')
}

// Keep the timeout active through body consumption, not merely response headers.
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
      // Drain later logs without retaining unbounded output.
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
    const onExit = (code, signal) => finish(new Error(`Unicode anchor server exited (${code ?? signal}) before startup\n${output}`))
    const timer = setTimeout(() => finish(new Error(`Unicode anchor server printed no URL within 20 seconds\n${output}`)), 20_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function withFileServer(withNotes, check) {
  // mkdtemp never pre-deletes a name and never touches another verifier's home.
  mkdirSync(scratchRoot, { recursive: true })
  const root = realpathSync(scratchRoot)
  const owned = []
  const allocate = (label) => {
    const prefix = `unicode-anchor-${label}-`
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
    const path = join(work, withNotes ? 'with-notes.md' : 'without-notes.md')
    const source = document(withNotes)
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
    assert.notEqual(body.html, source, 'endpoint must not return the source as the preview')
    check(body.html)
  } finally {
    let stopped = true
    if (child?.pid) stopped = await endChild(child, { graceMs: 3000 }) !== 'stuck'
    // Never remove fixtures belonging to a still-running child. Check each exact
    // resolved allocation immediately before deletion; never delete scratchRoot.
    if (stopped) {
      for (const { path, prefix } of owned) {
        assert.equal(resolve(path), path, 'cleanup target is the recorded absolute allocation')
        assert.equal(realpathSync(path), path, 'cleanup target has not become a symlink')
        assert.equal(dirname(path), root, 'cleanup stays in this checkout scratch root')
        assert.ok(basename(path).startsWith(prefix), 'cleanup target is this owned fixture')
        rmSync(path, { recursive: true, force: false })
      }
    }
    assert.ok(stopped, 'Unicode anchor server exits within bounded cleanup; fixtures retained if stuck')
  }
}

// Fixture-only attribute inspection, not a second general-purpose sanitizer.
function attributes(tag) {
  const result = {}
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3]
  }
  return result
}

function assertRendered(html, withNotes) {
  assert.doesNotMatch(html, /\bclass\s*=\s*["'][^"']*\bunrendered\b/i, 'no caught-panic whole-document fallback')
  assert.match(html, /<h1\b[^>]*>Unicode author anchors<\/h1>/, 'heading proves real Markdown rendering')
  assert.match(html, /<p\b[^>]*>Ordinary prose with <strong\b[^>]*>rendered emphasis<\/strong> before the author anchors\.<\/p>/, 'ordinary Markdown prose remains rendered, not escaped source')
  assert.doesNotMatch(html, /\*\*rendered emphasis\*\*|&lt;a\b/i, 'source markup is not the whole-document preview')
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    ...attributes(match[1]), text: match[2],
  }))
  for (const value of VALUES) {
    const safe = anchors.filter((anchor) => anchor.text === `safe author ${value}`)
    assert.equal(safe.length, 1, `one rendered safe author anchor for ${value}`)
    assert.equal(safe[0].id, `author-${value}`, `Unicode author id survives for ${value}`)
    assert.equal(safe[0].title, value, `Unicode title before href survives for ${value}`)
    assert.equal(safe[0].href, `#author-${value}`, `safe author fragment is preserved for ${value}`)
    const unsafe = anchors.filter((anchor) => anchor.text === `unsafe author ${value}`)
    assert.equal(unsafe.length, 1, `unsafe author anchor keeps readable label for ${value}`)
    assert.equal(unsafe[0].id, `unsafe-${value}`, `unsafe anchor's unrelated author id survives for ${value}`)
    assert.equal(unsafe[0].title, value, `unsafe anchor's unrelated title survives for ${value}`)
    assert.equal(unsafe[0].href, undefined, `entity-obfuscated javascript href is refused for ${value}`)
  }
  assert.deepEqual(anchors.filter((anchor) => anchor.href !== undefined).map((anchor) => anchor.href).sort(),
    VALUES.map((value) => `#author-${value}`).sort(), 'only the three safe authored fragment hrefs remain')
  assert.doesNotMatch(html, /java&#x09;script:|javascript:|alert\(1\)/i, 'unsafe URI payload is absent from rendered output')
  if (withNotes) {
    assert.doesNotMatch(html, /\[\^n\]/, 'citation and definition syntax are rendered')
    assert.match(html, /Citation prose<sup>1<\/sup>/, 'the same Unicode fixture also renders its note citation')
    assert.match(html, /Preserved <strong\b[^>]*>note emphasis<\/strong>/, 'note body remains rendered')
    assert.match(html, /<section\b[^>]*class="footnotes"[^>]*>/, 'rendered note remains in the footnote section')
    assert.match(html, /↩/, 'plain note return marker survives')
  } else {
    assert.doesNotMatch(html, /class="footnotes"|<sup>/, 'no notes were invented in the note-free fixture')
  }
}

for (const withNotes of [false, true]) {
  test(`Unicode id/title before href retain rendered Markdown ${withNotes ? 'with' : 'without'} footnotes through /api/file`, { timeout: 60_000 }, async () => {
    await withFileServer(withNotes, (html) => assertRendered(html, withNotes))
  })
}
