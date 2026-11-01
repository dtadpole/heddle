import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { endChild, fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Issue #43 — functional footnotes through the delivered /api/file renderer and,
 * optionally, the actual File panel. This is not full Markdown grammar parity or
 * an exact DSH DOM contract. Rust/comrak and TypeScript/marked may wrap notes and
 * name anchors differently; the repeated citation, note blocks and safe return
 * links must work in either build. The caller builds; HEDDLE_BIN is honored.
 * Browser mode is headless and opt-in with HEDDLE_FOOTNOTE_BROWSER=1, subject to
 * the shared browserAvailable gate (including HEDDLE_VERIFY_UI=0).
 */
const DOCUMENT = [
  '# Functional footnotes',
  '',
  'First citation[^shared] and second citation[^shared].',
  '',
  '[^shared]: Footnote first paragraph with **bold note words**.',
  '',
  '    Footnote second paragraph with [safe note link](https://example.com/footnote) and [unsafe note link](javascript:window.__footnoteUnsafe=1).',
  '',
  '    - Footnote list item one',
  '    - Footnote list item two',
  '',
].join('\n')

const boundedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })

async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function printedUrl(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error(`footnote server printed no URL within 20 seconds\n${output}`)), 20_000)
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-64_000)
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) finish(null, match[1])
    }
    const onError = (error) => finish(error)
    const onExit = (code, signal) => finish(new Error(`footnote server exited (${code ?? signal}) before startup\n${output}`))
    const finish = (error, url) => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      // Continue draining the server's output without retaining an unbounded log.
      child.stdout.resume()
      child.stderr.resume()
      if (error) reject(error)
      else resolve(url)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function withFileServer(check) {
  const home = isolatedHome('footnotes')
  const work = fixtureDir('footnotes-work')
  let child
  try {
    const path = join(work, 'footnotes.md')
    writeFileSync(path, DOCUMENT)
    const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
    child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = await printedUrl(child)
    const handshake = await boundedFetch(url, { redirect: 'manual' })
    const setCookie = handshake.headers.get('set-cookie')
    assert.ok(setCookie, `token handshake sets a cookie (HTTP ${handshake.status})`)
    await handshake.arrayBuffer()
    const cookie = setCookie.split(';')[0]
    const origin = new URL(url).origin
    const registered = await boundedFetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: work }),
    })
    assert.equal(registered.status, 200, 'register this check’s own workspace')
    await registered.arrayBuffer()
    const response = await boundedFetch(`${origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })
    assert.equal(response.status, 200, 'actual file route accepts the Markdown fixture')
    const body = await response.json()
    assert.equal(body.renderer, 'markdown')
    assert.equal(typeof body.html, 'string')
    await check({ url, path, html: body.html })
  } finally {
    // Do not remove a running server's home/workspace. Failed startup is cleaned too.
    let stopped = true
    if (child && child.pid) stopped = await endChild(child, { graceMs: 3000 }) !== 'stuck'
    if (stopped) {
      removeDir(home)
      removeDir(work)
    }
    assert.ok(stopped, 'footnote server exits within bounded cleanup')
  }
}

// DSH policy: actual numeric superscripts and plain return markers, never generated click targets.
function attributes(tag) {
  const result = {}
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1].toLowerCase()] = match[2] ?? match[3]
  return result
}

function assertRenderedNotes(html) {
  assert.doesNotMatch(html, /\[\^shared\]/, 'no literal footnote citation or definition syntax')
  assert.equal(html.split('Footnote first paragraph').length - 1, 1, 'one shared note body, not one per citation')
  assert.match(html, /<p\b[^>]*>\s*Footnote first paragraph[\s\S]*?<\/p>/, 'first note paragraph is rendered')
  assert.match(html, /<p\b[^>]*>\s*Footnote second paragraph[\s\S]*?<\/p>/, 'second note paragraph is rendered')
  assert.match(html, /<strong\b[^>]*>bold note words<\/strong>/, 'bold inside the definition is rendered')
  assert.match(html, /<ul\b[^>]*>[\s\S]*?<li\b[^>]*>\s*Footnote list item one[\s\S]*?<li\b[^>]*>\s*Footnote list item two[\s\S]*?<\/ul>/, 'definition contains a rendered two-item list')
  assert.match(html, /unsafe note link/, 'sanitization retains unsafe link label as readable text')
  assert.doesNotMatch(html, /<script\b|\son\w+\s*=|(?:href|src)\s*=\s*["']\s*javascript:/i, 'no active script URL, script element or event handler')

  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    ...attributes(match[1]), text: match[2].replace(/<[^>]*>/g, '').trim(), index: match.index,
  }))
  assert.ok(anchors.some((a) => a.href === 'https://example.com/footnote' && a.text === 'safe note link'), 'safe note URL remains a link')
  const references = [...html.matchAll(/<sup>(\d+)<\/sup>/g)]
  assert.equal(references.length, 2, 'two visible plain numeric citations')
  assert.equal(references[0][1], references[1][1], 'repeated citation has the same note number')
  assert.ok(references.every((match) => match.index < html.indexOf('Footnote first paragraph')), 'citations precede their note')
  const section = html.match(/<section class="footnotes">([\s\S]*?)<\/section>/)?.[1]
  assert.ok(section?.includes('Footnote first paragraph'), 'definition remains in the footnote section')
  assert.equal((section.match(/↩/g) ?? []).length, 2, 'one plain return marker per occurrence')
  assert.doesNotMatch(html, /\bid="fn(?:ref)?-|\bhref="#fn(?:ref)?-/, 'no generated footnote IDs or click hrefs')

}

test('functional footnotes render repeated citations, note blocks and plain return markers through /api/file', { timeout: 60_000 }, async () => {
  await withFileServer(async ({ html }) => assertRenderedNotes(html))
})

test('functional footnotes appear in the actual File panel without active javascript', { timeout: 100_000 }, async (context) => {
  if (!skipUnless(context, process.env.HEDDLE_FOOTNOTE_BROWSER === '1', 'optional headless footnote panel check — set HEDDLE_FOOTNOTE_BROWSER=1')) return
  if (!skipUnless(context, browserAvailable(), 'shared UI/browser availability gate')) return
  await withFileServer(async ({ url, path, html }) => {
    assertRenderedNotes(html)
    let browser
    // If startup times out but later resolves, close that browser too.
    const opening = openBrowser({ width: 1400, height: 900 })
    let abandoned = false
    void opening.then((page) => abandoned ? page.close() : undefined).catch(() => {})
    try {
      browser = await within(opening, 20_000, 'headless browser startup')
      await browser.goto(url, 20_000)
      await browser.waitFor('typeof showFile === "function"', 15_000)
      await browser.evaluate(`showFile({ path: ${JSON.stringify(path)} })`)
      await browser.waitFor('document.getElementById("file-body")?.textContent.includes("Footnote second paragraph")', 15_000)
      const panel = JSON.parse(await browser.evaluate(`JSON.stringify((() => {
        const body = document.getElementById('file-body')
        const visible = (element) => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
        const links = [...body.querySelectorAll('a')]
        return {
          visible: visible(body), text: body.textContent,
          strong: [...body.querySelectorAll('strong')].some(x => x.textContent === 'bold note words' && visible(x)),
          list: [...body.querySelectorAll('ul')].some(x => x.textContent.includes('Footnote list item one') && x.textContent.includes('Footnote list item two') && visible(x)),
          references: [...body.querySelectorAll('sup')].filter(x => /^\\d+$/.test(x.textContent.trim()) && !x.querySelector('a') && visible(x)).length,
          footnoteTargets: body.querySelectorAll('[id^="fn-"],[id^="fnref-"],a[href^="#fn-"],a[href^="#fnref-"]').length,
          unsafe: links.some(x => x.protocol === 'javascript:'),
          activeMarkup: !!body.querySelector('script,[onclick],[onerror],[onload]'),
          ran: window.__footnoteUnsafe === 1,
        }
      })())`))
      assert.ok(panel.visible, 'actual File panel is visible')
      assert.doesNotMatch(panel.text, /\[\^shared\]/)
      assert.equal(panel.text.split('Footnote first paragraph').length - 1, 1)
      assert.match(panel.text, /Footnote second paragraph/)
      assert.equal(panel.references, 2)
      assert.equal(panel.footnoteTargets, 0, 'plain citations cannot jump to another answer')
      assert.ok(panel.strong, 'note emphasis is visible as strong text')
      assert.ok(panel.list, 'note list is visible')
      assert.equal(panel.unsafe, false, 'no active javascript link in the panel DOM')
      assert.equal(panel.activeMarkup, false)
      assert.equal(panel.ran, false, 'unsafe note URL has not executed')
    } finally {
      abandoned = true
      if (browser) await within(browser.close(), 10_000, 'headless browser cleanup')
    }
  })
})
