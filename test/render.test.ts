import assert from 'node:assert/strict'
import { test } from 'node:test'

import { languageFor, renderCode, renderSource, rendererFor } from '../src/server/code.ts'

/**
 * The code renderer: what the file panel shows for source, and the one property that matters most.
 *
 * That property is **nothing is lost and nothing is invented**. Highlighting is cosmetic, but the text
 * is a file somebody else wrote, so the suite asserts it by stripping the tags back off the rendered
 * markup and comparing with the source — a renderer that swallowed a construct, or that let a byte of
 * the file become markup, fails here rather than in a reader's understanding.
 */

/**
 * Undo the escaping, so markup can be compared with the text it came from.
 *
 * Deliberately a **general** decoder rather than the five entities the renderer happened to write. The first version
 * of this helper listed exactly those five, and the renderer's own decoder listed the same five — so when the
 * highlighter wrote a single quote as the hexadecimal `&#x27;` and the renderer failed to decode it, the test
 * compared the same wrong decoding on both sides and passed while the panel showed `&#x27;node:fs&#x27;` to a
 * reader. A test that repeats the implementation's assumption cannot see the assumption.
 */
function unescapeHtml(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hexadecimal = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return named[body] ?? whole
  })
}

/** The source back out of the markup: drop the gutter, drop the tags, undo the escaping. */
function textOf(html: string): string {
  return unescapeHtml(html.replace(/<span class="ln">\d*<\/span>/g, '').replace(/<[^>]+>/g, ''))
}

test('the rendered markup gives the source back, exactly', () => {
  const samples = [
    'const answer = 42\n',
    'def f(x):\n    # a comment\n    return x + 1\n',
    'no trailing newline',
    '',
    '\n\n\n',
    'const s = "a < b && c > d"\nconst t = `back ${s}`\n',
    'x = """a docstring\nwith a newline"""\n',
    'if (a /* inline */ && b) {\n  // tail\n}\n',
    '#!/usr/bin/env bash\nset -euo pipefail\necho "hi"\n',
  ]
  for (const language of ['javascript', 'typescript', 'python', 'json', 'shell']) {
    for (const source of samples) {
      assert.equal(textOf(renderCode(source, language)), source, `${language}: ${JSON.stringify(source)}`)
    }
  }
})

test('PNG selects an image renderer without widening support to other image formats', () => {
  assert.deepEqual(rendererFor('/w/pixel.PNG'), { renderer: 'image' })
  assert.deepEqual(renderSource('/w/pixel.png', ''), { renderer: 'image' })
  for (const suffix of ['jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']) {
    assert.equal(rendererFor('/w/pixel.' + suffix).renderer, 'text')
  }
  assert.deepEqual(rendererFor('/w/icon.svg'), { renderer: 'code', language: 'xml' })
})

test('a file full of markup arrives as text and never as markup', () => {
  const hostile = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n</code></span>'
  const html = renderCode(hostile, 'javascript')
  assert.ok(!html.includes('<script'), 'no script tag survives')
  assert.ok(!html.includes('<img'), 'nor an image with a handler')
  assert.ok(!html.includes('onerror=') || html.includes('onerror=alert(2)') === false, 'nor an attribute')
  assert.ok(html.includes('&lt;script&gt;'), 'the text is visible, escaped')
  assert.equal(textOf(html), hostile, 'and it is still the file')
})

