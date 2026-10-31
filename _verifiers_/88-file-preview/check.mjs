import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — one preview surface.
 *
 * **The claim it decides:** a file is previewed in exactly one place — the File panel a click on the left panel
 * opens — and each file type is rendered with the library appropriate to it.
 *
 * The owner's request of 2026-10-11, and the reason it is a claim rather than a preference: the project had grown
 * **two** preview surfaces. A session offered Chat, Trajectory and Docs, where Docs listed the repository's
 * documents and rendered them; and a click on a file in the left panel opened a File tab that rendered the same
 * markdown through a second pane — which was styled separately, and was in fact unstyled until that was measured.
 * Two surfaces meant two renderers, two style blocks and two places for a document to look wrong.
 *
 * It is judged in a browser because every part of it is a rendering claim: the ring, the pane that appears, and the
 * markup each library produces. An API that answers correctly and a panel that draws text says nothing about any
 * of it.
 */

const CAPABILITY = 'one preview surface, rendering each file type with the library appropriate to it'

/**
 * A workspace with one file of each kind the preview renders.
 *
 * It used to be the project checkout at a fixed path from another machine (`/Users/<account>/heddle`), which made the
 * check unjudgeable here: the route registered a folder that did not exist, so every read answered nothing and the
 * first test failed at its first assertion. The files below are the same kinds of content that checkout held, written
 * by the check itself — a document with frontmatter, a table, an inline code span, a script and an inline handler;
 * source; a config; a license; two documents that link to each other; and an image a document embeds.
 */
