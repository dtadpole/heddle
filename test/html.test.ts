import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ALLOWED_ATTRS, ALLOWED_TAGS, isHtmlDocument, PREVIEW_CSP, rewriteResources } from '../src/server/html.ts'
import { rendererFor, renderSource } from '../src/server/code.ts'

/**
 * Unit tests for the HTML preview.
 *
 * Two properties matter, and they are different in kind. The **rewrite** is what makes a document's own resources
 * load at all — a relative `src` means *beside this document*, and the browser would otherwise look for it at the
 * server root. The **allow-list** is what decides how little of a document a preview keeps, and it is asserted here
 * because it is the half that a browser check can only sample.
 */

const serve = (path: string): string => `/api/raw?path=${encodeURIComponent(path)}`

test('a relative resource is resolved beside its document, and a foreign one is left alone', () => {
  const html = rewriteResources(
    '<img src="icon.png"><img src="./a/icon.png"><img src="../up.png"><img src="https://x/y.png"><img src="/abs.png"><img src="data:image/png;base64,AA">',
    '/Users/zhenc/heddle/docs',
    serve,
  )
  assert.match(html, /src="\/api\/raw\?path=%2FUsers%2Fzhenc%2Fheddle%2Fdocs%2Ficon\.png"/, 'a sibling file')
  assert.match(html, /%2Fdocs%2Fa%2Ficon\.png/, 'a subfolder, with the dot removed')
  assert.match(html, /%2FUsers%2Fzhenc%2Fheddle%2Fup\.png/, 'a parent reference resolved')
  assert.match(html, /src="https:\/\/x\/y\.png"/, 'a remote file is the author’s choice')
  assert.match(html, /src="\/abs\.png"/, 'and an absolute address is already absolute')
  assert.match(html, /src="data:image\/png;base64,AA"/, 'a data URL is not a file to look for')
})

test('every attribute a browser fetches is rewritten, and a fragment is not a filename', () => {
  const html = rewriteResources(
    '<link rel="stylesheet" href="s.css"><a href="page.html#part">x</a><img srcset="a.png 1x, b.png 2x"><style>h1 { background: url(bg.png) }</style>',
    '/docs',
    serve,
  )
  assert.match(html, /href="\/api\/raw\?path=%2Fdocs%2Fs\.css"/, 'a stylesheet')
  assert.match(html, /href="\/api\/raw\?path=%2Fdocs%2Fpage\.html#part"/, 'a link keeps its fragment')
  assert.match(html, /srcset="\/api\/raw\?path=%2Fdocs%2Fa\.png 1x, \/api\/raw\?path=%2Fdocs%2Fb\.png 2x"/, 'and a srcset keeps its descriptors')
  /** A `url()` inside a stylesheet is not an attribute, so the `<base>` element is what resolves it. */
  assert.match(html, /url\(bg\.png\)/, 'a url() in CSS is left for the base element')
})

test('the allow-list keeps a reading pane and leaves out everything that acts', () => {
  for (const tag of ['p', 'h1', 'img', 'table', 'pre', 'style', 'link']) {
    assert.ok(ALLOWED_TAGS.includes(tag), `${tag} is allowed`)
  }
  for (const tag of ['script', 'iframe', 'form', 'input', 'button', 'object', 'embed']) {
    assert.ok(!ALLOWED_TAGS.includes(tag), `${tag} is not`)
  }
  for (const attribute of ['src', 'href', 'srcset', 'alt', 'style']) {
    assert.ok(ALLOWED_ATTRS.includes(attribute), `${attribute} is allowed`)
  }
  for (const attribute of ['onerror', 'onclick', 'onload', 'formaction', 'srcdoc']) {
    assert.ok(!ALLOWED_ATTRS.includes(attribute), `${attribute} is not`)
  }
})

test('the policy forbids script, framing and forms outright', () => {
  assert.match(PREVIEW_CSP, /script-src 'none'/, 'no script may run')
  assert.match(PREVIEW_CSP, /frame-src 'none'/, 'and nothing may be framed')
  assert.match(PREVIEW_CSP, /form-action 'none'/, 'and nothing may be submitted')
  assert.match(PREVIEW_CSP, /default-src 'none'/, 'with everything else denied by default')
})

test('an html file is a renderer of its own, and produces no markup on the server', () => {
  /**
   * Measured: without the branch, `renderSource` fell through to `text`, so a page was previewed by reading it out as
   * plain text — the behaviour this replaces. The markup is absent on purpose: the document comes from the HTML route
   * with its resources rewritten, and the client frames it.
   */
  assert.deepEqual(rendererFor('/x/page.html'), { renderer: 'html' })
  assert.deepEqual(rendererFor('/x/page.htm'), { renderer: 'html' })
  assert.deepEqual(renderSource('/x/page.html', '<h1>hi</h1>'), { renderer: 'html' })
  /** And XML is not a page, so the grammar it had is still there. */
  assert.deepEqual(rendererFor('/x/data.xml'), { renderer: 'code', language: 'xml' })
})

test('only an .html or .htm file is a page to preview, as DSH registers its HTML renderer', () => {
  for (const path of ['/w/page.html', '/w/PAGE.HTM', '/w/a.b/index.Html', 'C:\\w\\page.htm']) {
    assert.equal(isHtmlDocument(path), true, path)
  }
  // A Word document goes to DSH's Office renderer, text to its own; none is ever framed as a page.
  for (const path of ['/w/report.docx', '/w/notes.txt', '/w/readme.md', '/w/page.html.bak', '/w/html', '/w/.html', '/w/x.xhtml']) {
    assert.equal(isHtmlDocument(path), false, path)
  }
})
