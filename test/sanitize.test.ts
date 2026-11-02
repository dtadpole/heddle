import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sanitizeHtml } from '../src/server/sanitize.ts'

/**
 * Unit tests for the allow-list over rendered HTML.
 *
 * This file is where the framework's trust boundary is stated, so it is tested on its own rather than only through
 * the markdown renderer: a document is untrusted text, and every path through here has to reduce it to elements
 * and attributes a document view shows.
 */

test('an element that is not on the list is dropped and its text kept', () => {
  assert.equal(sanitizeHtml('<p>a <custom-thing>b</custom-thing> c</p>'), '<p>a b c</p>')
  assert.equal(sanitizeHtml('<p>keep <b>bold</b></p>'), '<p>keep bold</p>')
})

test('an element whose content is not content is dropped with it', () => {
  /**
   * Keeping the text of a `script` or a `style` shows a reader code that was never meant to be read, and is how a
   * sanitizer that only strips tags ends up rendering an attack as prose.
   */
  assert.equal(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>')
  assert.equal(sanitizeHtml('<style>p { color: red }</style>ok'), 'ok')
  assert.equal(sanitizeHtml('<iframe src="https://evil.example"></iframe>ok'), 'ok')
})

test('an attribute that is not on the list is dropped, including handlers', () => {
  assert.equal(sanitizeHtml('<a href="/x" onclick="steal()">x</a>'), '<a href="/x">x</a>')
  assert.equal(sanitizeHtml('<img src="/x.png" onerror="steal()">'), '<img src="/x.png">')
  assert.equal(sanitizeHtml('<img src="/x.png" srcset="evil.png">'), '<img src="/x.png">')
  assert.equal(sanitizeHtml('<p style="position:fixed">x</p>'), '<p>x</p>')
})

test('unknown Unicode attribute names preserve content', () => {
  // TypeScript control for the Rust scanner's UTF-8 cursor; no product or attribute grammar change.
  for (const name of ['é', '文字', '😀', 'unknowné', 'unknown文字', 'unknown😀']) {
    assert.equal(sanitizeHtml(`<p ${name}="x">ok</p>`), '<p>ok</p>')
    assert.equal(
      sanitizeHtml(`<p ${name}="x" title="文字 😀" width="12">ok</p>`),
      '<p title="文字 😀" width="12">ok</p>',
      `allowed attributes after ${name} still retain their values`,
    )
  }
})

test('a URL attribute is decided by the caller', () => {
  const url = (value: string) => (value.startsWith('https://') ? value : null)
  assert.equal(sanitizeHtml('<a href="https://ok.example">x</a>', { url }), '<a href="https://ok.example">x</a>')
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>', { url }), '<a>x</a>')
  assert.equal(sanitizeHtml('<img src="http://no.example/x.png">', { url }), '<img>')
})

test('a comment, a declaration, and a processing instruction carry nothing and go', () => {
  assert.equal(sanitizeHtml('a<!-- secret -->b'), 'ab')
  assert.equal(sanitizeHtml('a<!DOCTYPE html>b'), 'ab')
  assert.equal(sanitizeHtml('a<?xml version="1.0"?>b'), 'ab')
})

test('the text between tags is passed through, because the parser already escaped it', () => {
  /**
   * Escaping it again is the defect this whole output-side design exists to avoid: `1 &lt; 2` in a code block
   * became `1 &amp;lt; 2` when the source was escaped before parsing.
   */
  assert.equal(sanitizeHtml('<code>1 &lt; 2 &amp;&amp; 3 &gt; 2</code>'), '<code>1 &lt; 2 &amp;&amp; 3 &gt; 2</code>')
})

test('a quote in an attribute cannot break out of it', () => {
  assert.equal(sanitizeHtml('<a title=\'a"b\'>x</a>'), '<a title="a&quot;b">x</a>')
})

test('quoted, single-quoted and unquoted attributes are all read', () => {
  assert.equal(sanitizeHtml('<img alt="double" src=\'/single.png\'>'), '<img alt="double" src="/single.png">')
  assert.equal(sanitizeHtml('<img alt=bare src=/plain.png>'), '<img alt="bare" src="/plain.png">')
})

test('a bare `<` that begins no tag is text, and is not swallowed', () => {
  assert.equal(sanitizeHtml('2 < 3 and 5 > 4'), '2 &lt; 3 and 5 > 4')
})

test('an allowed element keeps its structure and its class', () => {
  const table = '<table class="t"><thead><tr><th align="right">a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
  assert.equal(sanitizeHtml(table), table)
})

test('sanitizing twice changes nothing the second time', () => {
  /** Idempotence is what lets a caller sanitize at more than one layer without wondering which ran. */
  const once = sanitizeHtml('<p onclick="x">a <script>bad()</script><b>b</b></p>')
  assert.equal(sanitizeHtml(once), once)
})

test('the one attribute this project writes survives, and no other data attribute does', () => {
  /**
   * The allow-list has a second list for the attribute this project adds itself, and it is a **name** rather than the
   * `data-` prefix. Measured why: a link that names a workspace file is marked with `data-heddle-path`, the sanitizer
   * dropped it with the other unknown attributes, and the panel had no way to know the link was one to follow — the
   * markup looked correct and clicking it navigated away or did nothing.
   */
  assert.equal(
    sanitizeHtml('<a href="/x" data-heddle-path="/Users/zhenc/heddle/README.md">x</a>'),
    '<a href="/x" data-heddle-path="/Users/zhenc/heddle/README.md">x</a>',
    'the path attribute survives',
  )
  assert.equal(
    sanitizeHtml('<a href="/x" data-onclick="steal()">x</a>'),
    '<a href="/x">x</a>',
    'while another data attribute does not, because the rule is a name and not a prefix',
  )
})

test('a link may open beside the document, and `target` is allowed deliberately', () => {
  /**
   * Measured: the renderer wrote `target="_blank"` on a link to another site and this dropped it with the other
   * unknown attributes, so following a link out of a document replaced the panel. It is allowed by name, and `rel`
   * with it — `target="_blank"` without `noopener` lets the opened page reach back through `window.opener`.
   */
  assert.equal(
    sanitizeHtml('<a href="https://x.example" target="_blank" rel="noreferrer noopener">x</a>'),
    '<a href="https://x.example" target="_blank" rel="noreferrer noopener">x</a>',
    'both survive together',
  )
})