function writeWorkspace(work) {
  mkdirSync(work, { recursive: true })
  const prose = Array.from({ length: 12 }, (_, index) =>
    `Paragraph ${index + 1}: the preview has to draw a document as a document, with its blocks and its inline marks, ` +
    'and every sentence here is long enough that the rendered text reads as a page rather than as a sample. A renderer ' +
    'that drops a paragraph is a renderer that loses the document.').join('\n\n')
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
    '<title>heddle</title>',
    '<desc>the mark, drawn in a few strokes and padded so the asset is a real file rather than a placeholder</desc>',
    '<rect x="0" y="0" width="64" height="64" rx="12" fill="#E68000"/>',
    '<path d="M10 22 L54 22 M10 32 L54 32 M10 42 L54 42" stroke="#1b1b1b" stroke-width="3" stroke-linecap="round"/>',
    '<circle cx="20" cy="22" r="4" fill="#fff"/><circle cx="32" cy="32" r="4" fill="#fff"/><circle cx="44" cy="42" r="4" fill="#fff"/>',
    '<!-- This comment exists so the file is comfortably over the half-kilobyte the raw route must carry; an image',
    '     smaller than that would pass the byte-count assertion for the wrong reason. -->',
    '</svg>',
  ].join('\n')
  writeFileSync(join(work, 'AGENTS.md'), [
    '---',
    'title: The workspace conventions',
    'status: active',
    '---',
    '',
    '# Conventions',
    '',
    'This document is the workspace entry point, and its preview is what the file panel is judged by.',
    '',
    '| Folder | What it holds |',
    '|---|---|',
    '| `_context_` | what the work depends on |',
    '| `_tools_` | the instruments |',
    '',
    'A path is written with `inline code`, and a document may carry markup that must not survive:',
    '',
    '<script>window.__pwned = 1</script>',
    '<span onclick="window.__pwned = 1">an inline handler</span>',
    '',
    prose,
    '',
    '## Read next',
    '',
    '[`INDEX.md`](INDEX.md) points at the rest.',
  ].join('\n'))
  writeFileSync(join(work, 'ULTIMATE_GOAL.md'), [
    '# Ultimate goal',
    '',
    'The goal is stated here, and it links to the files that carry it:',
    '',
    '- [`INDEX.md`](INDEX.md) — the index',
    '- [`AGENTS.md`](AGENTS.md) — the conventions',
    '',
    prose,
  ].join('\n'))
  writeFileSync(join(work, 'INDEX.md'), ['# Index', '', prose, '', '[`AGENTS.md`](AGENTS.md)'].join('\n'))
  writeFileSync(join(work, 'README.md'), ['# Heddle', '', '![the mark](heddle.svg)', '', prose].join('\n'))
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ name: 'heddle', version: '0.0.1', private: true, description: 'a harness and agent framework', scripts: { build: 'tsc', test: 'node --test' } }, null, 2)}\n`)
  writeFileSync(join(work, 'cordis.yml'), ['plugins:', '  - name: session', '    config:', '      root: .heddle', ''].join('\n'))
  writeFileSync(join(work, 'LICENSE'), ['MIT License', '', 'Copyright (c) 2026 the heddle authors', '', 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.', ''].join('\n'))
  writeFileSync(join(work, 'heddle.svg'), svg)
}

/** Start the Web UI and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`the server did not print a URL within 20 seconds\n${output}`))
      }, 20_000)
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          clearTimeout(timeout)
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
    })().catch(reject)
  })
}

async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

// #126: offline HTTP + headless browser regression, run against either CLI via HEDDLE_BIN.
// PNG only; deliberately no claim for other image formats or zoom controls.
test('standalone PNG decodes in the File panel behind the existing authorization boundary', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('png-preview')
  const work = fixtureDir('png-preview')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  const path = join(work, 'pixel & snow.PNG')
  const broken = join(work, 'broken.png')
  writeFileSync(path, png)
  writeFileSync(broken, 'not a PNG')
  const outside = join(home, 'outside.png')
  writeFileSync(outside, png)
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  let server
  let browser
  const pngFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) })
  try {
    server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], { HEDDLE_HOME: home, HEDDLE_CONFIG: config })
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await pngFetch(`${origin}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ path: work }) })
    const fileUrl = `${origin}/api/file?path=${encodeURIComponent(path)}`
    assert.equal((await pngFetch(fileUrl, { redirect: 'manual' })).status, 401)
    const metadata = await pngFetch(fileUrl, { headers: { cookie } })
    assert.equal(metadata.status, 200, '#126: PNG must not be refused by the text reader with 415')
    const body = await metadata.json()
    assert.equal(body.renderer, 'image')
    assert.equal(body.image.mediaType, 'image/png')
    assert.equal(body.image.src, `/api/raw?path=${encodeURIComponent(path)}`)
    assert.equal(body.text, undefined)
    const rawUrl = origin + body.image.src
    assert.equal((await pngFetch(rawUrl, { redirect: 'manual' })).status, 401)
    const raw = await pngFetch(rawUrl, { headers: { cookie } })
    assert.equal(raw.headers.get('content-type'), 'image/png')
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png)
    assert.equal((await pngFetch(`${origin}/api/file?path=${encodeURIComponent(outside)}`, { headers: { cookie } })).status, 400)
    assert.equal((await pngFetch(`${origin}/api/raw?path=${encodeURIComponent(outside)}`, { headers: { cookie } })).status, 404)
    assert.equal((await pngFetch(`${origin}/api/file?path=${encodeURIComponent(join(work, 'missing.png'))}`, { headers: { cookie } })).status, 404)
    browser = await openBrowser({ width: 1400, height: 900 })
    await browser.goto(server.url)
    await browser.waitFor('typeof showFile === "function" && document.querySelectorAll("#tree .row").length > 0', 20_000)
    await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree .row')].find(x => x.querySelector('.label')?.textContent === ${JSON.stringify(work.split('/').pop())})
      if (row?.closest('li').getAttribute('aria-expanded') === 'false') row.click()
    })()`)
    assert.ok(await browser.waitFor('[...document.querySelectorAll("#tree .row")].some(x => x.querySelector(".label")?.textContent === "pixel & snow.PNG")', 20_000), 'PNG appears in the workspace tree')
    await browser.evaluate('[...document.querySelectorAll("#tree .row")].find(x => x.querySelector(".label")?.textContent === "pixel & snow.PNG").click()')
    assert.ok(await browser.waitFor('(() => { const img = document.querySelector("#file-body img"); return img && !img.hidden && img.complete && img.naturalWidth === 1 })()', 20_000), 'PNG actually decodes, not just an img tag')
    const preview = JSON.parse(await browser.evaluate('JSON.stringify({alt: document.querySelector("#file-body img").alt, referrer: document.querySelector("#file-body img").referrerPolicy, head: document.getElementById("file-head").textContent, frameHidden: document.getElementById("file-html").hidden})'))
    assert.match(preview.alt, /Image preview: pixel/)
    assert.equal(preview.referrer, 'no-referrer')
    assert.ok(preview.frameHidden)
    assert.doesNotMatch(preview.head, /undefined|lines/)
    await browser.evaluate(`showFile({path: ${JSON.stringify(broken)}})`)
    assert.ok(await browser.waitFor('document.querySelector("#file-body [role=alert]")?.textContent.includes("could not be displayed")', 20_000), 'decode failure is accessible and visible')
  } finally {
    if (browser) await browser.close()
    server?.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('the server renders each file type, and the page offers no second surface', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('preview-api')
  const work = fixtureDir('preview-api')
  writeWorkspace(work)
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: work }),
    })

    /**
     * Each type through the route the File panel uses. The point is not that markup exists but that the **right
     * library** produced it: markdown arrives as elements with its fenced code tokenised, source arrives with the
     * highlighter's classes, and something with no renderer arrives as text with no markup at all.
     */
    const read = async (path) => (await fetch(`${origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })).json()

    const document = await read(join(work, 'AGENTS.md'))
    assert.equal(document.renderer, 'markdown', 'a document is rendered as markdown')
    assert.match(String(document.html), /<h1>/, 'with block elements, not its source')
    assert.match(String(document.html), /<table>/, 'including a table')

    const source = await read(join(work, 'package.json'))
    assert.equal(source.renderer, 'code', 'a source file is rendered as code')
    assert.equal(source.language, 'json', 'with the language its extension names')
    assert.match(String(source.html), /hljs-/, "carrying the highlighter's own classes")
    assert.match(String(source.html), /class="ln"/, 'and a line gutter')

    const config = await read(join(work, 'cordis.yml'))
    assert.equal(config.renderer, 'code', 'a yaml file is rendered as code rather than as text')
    assert.equal(config.language, 'yaml', 'which was measured as text before the map covered it')

    const plain = await read(join(work, 'LICENSE'))
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.html, undefined, 'with no markup produced for it')

    /**
     * What the markdown library must keep doing, carried over from the part this one replaced.
     *
     * A document is untrusted text, so the two properties its tests assert are judged here as well, on a document
     * the server rendered rather than on a string: no element of the document's own survives, a refused link keeps
     * its label, and frontmatter is metadata rather than prose.
     */
    assert.ok(!String(document.html).includes('<script'), 'no element the document wrote survives')
    assert.match(String(document.html), /<section class="frontmatter">/, 'frontmatter is lifted into its own block')
    assert.ok(!String(document.html).includes('`'), 'and a code span is not shown as backticks')

    const hostile = await read(join(work, 'AGENTS.md'))
    assert.match(String(hostile.html), /<table>/, 'a table is a table, with its cells')
    assert.ok(!String(hostile.html).includes('onclick'), 'and no attribute of the document survives')

    /**
     * An embedded image is **served**, which is the half markdown could not do on its own.
     *
     * Measured: the renderer produced `<img src="heddle.svg">` and the browser asked for it at the server root, which
     * answered `404` — a document with an image showed alt text and a broken marker. The raw route serves a file's
     * bytes, with the type chosen so a browser renders an image and does **not** execute anything else.
     */
    const asset = await fetch(`${origin}/api/raw?path=${encodeURIComponent(join(work, 'heddle.svg'))}`, { headers: { cookie } })
    assert.equal(asset.status, 200, 'an image in a workspace is served')
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml', 'with the type its extension names')
    assert.equal(asset.headers.get('content-disposition'), 'inline', 'and inline, so it renders in the document')
    assert.ok((await asset.arrayBuffer()).byteLength > 500, 'with its bytes')

    /**
     * And a file a browser would **run** is not served inline, even though it is served.
     *
     * This is the rule that makes the route safe to give a session cookie: a workspace can hold an `.html` file, and
     * a route that handed that back as `text/html` would be a same-origin page the harness runs by being viewed.
     */
    const runnable = await fetch(`${origin}/api/raw?path=${encodeURIComponent(join(work, 'README.md'))}`, { headers: { cookie } })
    assert.equal(runnable.status, 200, 'a markdown file is served too')
    assert.notEqual(runnable.headers.get('content-type'), 'text/markdown', 'but not as something a browser renders as a page')
    assert.match(String(runnable.headers.get('content-disposition')), /attachment/, 'it is offered as a download instead')

    const outside = await fetch(`${origin}/api/raw?path=${encodeURIComponent('/etc/passwd')}`, { headers: { cookie } })
    assert.equal(outside.status, 404, 'a path outside every workspace root is not served')

    const refused = await fetch(`${origin}/api/file?path=${encodeURIComponent('/etc/passwd')}`, { headers: { cookie } })
    assert.equal(refused.status, 400, 'a file outside every workspace root is refused')

    /**
     * The second surface is **gone**, in the served page.
     *
     * Asserted on the markup the server sends, because that is what a client receives: a tab that is hidden by a
     * script still exists, and a document list beside it would still be fetched.
     */
    const page = await (await fetch(server.url, { headers: { cookie } })).text()
    assert.ok(!page.includes('data-view="docs"'), 'no Docs tab is offered')
    assert.ok(!page.includes('id="docs-list"'), 'and no document list is built')
    assert.ok(!/>Docs</.test(page), 'nor is the word offered as a control')
    assert.match(page, /data-view="file"/, 'while the file panel is there')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('an html document is previewed as a page, and nothing in it can act', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('html-view')
  const work = fixtureDir('html-view')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  /**
   * A document written for this check, with everything a preview must refuse: a script, an inline handler, an iframe,
   * a form, and a working image beside it — so the check can tell "the document's own resources load" from "the
   * document was reduced to text".
   */
  writeFileSync(
    join(work, 'page.html'),
    [
      '<!doctype html><html><head><title>Fixture</title>',
      '<style>h1 { color: rgb(1, 2, 3) }</style></head><body>',
      '<h1>Fixture page</h1>',
      '<img src="mark.svg" alt="beside it" width="40" height="40">',
      '<img src="missing.png" onerror="window.__pwned = 1">',
      '<script>window.__pwned = 1</script>',
      '<iframe src="https://example.com"></iframe>',
      '<form action="https://example.com"><input name="x"></form>',
      '</body></html>',
    ].join('\n'),
  )
  writeFileSync(join(work, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#E68000"/></svg>')

  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    /** The fixture is made a workspace, which is what makes its files reachable through the routes. */
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: work }),
    })

    /** The route's answer: the document with its resources rewritten, and the policy it must run under. */
    const payload = await (await fetch(`${origin}/api/html?path=${encodeURIComponent(join(work, 'page.html'))}`, { headers: { cookie } })).json()
    assert.ok(String(payload.html).includes(join(work, 'mark.svg').split('/').pop() ?? ''), 'the document came back')
    assert.match(String(payload.html), /\/api\/raw\?path=/, 'with its relative image pointed at the route that serves it')
    assert.match(String(payload.csp), /script-src 'none'/, 'and a policy that forbids script')

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 0', 20_000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
    /**
     * Open the workspace's folder — **idempotently**.
     *
     * A row toggles: clicking it opens a closed branch and closes an open one. The page now opens the first workspace on
     * a first visit (measured from DSH, which arrives with a branch open), so the old unconditional click closed the
     * branch it meant to open and the file was not in the tree. The intent is "make it visible", so the click happens
     * only when the branch says it is closed.
     */
    await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === ${JSON.stringify(work.split('/').pop() ?? '')})
      if (row === undefined) return false
      if (row.closest('li').getAttribute('aria-expanded') === 'false') row.click()
      return true
    })()`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
    const clicked = await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === 'page.html'); if (row === undefined) return false; row.click(); return true })()`)
    assert.ok(clicked, 'the page is in the tree')
    assert.ok(await browser.waitFor('!document.getElementById("file-html").hidden', 20_000), 'the frame is shown rather than the text pane')
    /**
     * Wait for the document's own image to **decode**, not merely to be requested.
     *
     * Measured: the reading was taken as soon as the frame appeared, and under the load of the whole part the image
     * had not finished — 0 of 2, while the same check passed alone. `complete && naturalWidth > 0` is the only reading
     * that means the browser has the picture.
     */
    await browser.waitFor(
      `(() => { const frame = document.getElementById('html-view'); const inner = frame.contentDocument; return inner !== null && [...inner.querySelectorAll('img')].some((image) => image.complete && image.naturalWidth > 0) })()`,
      15_000,
    )

    const framed = JSON.parse(
      await browser.evaluate(`(() => {
        const frame = document.getElementById('html-view')
        const inner = frame.contentDocument
        if (inner === null) return JSON.stringify({ reachable: false })
        const images = [...inner.querySelectorAll('img')]
        return JSON.stringify({
          reachable: true,
          sandbox: frame.getAttribute('sandbox'),
          scripts: inner.querySelectorAll('script').length,
          iframes: inner.querySelectorAll('iframe').length,
          forms: inner.querySelectorAll('form').length,
          inputs: inner.querySelectorAll('input').length,
          handlers: [...inner.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
          policy: inner.querySelector('meta[http-equiv="Content-Security-Policy"]') === null ? 'missing' : 'present',
          heading: (inner.querySelector('h1') || {}).textContent,
          headingColour: inner.querySelector('h1') === null ? null : getComputedStyle(inner.querySelector('h1')).color,
          images: images.length,
          imagesLoaded: images.filter((i) => i.complete && i.naturalWidth > 0).length
        })
      })()`),
    )
    assert.ok(framed.reachable, 'the frame holds a document')
    /**
     * The sandbox is the boundary, so it is asserted rather than assumed: `allow-same-origin` lets the frame fetch its
     * own resources through this server, and **no** `allow-scripts` is what stops the document running.
     */
    assert.equal(framed.sandbox, 'allow-same-origin', 'the frame allows resources and no scripts')
    assert.equal(framed.scripts, 0, 'a script element was removed')
    assert.equal(framed.handlers, 0, 'and an inline handler with it')
    assert.equal(framed.iframes, 0, 'nothing may be framed inside it')
    assert.equal(framed.forms + framed.inputs, 0, 'and nothing may be submitted')
    assert.equal(framed.policy, 'present', 'the document carries the policy the browser enforces')
    assert.equal(framed.heading, 'Fixture page', 'the page rendered as a page rather than as its source')
    assert.equal(framed.headingColour, 'rgb(1, 2, 3)', "with the document's own stylesheet applied")
    assert.ok(framed.imagesLoaded > 0, `and its own image loaded (${framed.imagesLoaded} of ${framed.images})`)
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('only an .html or .htm file is previewed as a page; a Word document or a text file is refused', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('html-only')
  const work = fixtureDir('html-only')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  /**
   * DSH frames a file as a page only through its HTML renderer, registered for `html` and `htm`; a `.docx` goes to its
   * Office renderer. So the HTML route answers the page, and refuses a Word document (here the zip header a real one
   * starts with, plus bytes that are not text) and a plain text file alike, instead of decoding either as markup.
   */
  writeFileSync(join(work, 'page.html'), '<!doctype html><h1>Only page</h1>')
  writeFileSync(join(work, 'report.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0xff, 0xfe, 0x9c, 0x00, 0x77, 0x6f, 0x72, 0x64]))
  writeFileSync(join(work, 'notes.txt'), 'plain words, not markup')
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ path: work }),
    })
    const preview = (leaf) => fetch(`${origin}/api/html?path=${encodeURIComponent(join(work, leaf))}`, { headers: { cookie } })

    const page = await preview('page.html')
    assert.equal(page.status, 200, 'the html document is previewed')
    assert.match(String((await page.json()).html), /Only page/, 'with its own markup')

    for (const leaf of ['report.docx', 'notes.txt']) {
      const refused = await preview(leaf)
      const body = await refused.text()
      assert.equal(refused.status, 415, `${leaf} is not a page to preview (HTTP ${refused.status}: ${body.slice(0, 160)})`)
      assert.match(body, /not an HTML document/, `${leaf} is refused by name, not decoded as markup`)
      assert.ok(!body.includes('"html"'), `${leaf} comes back with no html to frame`)
    }
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a click in the left panel opens the one preview, rendered for its type and styled', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('preview-ui')
  const work = fixtureDir('preview-ui')
  writeWorkspace(work)
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: work }),
    })

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 0', 20_000)
    /** The same idempotent open: the first workspace may already be open, and a click would close it. */
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree .row')
      if (row.closest('li').getAttribute('aria-expanded') === 'false') row.click()
      return true
    })()`)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 1', 20_000)

    const openFile = async (name) => {
      const found = await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === ${JSON.stringify(name)}); if (row === undefined) return false; row.click(); return true })()`)
      assert.ok(found, `${name} is in the tree`)
      /**
       * Wait for **this file**, not for a fixed moment.
       *
       * Measured: with a 1.5 s sleep the full-file run read the previous document — the reader was still drawing under
       * the load of the other checks — while the same check passed alone. Waiting on the pane's own header removes the
       * race instead of making it less likely.
       */
      assert.ok(
        await browser.waitFor(`document.getElementById('file-head').textContent.includes(${JSON.stringify(name)})`, 20_000),
        `${name} is the file the pane is showing`,
      )
      /**
       * And for the **placeholder to go**, not for the pane to have text.
       *
       * Measured: the pane says `reading…` while the fetch is in flight, and that is text — so a wait on "has text"
       * passed before the file arrived and the check read the previous file's renderer. The placeholder is the signal
       * that the read has finished, and it is the only one the page offers before the body is drawn.
       */
      assert.ok(
        await browser.waitFor(`document.getElementById('file-body').innerText.trim() !== 'reading…'`, 20_000),
        `${name} finished reading`,
      )
      return JSON.parse(
        await browser.evaluate(`(() => {
          const body = document.getElementById('file-body')
          const table = body.querySelector('table th')
          const gutter = body.querySelector('.ln')
          const code = body.querySelector('code')
          const heading = body.querySelector('h1')
          return JSON.stringify({
            ring: [...document.querySelectorAll('#views button')].filter((x) => !x.hidden).map((x) => x.textContent),
            fileHidden: document.getElementById('file').hidden,
            renderer: body.dataset.renderer,
            chars: body.innerText.length,
            highlighted: body.querySelectorAll('span[class^="hljs-"]').length,
            codeSize: parseFloat(getComputedStyle(body).fontSize),
            lineHeight: parseFloat(getComputedStyle(body).lineHeight),
            gutterWidth: (() => { const ln = body.querySelector('.ln'); return ln === null ? 0 : Math.round(ln.getBoundingClientRect().width) })(),
            gutterNarrow: (() => { const ln = body.querySelector('.ln'); return ln !== null && ln.getBoundingClientRect().width < 34 })(),
            stackIncludesCjk: /PingFang|YaHei|Heiti|Songti/i.test(getComputedStyle(body).fontFamily),
            links: body.querySelectorAll('a[data-heddle-path]').length,
            images: body.querySelectorAll('img').length,
            imagesLoaded: [...body.querySelectorAll('img')].filter((image) => image.complete && image.naturalWidth > 0).length,
            classes: new Set([...body.querySelectorAll('span[class^="hljs-"]')].map((span) => span.className)).size,
            colours: new Set([...body.querySelectorAll('span[class^="hljs-"]')].map((span) => getComputedStyle(span).color)).size,
            entityCodes: (body.innerText.match(/&#x?[0-9a-fA-F]+;/g) ?? []).length,
            gutter: gutter === null ? null : gutter.textContent,
            tableBorder: table === null ? null : getComputedStyle(table).borderTopWidth,
            inlineCodeBg: (() => { const c = body.querySelector('p code'); return c === null ? null : getComputedStyle(c).backgroundColor })(),
            headingBigger: heading === null ? null : parseFloat(getComputedStyle(heading).fontSize) > parseFloat(getComputedStyle(body).fontSize),
            codeFont: code === null ? null : getComputedStyle(code).fontFamily.includes('mono')
          })
        })()`),
      )
    }

    /** A document: the markdown library, and the styles the project shares for a rendered document. */
    const document = await openFile('AGENTS.md')
    assert.equal(document.fileHidden, false, 'a click shows the file panel')
    assert.deepEqual(document.ring, ['File'], 'and the ring offers the file alone, which is the one preview surface')
    assert.equal(document.renderer, 'markdown', 'the document is rendered as markdown')
    assert.ok(document.chars > 1_000, `and it holds the document (${document.chars} characters)`)
    assert.ok(document.tableBorder !== null && document.tableBorder !== '0px', `its table is a bordered table (${document.tableBorder})`)
    assert.notEqual(document.inlineCodeBg, 'rgba(0, 0, 0, 0)', 'an inline code span has its own background')
    assert.equal(document.headingBigger, true, 'a heading is larger than the body text')

    /** Source: the highlighting library, with a gutter, and no markdown rendering. */
    const source = await openFile('package.json')
    assert.equal(source.renderer, 'code', 'a source file is source')
    assert.ok(source.highlighted > 0, `coloured by the highlighter (${source.highlighted} spans)`)
    assert.equal(source.gutter, '1', 'with a line gutter starting at one')
    assert.equal(source.codeFont, true, 'in a monospace face')

    /**
     * And the colours are **applied**, which is the half that was missing when the owner reported it.
     *
     * Measured: `src/cli.ts` rendered 2702 spans and every one of them was white, because the theme rules named the
     * markdown pane and a source file is not one. Spans in the markup prove the library ran; only the computed
     * colour proves a reader can see what it decided.
     */
    assert.ok(source.classes > 1, `a source file holds more than one kind of token (${source.classes})`)
    assert.ok(
      source.colours > 1,
      `and those kinds resolve to different colours, so the theme reaches this pane (${source.colours})`,
    )

    /**
     * No entity code is shown to a reader.
     *
     * Measured: an import line read `from &#x27;node:fs&#x27;`, because the highlighter writes a single quote as the
     * hexadecimal `&#x27;` and this project's decoder listed the decimal `&#39;`. A renderer that leaves escaping in
     * the text has not finished its job, whatever the markup looks like.
     */
    assert.equal(source.entityCodes, 0, `no entity code is visible in the text (${source.entityCodes} found)`)

    /**
     * A link to a file in the workspace is followed **in the panel**.
     *
     * Measured, and it is the owner's report: `[x](DEPLOY.md)` asked the browser for `/DEPLOY.md`, which answered
     * `404`, so following a link lost the document being read. A plain click now opens the file here; the address
     * stays real, so the status bar and a middle-click still point somewhere.
     */
    const linked = await openFile('ULTIMATE_GOAL.md')
    assert.ok(linked.links > 0, `the document has links to other files (${linked.links})`)
    const followed = JSON.parse(
      await browser.evaluate(`(async () => {
        const anchor = [...document.querySelectorAll('#file-body a[data-heddle-path]')][0]
        if (anchor === undefined) return JSON.stringify({ missing: true })
        const before = location.pathname
        anchor.click()
        await new Promise((done) => setTimeout(done, 2_500))
        return JSON.stringify({
          before,
          after: location.pathname,
          head: document.getElementById('file-head').textContent,
          renderer: document.getElementById('file-body').dataset.renderer,
          chars: document.getElementById('file-body').innerText.length
        })
      })()`),
    )
    assert.ok(!followed.missing, 'a link to another file is marked for the panel')
    assert.equal(followed.after, followed.before, 'following it does not navigate the page away')
    assert.match(followed.head, /INDEX\.md|ULTIMATE_GOAL\.md|_verifiers_/, `the panel shows the file that was linked (${followed.head})`)
    assert.equal(followed.renderer, 'markdown', 'rendered, not shown as a source file')
    assert.ok(followed.chars > 500, `and its content is there (${followed.chars} characters)`)

    /**
     * The image in a document is **fetched and decoded**, not merely referenced.
     *
     * `naturalWidth > 0` is the only reading that proves it: an `<img>` with a broken source still exists in the DOM
     * and still has a `src`, so counting elements would pass while a reader sees a broken marker.
     */
    const illustration = await openFile('README.md')
    assert.ok(illustration.images > 0, `the document embeds an image (${illustration.images})`)
    assert.ok(
      illustration.imagesLoaded > 0,
      `and the browser loaded it (${illustration.imagesLoaded} of ${illustration.images} decoded)`,
    )

    /**
     * The code is set for reading, and it is set for **both appearances**.
     *
     * Two claims, each measured before it was made. The typography: a bare `monospace` resolved to whatever the
     * platform picked, with no CJK coverage, so a Chinese comment lost its column — the stack is now a named one
     * ending in the CJK faces. The appearance: the palette was written for a dark surface only, and the page paints
     * its own background, so on a light system the same pale tokens would have sat on white.
     */
    assert.ok(source.codeSize >= 11 && source.codeSize <= 14, `code is set at a readable size (${source.codeSize}px)`)
    assert.ok(
      source.lineHeight >= source.codeSize * 1.4,
      `with enough leading to read a long file (${source.lineHeight}px on ${source.codeSize}px)`,
    )
    assert.ok(source.stackIncludesCjk, 'and a stack with a CJK fallback, so a mixed line stays monospaced')
    assert.ok(source.gutterNarrow, `the line numbers are a margin note rather than a column (${source.gutterWidth}px)`)

    /** Neither: shown as it is, and still not interpreted. */
    const plain = await openFile('LICENSE')
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.highlighted, 0, 'with nothing invented for it')
    assert.ok(plain.chars > 100, 'and its content is there')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
