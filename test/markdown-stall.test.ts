import assert from 'node:assert/strict'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { Marked } from 'marked'

import * as markdown from '../src/server/markdown.ts'

/**
 * Rendering a long answer must not stop the server (issue #19).
 *
 * The TS server renders a document's markdown on its own event loop — every assistant answer of a session a page
 * opens, and the settled answer every following page asks for — and `marked` has two super-linear paths: its
 * `walkTokens` copies the whole result array once per token (`values = values.concat(...)`), which a long list or
 * table makes quadratic, and its emphasis delimiter scan, which text with many `*` or `_` runs makes quadratic too.
 * Measured on the unfixed build: one 30,000-item list took 5.4 s to render, and 30,000 `*n` words took 80 s, during
 * which `/healthz` answered nothing and every stream on the server stood still. Main's parse budget (1fa46b16) has since
 * kept any document past 64 KiB or 512 inline markers from the parser, so the fixtures here sit inside it: a session
 * holds many answers of that size, and measured on main with the budget, opening one with eight of them stood the
 * event loop still for 2.7 s.
 */

const list = (items: number): string => Array.from({ length: items }, (_, index) => `- ${index + 1}`).join('\n')

/**
 * The longest list that still reaches the parser. Main's parse budget (`withinParseBudget`: 64 KiB and 512 inline
 * markers, 1fa46b16) answers a longer document as its escaped text without parsing it, so a 30,000-item list no longer
 * exercises `marked` at all. 9,000 items are 61,892 bytes, inside the budget, and still slow on the unfixed renderer.
 */
const LONG = 9_000

test('a long list renders without walking every token, which is the quadratic part of marked', () => {
  /**
   * `marked` walks the token tree only when an extension registers `walkTokens`, and its walk copies the whole result
   * once per token. The walk is counted directly rather than timed, so a busy machine cannot decide the verdict: it
   * must not run at all. (Timed on the unfixed build: 32,000 items took 4.2 to 6.2 s, 26 to 111 times 4,000 items.)
   */
  const prototype = Marked.prototype as unknown as { walkTokens: (...args: unknown[]) => unknown }
  const original = prototype.walkTokens
  let walks = 0
  prototype.walkTokens = function counted(this: unknown, ...args: unknown[]) {
    walks += 1
    return original.apply(this, args)
  }
  try {
    assert.ok(markdown.withinParseBudget(list(LONG)), 'the list is inside the parse budget, so marked parses it')
    const started = performance.now()
    const html = markdown.renderMarkdown(list(LONG))
    const elapsed = performance.now() - started
    assert.equal(walks, 0, `rendering a ${LONG}-item list walked the token tree ${walks} times (${elapsed.toFixed(0)} ms)`)
    assert.match(html, new RegExp(`<li>${LONG}</li>`), 'and the list is still a list')
  } finally {
    prototype.walkTokens = original
  }
})

test('a fenced block is still coloured, with its language, after the walk is gone', () => {
  const html = markdown.renderMarkdown('```ts\nconst answer: number = 42\n```')
  assert.match(html, /<pre><code class="language-ts">/, 'the fence keeps its language')
  assert.match(html, /hljs-keyword/, 'and the highlighter coloured it')
  assert.match(markdown.renderMarkdown('```\n<b> & </b>\n```'), /<pre><code>&lt;b&gt; &amp; &lt;\/b&gt;\n<\/code><\/pre>/, 'a fence without a language is escaped text')
})

/**
 * The renderer the server's routes use. Read from the module rather than imported by name, so the same test
 * measured the unfixed build, where the routes called the synchronous renderer on the event loop.
 */
const serverRender = (text: string): Promise<string> => {
  const offThread = (markdown as { renderMarkdownOffThread?: (source: string) => Promise<string> }).renderMarkdownOffThread
  return offThread !== undefined ? offThread(text) : Promise.resolve(markdown.renderMarkdown(text))
}

