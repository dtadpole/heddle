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
 * which `/healthz` answered nothing and every stream on the server stood still.
 */

const list = (items: number): string => Array.from({ length: items }, (_, index) => `- ${index + 1}`).join('\n')

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
    const started = performance.now()
    const html = markdown.renderMarkdown(list(30_000))
    const elapsed = performance.now() - started
    assert.equal(walks, 0, `rendering a 30,000-item list walked the token tree ${walks} times (${elapsed.toFixed(0)} ms)`)
    assert.match(html, /<li>30000<\/li>/, 'and the list is still a list')
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

test('the server renders a document without blocking its event loop', async () => {
  /** A document marked needs seconds for: many emphasis delimiters in one paragraph (measured: 2.7 s at 5,000). */
  const heavy = Array.from({ length: 6_000 }, (_, index) => `*${index}`).join(' ')
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  /** Its first tick only sets the baseline, so it must run once before the work starts or a stall is not seen. */
  await new Promise((resolve) => setTimeout(resolve, 50))
  const started = performance.now()
  const html = await serverRender(heavy)
  const listHtml = await serverRender(list(30_000))
  const elapsed = performance.now() - started
  /** The histogram's timer records a stall only when it next runs, so the loop is given a turn before reading it. */
  await new Promise((resolve) => setTimeout(resolve, 50))
  delay.disable()
  const worst = delay.max / 1e6
  assert.ok(worst < 500, `the event loop stood still for ${worst.toFixed(0)} ms while two documents rendered (in ${elapsed.toFixed(0)} ms)`)
  assert.ok(html.includes('*5999') || html.includes('5999'), 'the heavy document still comes back with its text')
  assert.match(listHtml, /<li>30000<\/li>/, 'and the list is rendered as a list')
})

test('a document the renderer cannot finish in its budget comes back as its own text', async () => {
  const Worker = (markdown as { MarkdownWorker?: new (options: { budgetMs: number }) => { render(source: string): Promise<string>; close(): Promise<void> } }).MarkdownWorker
  assert.ok(Worker !== undefined, 'the module exports its off-thread renderer')
  const renderer = new Worker({ budgetMs: 300 })
  try {
    const source = Array.from({ length: 20_000 }, (_, index) => `*${index} <b>&`).join(' ')
    const started = performance.now()
    const html = await renderer.render(source)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 5_000, `the budget ended the render (${elapsed.toFixed(0)} ms)`)
    assert.ok(html.startsWith('<pre><code>') && html.endsWith('</code></pre>'), 'the fallback is the text as a block')
    assert.ok(html.includes('*19999 &lt;b&gt;&amp;'), 'escaped, and nothing of it lost')
    assert.ok(!html.includes('<b>'), 'no tag of the document survives')
    /** The renderer is usable again after a document that exhausted it. */
    assert.equal(await renderer.render('**bold**'), '<p><strong>bold</strong></p>\n')
  } finally {
    await renderer.close()
  }
})
