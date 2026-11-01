import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('quoted resource attributes are rewritten, and relative CSS remains an explicit limitation', () => {
  const html = rewriteResources(
    '<link rel="stylesheet" href="s.css"><a href="page.html#part">x</a><img srcset="a.png 1x, b.png 2x"><style>@import "nested.css"; h1 { background: url(bg.png) }</style>',
    '/docs',
    serve,
  )
  assert.match(html, /href="\/api\/raw\?path=%2Fdocs%2Fs\.css"/, 'a stylesheet')
  assert.match(html, /href="\/api\/raw\?path=%2Fdocs%2Fpage\.html#part"/, 'a link keeps its fragment')
  assert.match(html, /srcset="\/api\/raw\?path=%2Fdocs%2Fa\.png 1x, \/api\/raw\?path=%2Fdocs%2Fb\.png 2x"/, 'and a srcset keeps its descriptors')
  // CSS url()/@import are not resource attributes. They were never served through the raw route by the old
  // filesystem base either; full CSS dependency rewriting is a separate capability, not a policy exception.
  assert.match(html, /url\(bg\.png\)/, 'relative CSS is not claimed as supported')
  assert.match(html, /@import "nested\.css"/, 'nor relative CSS imports')
})

test('source base is absent from the response before DOMPurify can parse it, without changing valid resources', () => {
  const source = '<head><BaSe data-note="quoted > bracket" href="https://example.invalid/hostile/"><base href=//example.invalid/second/></head><body><link rel="stylesheet" href="theme.css"><img src="a.png"></body>'
  assert.equal(
    rewriteResources(source, '/docs', serve),
    '<head></head><body><link rel="stylesheet" href="/api/raw?path=%2Fdocs%2Ftheme.css"><img src="/api/raw?path=%2Fdocs%2Fa.png"></body>',
    'forbidding base only after detached browser parsing is too late to prevent a base-uri console violation',
  )
})

test('base filtering preserves comments, escaped code, raw text and quoted attribute text', () => {
  const source = '<!-- <base target="comment >"> --><pre><code>&lt;base href=example&gt;</code></pre><script>const sample = "<base target=script>";</script><style>p::after { content: "<base target=style>" }</style><textarea><base target=textarea></textarea><title><base target=title></title><div title="<base target=attribute>">base text</div><baseball>unchanged</baseball>'
  assert.equal(rewriteResources(`${source}<base href="https://example.invalid/">`, '/docs', serve), source)
})

for (const tag of ['<BASE>', "<base\nhref = 'https://example.invalid/a>b'>", '<base href=https://example.invalid/>', '<base/href="https://example.invalid/">']) {
  test(`base filtering recognizes an actual token: ${tag}`, () => {
    assert.equal(rewriteResources(`before${tag}after`, '/docs', serve), 'beforeafter')
  })
}

test('base filtering handles comment endings and disabled-scripting noscript without changing Unicode offsets', () => {
  assert.equal(rewriteResources('İ雪<!--><base href="https://example.invalid/"><!-- hidden <base> --!><noscript><base href="https://example.invalid/"></noscript>', '/docs', serve), 'İ雪<!--><!-- hidden <base> --!><noscript></noscript>')
  assert.equal(rewriteResources('<div title="a > <base>">ok</div><base title=unquoted" href=https://example.invalid/>end', '/docs', serve), '<div title="a > <base>">ok</div>end')
})

test('base removal cannot splice DATA text into a new base or comment', () => {
  for (const [source, expected] of [
    ['<<base>base href=https://example.invalid/>x', '&lt;base href=https://example.invalid/>x'],
    ['<<base>!-- hidden --><base href=https://example.invalid/>x', '&lt;!-- hidden -->x'],
    ['<<base><base>base href=https://example.invalid/>x', '&lt;base href=https://example.invalid/>x'],
    ['İ雪<<<base>base href=https://example.invalid/>x', 'İ雪<&lt;base href=https://example.invalid/>x'],
    ['<div title="<">text</div><base>x', '<div title="<">text</div>x'],
    ['<!-- < --><base>x', '<!-- < -->x'],
    ['<textarea><</textarea><base>x', '<textarea><</textarea>x'],
  ]) {
    assert.equal(rewriteResources(source!, '/docs', serve), expected, source)
  }
})

test('many base removals protect each splice with bounded output growth', () => {
  const count = 4096
  const source = '<<base><base>base href=https://example.invalid/>x'.repeat(count)
  const expected = '&lt;base href=https://example.invalid/>x'.repeat(count)
  const output = rewriteResources(source, '/docs', serve)
  assert.equal(output, expected)
  assert.ok(output.length <= source.length + 3 * count, 'at most one entity expansion per splice; no fixed-point rescans')
  assert.equal(
    rewriteResources(`<${'<base>'.repeat(count)}base href=https://example.invalid/>x`, '/docs', serve),
    '&lt;base href=https://example.invalid/>x',
    'adjacent removals do not repeatedly escape an already protected output boundary',
  )
})

test('base filtering applies inside nested markup without removing neighbouring elements', () => {
  assert.equal(rewriteResources('<template><base href="https://example.invalid/"><p>template</p></template><svg><base href="https://example.invalid/"></base><text>svg</text></svg>', '/docs', serve), '<template><p>template</p></template><svg></base><text>svg</text></svg>')
})

test('the allow-list keeps a reading pane and leaves out everything that acts', () => {
  for (const tag of ['p', 'h1', 'img', 'table', 'pre', 'style', 'link']) {
    assert.ok(ALLOWED_TAGS.includes(tag), `${tag} is allowed`)
  }
  for (const tag of ['script', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'base']) {
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
  assert.match(PREVIEW_CSP, /base-uri 'none'/, 'no source or injected base may alter URL resolution')
})

test('Rust and TypeScript use exactly the same restrictive preview CSP', () => {
  const rust = readFileSync(new URL('../rust/crates/heddle-server/src/preview.rs', import.meta.url), 'utf8')
  const policy = rust.match(/pub const PREVIEW_CSP: &str = "([^"]+)";/)?.[1]
  assert.equal(policy, PREVIEW_CSP)
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