test("the classes are the highlighter's, and they say what was recognised", () => {
  /**
   * The classes are `highlight.js`'s own (`hljs-*`), because the classification is now the library's rather than
   * this project's. That is the point of the change: one highlighter for a fenced block inside a document and for a
   * whole source file, so the two cannot disagree about what a keyword is.
   */
  const html = renderCode('// a comment\nconst x = 12 // tail\n', 'javascript')
  assert.match(html, /<span class="hljs-comment">\/\/ a comment<\/span>/)
  assert.match(html, /<span class="hljs-keyword">const<\/span>/)
  assert.match(html, /<span class="hljs-number">12<\/span>/)
  assert.ok(!html.includes('>x</span>'), 'an identifier is not a keyword')

  const python = renderCode('def f():\n    return None  # done\n', 'python')
  assert.match(python, /<span class="hljs-keyword">def<\/span>/)
  assert.match(python, /<span class="hljs-comment"># done<\/span>/)
  assert.ok(!python.includes('hljs-comment"># done\n'), 'the comment stops at the line, not at the file')
})

test('the gutter numbers every line and starts at one', () => {
  const html = renderCode('a\nb\nc\n', 'javascript')
  const numbers = [...html.matchAll(/<span class="ln">(\d+)<\/span>/g)].map((match) => match[1])
  assert.deepEqual(numbers, ['1', '2', '3', '4'], 'three lines and the empty one a trailing newline makes')
})

test('a language is chosen by extension, and an unknown one is shown as text', () => {
  assert.equal(languageFor('/x/app.js'), 'javascript')
  assert.equal(languageFor('/x/app.mjs'), 'javascript')
  assert.equal(languageFor('/x/app.tsx'), 'typescript')
  assert.equal(languageFor('/x/tool.py'), 'python')
  assert.equal(languageFor('/x/UPPER.PY'), 'python', 'case is not the filename’s business')
  assert.equal(languageFor('/x/notes.txt'), undefined)

  /**
   * The shapes a repository is actually written in, all of which the highlighter has grammars for.
   *
   * Measured: `cordis.yml` rendered as plain text, so the one file that says how the harness is configured was a
   * wall of text while `package.json` beside it was coloured.
   */
  for (const [path, language] of [
    ['/x/cordis.yml', 'yaml'],
    ['/x/state.yaml', 'yaml'],
    ['/x/Cargo.toml', 'ini'],
    ['/x/style.css', 'css'],
    ['/x/data.xml', 'xml'],
    ['/x/fix.patch', 'diff'],
  ] as const) {
    assert.equal(languageFor(path), language, `${path} is recognised`)
  }

  assert.deepEqual(rendererFor('/x/README.md'), { renderer: 'markdown' })
  assert.deepEqual(rendererFor('/x/tool.py'), { renderer: 'code', language: 'python' })
  assert.deepEqual(rendererFor('/x/notes.txt'), { renderer: 'text' })
})

test('renderSource decides, and a document renders as a document', () => {
  const markdown = renderSource('/x/README.md', '# Title\n\n- one\n- two\n')
  assert.equal(markdown.renderer, 'markdown')
  assert.match(markdown.html ?? '', /<h1>Title<\/h1>/)
  assert.match(markdown.html ?? '', /<li>one<\/li>/)

  const code = renderSource('/x/tool.py', 'print("hi")\n')
  assert.equal(code.renderer, 'code')
  assert.equal(code.language, 'python')
  assert.match(code.html ?? '', /hljs-string/)

  const text = renderSource('/x/notes.txt', 'just text\n')
  assert.equal(text.renderer, 'text')
  assert.equal(text.html, undefined, 'plain text is shown verbatim, so no markup is produced for it')
})

test('a carriage return does not become a line', () => {
  const html = renderCode('a\r\nb\r\n', 'javascript')
  assert.equal(textOf(html), 'a\nb\n', 'CRLF is normalised, so the gutter and the file agree')
  assert.equal([...html.matchAll(/<span class="ln">/g)].length, 3)
})

test('a quote in the source is a quote on screen, not an entity code', () => {
  /**
   * Measured in the panel: an import line read `from &#x27;node:fs&#x27;`. The highlighter writes a single quote as
   * the **hexadecimal** `&#x27;` and the renderer's decoder only knew the decimal `&#39;`, so the entity reached the
   * reader — and the test above could not see it, because its own helper had the same five-entity list.
   */
  const html = renderCode("import { join } from 'node:path'\nconst s = \"a & b\"\n", 'typescript')
  /**
   * One escaping, in this renderer's own normal form: a single quote as the decimal `&#39;` and a double quote as
   * `&quot;`. What must not reach a reader is the **library's** spelling left in place, or the library's escaping
   * escaped again.
   */
  assert.ok(!html.includes('&#x27;'), 'no hexadecimal apostrophe reaches the output')
  assert.ok(!html.includes('&amp;quot;'), 'and no double quote is escaped twice')
  assert.equal((html.match(/&#39;/g) ?? []).length, 2, 'the file\'s single quotes, escaped once each')
  assert.equal((html.match(/&quot;/g) ?? []).length, 2, 'and its double quotes')
  assert.match(html, /<span class="hljs-string">&#39;node:path&#39;<\/span>/, 'the quote is escaped once, by this renderer')
  assert.equal(textOf(html), "import { join } from 'node:path'\nconst s = \"a & b\"\n", 'and the text is the file')
})

test('an ampersand and an angle bracket survive a round trip through the highlighter', () => {
  /** The three characters that make entities ambiguous, each of them in a string, a comment and plain text. */
  const source = 'const a = "x & y < z > w"\n// a & b < c\nlet d = 1 & 2\n'
  const html = renderCode(source, 'javascript')
  assert.equal(textOf(html), source, 'the file comes back exactly')
  assert.ok(!/&amp;(amp|lt|gt);/.test(html), 'and nothing is escaped twice')
})

test('an embedded image is served by the raw route, resolved beside its document', () => {
  /**
   * The owner's report: markdown rendered `<img src="heddle.svg">` and the browser asked for it at the server root,
   * which answered `404` — so a document with an image in it showed alt text and a broken marker. The reference now
   * resolves against the **document's** folder and lands on the route that serves a file's bytes.
   */
  const document = String(renderSource('/Users/zhenc/heddle/README.md', '![icon](heddle.svg)').html)
  assert.match(document, /<img src="\/api\/raw\?path=%2FUsers%2Fzhenc%2Fheddle%2Fheddle\.svg" alt="icon">/, 'beside the document')

  const nested = String(renderSource('/Users/zhenc/heddle/_context_/notes.md', '![icon](../heddle.svg)').html)
  assert.match(nested, /%2FUsers%2Fzhenc%2Fheddle%2Fheddle\.svg/, 'a parent reference resolves to the same file')
})

test('an image written as HTML resolves beside its document too, which is what centring one requires', () => {
  /**
   * The owner asked for the icon centred and not huge, and markdown has no alignment — so the README writes
   * `<p align="center"><img src="heddle.svg" width="160"></p>`, which goes **around** marked's image renderer.
   * Measured: the raw tag arrived unresolved, so the browser asked the server root for it, which is the same broken
   * image the renderer had already fixed for markdown images. The fence now tells its callback which tag and
   * attribute it is deciding, and the document's own resolution applies to both spellings of an image.
   */
  const centred = String(
    renderSource('/Users/zhenc/heddle/README.md', '<p align="center">\n  <img src="heddle.svg" alt="icon" width="160">\n</p>').html,
  )
  assert.match(centred, /align="center"/, 'the wrapper survives, since markdown cannot centre anything')
  assert.match(centred, /src="\/api\/raw\?path=%2FUsers%2Fzhenc%2Fheddle%2Fheddle\.svg"/, 'and the image resolves beside the document')
  /**
   * And the size the document asked for survives: the file is 560 units and the README shows it at 160, so a view
   * that dropped the attribute showed one size while GitHub showed another.
   */
  assert.match(centred, /width="160"/, 'the width the document asked for is kept')
  const nonsense = String(renderSource('/Users/zhenc/heddle/x.md', '<img src="heddle.svg" width="wide" height="1;color:red">').html)
  assert.ok(!/width="wide"/.test(nonsense), 'a width that is not a number is dropped')
  assert.ok(!/height="1;color:red"/.test(nonsense), 'and neither does a value reach the page as styling')

  /** And a reference that is already resolved is left alone: resolving twice wraps the route in itself. */
  const twice = String(renderSource('/Users/zhenc/heddle/README.md', '![icon](heddle.svg)').html)
  assert.ok(!twice.includes('%2Fapi%2Fraw'), 'an already-resolved reference is not resolved again')
})

test('an image cannot make the server fetch somewhere else, or carry a payload', () => {
  /**
   * The rules matter more than the feature: a document is untrusted text, and an image reference is a URL it can
   * choose. A remote URL is left as the author wrote it, because re-hosting it is not this server's job; a scheme
   * that would run code is refused; and a `data:` image is refused because a document that can embed an arbitrary
   * payload in the page is a document that can smuggle one there.
   */
  const remote = String(renderSource('/x/a.md', '![r](https://example.com/a.png)').html)
  assert.match(remote, /src="https:\/\/example\.com\/a\.png"/, 'a remote image is left alone')

  for (const [source, why] of [
    ['![x](javascript:alert(1))', 'a script scheme'],
    ['![x](data:image/png;base64,AAAA)', 'an embedded payload'],
    ['![x](vbscript:msgbox(1))', 'another script scheme'],
  ] as const) {
    const html = String(renderSource('/x/a.md', source).html)
    assert.ok(!html.includes('<img'), `${why} produces no image element`)
    assert.match(html, /x/, 'and the alt text is kept so the document still reads')
  }
})

test('one document\'s relative image does not resolve against another\'s folder', () => {
  /**
   * The base is set for the duration of one parse. If it leaked, a document parsed after another would resolve its
   * images against the wrong folder — a bug that would only appear when two documents are rendered in sequence,
   * which is exactly what the panel does.
   */
  const first = String(renderSource('/one/notes.md', '![a](x.png)').html)
  const second = String(renderSource('/two/notes.md', '![a](x.png)').html)
  assert.match(first, /%2Fone%2Fx\.png/, 'the first resolves in its own folder')
  assert.match(second, /%2Ftwo%2Fx\.png/, 'and the second in its own')
  assert.ok(!second.includes('%2Fone%2F'), 'with nothing carried over')
})

test('a link to a file in the workspace is one the panel can follow', () => {
  /**
   * The owner's report: navigation in the preview hit broken links. Measured: `[x](DEPLOY.md)` asked the browser for
   * `/DEPLOY.md`, which answered `404`, so following a link lost the document being read. A link to a workspace file
   * therefore keeps a real address for the status bar and a middle-click, and carries the absolute path so a plain
   * click opens it in this panel.
   */
  const html = String(renderSource('/Users/zhenc/heddle/_context_/notes.md', '[the goal](ULTIMATE_GOAL.md)').html)
  assert.match(html, /href="\/api\/raw\?path=%2FUsers%2Fzhenc%2Fheddle%2F_context_%2FULTIMATE_GOAL\.md"/, 'with a real address')
  assert.match(html, /data-heddle-path="\/Users\/zhenc\/heddle\/_context_\/ULTIMATE_GOAL\.md"/, 'and the path to open')

  /** A fragment is kept, so a link into a section can still land on it. */
  const fragment = String(renderSource('/Users/zhenc/heddle/a.md', '[part](README.md#layout)').html)
  assert.match(fragment, /href="[^"]*README\.md#layout"/, 'the fragment survives in the address')
  assert.match(fragment, /data-heddle-path="\/Users\/zhenc\/heddle\/README\.md"/, 'and the path is the file, without it')
})

test('a link this server cannot resolve is left alone, and a refused one is text', () => {
  const remote = String(renderSource('/x/a.md', '[site](https://example.com/a)').html)
  assert.match(remote, /href="https:\/\/example\.com\/a"/, 'a remote link keeps its address')
  assert.ok(!remote.includes('data-heddle-path'), 'and is not marked for the panel to open')
  assert.match(remote, /target="_blank"/, 'so it opens in a new tab rather than replacing the page')

  const refused = String(renderSource('/x/a.md', '[bad](javascript:alert(1))').html)
  assert.ok(!refused.includes('<a '), 'a refused scheme produces no anchor')
  assert.match(refused, /bad \(link refused\)/, 'with its label kept')

  /**
   * A hand-written anchor goes through the same resolver, and arrives in a different shape.
   *
   * `marked` passes an HTML block straight through, so a raw `<a>` never reaches the renderer — the sanitizer's URL
   * callback resolves it, and a callback answers for one attribute's **value**, so it cannot add the path attribute
   * a markdown link carries. The page therefore also follows the address, which is the only thing a raw link has.
   */
  const raw = String(renderSource('/x/a.md', '<a href="README.md">raw</a>').html)
  assert.match(raw, /href="\/api\/raw\?path=%2Fx%2FREADME\.md"/, 'a raw HTML link is resolved to the served address')
})

test('a JSON block can be rendered without the line-number gutter', () => {
  const html = renderCode('{"a": 1}', 'json', { gutter: false })
  assert.ok(!html.includes('class="ln"'), 'no gutter spans')
  assert.match(html, /hljs-/, 'but the JSON is still highlighted')
  assert.equal(textOf(html), '{"a": 1}')
})