test('the server renders a session\'s answers without blocking its event loop', async () => {
  /**
   * Over the parse budget (6,000 emphasis delimiters, measured 2.7 s at 5,000 before the budget), a document comes back
   * as its text at once. Inside it, each long answer still costs real time, and opening a session renders every
   * answer: four distinct 9,000-item lists, rendered one after another as the session route does. On the unfixed
   * build they run back to back on the event loop, whose timers get no turn between them.
   */
  const heavy = Array.from({ length: 6_000 }, (_, index) => `*${index}`).join(' ')
  const answers = Array.from({ length: 4 }, (_, answer) => `# answer ${answer + 1}\n\n${list(LONG)}`)
  assert.ok(answers.every((answer) => markdown.withinParseBudget(answer)), 'every answer is inside the parse budget')
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  /** Its first tick only sets the baseline, so it must run once before the work starts or a stall is not seen. */
  await new Promise((resolve) => setTimeout(resolve, 50))
  const started = performance.now()
  const html = await serverRender(heavy)
  const rendered: string[] = []
  for (const answer of answers) rendered.push(await serverRender(answer))
  const listHtml = rendered.at(-1) ?? ''
  const elapsed = performance.now() - started
  /** The histogram's timer records a stall only when it next runs, so the loop is given a turn before reading it. */
  await new Promise((resolve) => setTimeout(resolve, 50))
  delay.disable()
  const worst = delay.max / 1e6
  assert.ok(worst < 500, `the event loop stood still for ${worst.toFixed(0)} ms while five documents rendered (in ${elapsed.toFixed(0)} ms)`)
  assert.ok(html.includes('*5999') || html.includes('5999'), 'the heavy document still comes back with its text')
  assert.match(listHtml, new RegExp(`<li>${LONG}</li>`), 'and every answer is rendered as a list')
  assert.match(listHtml, /<h1>answer 4<\/h1>/, 'each its own')
})

test('a document the renderer cannot finish in its budget comes back as its own text', async () => {
  const Worker = (markdown as { MarkdownWorker?: new (options: { budgetMs: number }) => { render(source: string): Promise<string>; close(): Promise<void> } }).MarkdownWorker
  assert.ok(Worker !== undefined, 'the module exports its off-thread renderer')
  /**
   * A document inside the parse budget that still takes the renderer far longer than this budget: every line opens 99
   * nested list items, one short of the nesting bound (measured, about 140 ms against 40 ms for a 9,000-item list).
   * The budget is cut to 30 ms so the test does not wait the server's 3 s; a short document still renders well inside it.
   */
  const renderer = new Worker({ budgetMs: 30 })
  try {
    const lines: string[] = []
    while (lines.join('\n').length < 60_000) lines.push(`${'- '.repeat(99)}x${lines.length} <b>&`)
    const source = lines.join('\n')
    const last = lines.length - 1
    assert.ok(markdown.withinParseBudget(source), 'the document is inside the parse budget, so only the time budget can stop it')
    const started = performance.now()
    const html = await renderer.render(source)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 5_000, `the budget ended the render (${elapsed.toFixed(0)} ms)`)
    assert.ok(html.startsWith('<pre class="unrendered"><code>') && html.endsWith('</code></pre>'), `the fallback is the text as a block, the one a document past the parse budget gets\nsaw: ${html.slice(0, 80)}`)
    assert.ok(html.includes(`x${last} &lt;b&gt;&amp;`), 'escaped, and nothing of it lost')
    assert.ok(!html.includes('<b>'), 'no tag of the document survives')
    /** The renderer is usable again after a document that exhausted it. */
    assert.equal(await renderer.render('**bold**'), '<p><strong>bold</strong></p>\n')
  } finally {
    await renderer.close()
  }
})

test('off the thread, a document renders exactly as on it: an answer, and a preview with its remote images', async () => {
  /** Every option `renderMarkdown` takes travels to the worker, so a preview keeps its remote images and an answer does not. */
  const { renderSource, renderSourceOffThread } = await import('../src/server/code.ts')
  const text = '# notes\n\n![remote](https://example.com/a.png) ![local](pic.png) [link](README.md)\n\n- one\n- `two`\n'
  assert.equal(await markdown.renderMarkdownOffThread(text), markdown.renderMarkdown(text), 'an answer')
  const preview = await renderSourceOffThread('/tmp/docs/README.md', text)
  assert.deepEqual(preview, renderSource('/tmp/docs/README.md', text), 'a previewed document')
  assert.match(String(preview.html), /https:\/\/example\.com\/a\.png/, 'whose remote image is kept as written')
})
