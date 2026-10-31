import { dirname, extname } from 'node:path'

import { highlightCode } from './highlight.ts'
import { escapeHtml, renderMarkdown, renderMarkdownOffThread } from './markdown.ts'

/**
 * The code renderer: a source file shown as source rather than as a wall of text.
 *
 * The whole design is one rule — **this file writes every tag, and every byte of the file is
 * escaped** — because the text being rendered is a file somebody else wrote. A file containing
 * `<script>alert(1)</script>` must arrive in the panel as six visible tokens, not as a script; that is
 * the same stance [`markdown.ts`](markdown.ts) takes, and it is why nothing here interpolates raw
 * input into markup.
 *
 * The scanner is deliberately small and **total**: it walks the text once, recognises comments,
 * strings, numbers and keywords, and emits everything else as escaped text. It never re-orders,
 * drops or invents a character, which is a property the unit suite asserts by stripping the tags back
 * off and comparing with the source. A renderer that quietly swallowed a construct would be worse than
 * no highlighting, because the reader would believe what they saw.
 *
 * Highlighting is **`highlight.js`**, the library the markdown fences already use, adopted on the owner's
 * instruction of 2026-10-11 to render each file type with a library rather than with code written here. What
 * remains here is the part a library does not do for this panel: the **line gutter**, which is presentation and
 * must stay out of a copy, and the exact-text guarantee above, which the library is not responsible for.
 *
 * The two are combined by reading the library's own spans back as pieces — the text of each piece is the source
 * text, and its class is the library's — so the panel gets the library's classification without giving up either
 * property. Dividing a file into lines before highlighting was the alternative, and it is wrong in a way a reader
 * sees immediately: a block comment or a template literal that spans a newline would be classified as two
 * separate constructs, and the second half would be coloured as if the first had never opened.
 */

/** What the file panel should do with a file. */
export type RendererName = 'markdown' | 'html' | 'code' | 'text'

/** A decision about one file, and the markup when there is any. */
export interface Rendered {
  readonly renderer: RendererName
  readonly language?: string
  /** Present for `markdown` and `code`; absent for `text`, which the panel shows verbatim. */
  readonly html?: string
}

/** The languages this renderer knows, by extension. */
const LANGUAGES: Readonly<Record<string, string>> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.json': 'json',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  /**
   * YAML and the rest of the shapes a repository is written in, which the highlighter has grammars for.
   *
   * Measured: `cordis.yml` rendered as plain text, because the map had no entry for it — so the one file that says
   * how the harness is configured appeared as a wall of text while `package.json` beside it was coloured.
   */
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.mdx': 'markdown',
  '.sql': 'sql',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.css': 'css',
  /**
   * **Removed** from this map on 2026-10-12: an HTML document was being shown as syntax-highlighted XML, which is a
   * file's source rather than the page it is. It is a renderer of its own now — `rendererFor` answers `html` and the
   * client shows it in a sandboxed frame — and the `xml` grammar is left to XML, which is not a page.
   */
  '.svg': 'xml',
  '.xml': 'xml',
  '.diff': 'diff',
  '.patch': 'diff',
}

/** The language a path's extension names, or `undefined` when this renderer does not know it. */
export function languageFor(path: string): string | undefined {
  return LANGUAGES[extname(path).toLowerCase()]
}

/** What should be done with a file, before its text is read. */
export function rendererFor(path: string): { readonly renderer: RendererName; readonly language?: string } {
  const extension = extname(path).toLowerCase()
  if (extension === '.md' || extension === '.markdown') return { renderer: 'markdown' }
  /**
   * A page is previewed **as a page**, not as its source.
   *
   * A `.html` file has no shared source of truth with this file's escaping: it is a document with its own markup,
   * styles and resources, and showing it as highlighted text is answering a different question from "what does this
   * page look like". The rendering happens in the client, where a DOM and a sanitiser exist, and the server's part is
   * the route that rewrites the document's relative resources.
   */
  if (extension === '.html' || extension === '.htm') return { renderer: 'html' }
  const language = LANGUAGES[extension]
  return language === undefined ? { renderer: 'text' } : { renderer: 'code', language }
}

/** One piece of the source: its exact text, and the class the highlighter gave it. */
interface Piece {
  readonly text: string
  /** `null` for text the highlighter did not classify, which is most of a file. */
  readonly className: string | null
  readonly newline: boolean
}

/**
 * Read the highlighter's markup back as pieces.
 *
 * A **depth-aware scan**, not a regular expression, and the test is what made that necessary: the library nests
 * its spans — a template literal is a string containing a substitution — and a non-greedy match for a span stops
 * at the inner close, so the outer tag's text was re-read as if it were source. The panel then showed the markup
 * it had just been handed, which is the exact failure the exact-text guarantee exists to catch.
 *
 * Text between spans is plain, and the innermost class wins for the text inside it, which is the class the library
 * attached to the smallest piece containing it.
 */
function piecesFrom(html: string): Piece[] {
  const pieces: Piece[] = []
  const push = (text: string, className: string | null): void => {
    if (text.length === 0) return
    /** Split at newlines: the gutter numbers lines, and nothing else needs to know where they are. */
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) pieces.push({ text: '\n', className: null, newline: true })
      pieces.push({ text: parts[index] ?? '', className, newline: false })
    }
  }
  const open = /<span class="([^"]*)">/y
  const currentClass = (): string | null => (classes.length > 0 ? (classes[classes.length - 1] ?? null) : null)
  let cursor = 0
  /** Where the text of the piece being read begins, and the class that text belongs to. */
  let plainStart = 0
  let plainClass: string | null = null
  const classes: string[] = []
  while (cursor < html.length) {
    /** The text before a closing tag belongs to the span that is closing, and has to be taken before it pops. */
    if (html.startsWith('</span>', cursor)) {
      push(unescapeEntities(html.slice(plainStart, cursor)), plainClass)
      classes.pop()
      cursor += '</span>'.length
      plainStart = cursor
      plainClass = currentClass()
      continue
    }
    open.lastIndex = cursor
    const match = open.exec(html)
    if (match !== null) {
      push(unescapeEntities(html.slice(plainStart, cursor)), plainClass)
      cursor += match[0].length
      classes.push(match[1] ?? '')
      plainStart = cursor
      plainClass = currentClass()
      continue
    }
    cursor += 1
  }
  push(unescapeEntities(html.slice(plainStart)), plainClass)
  return pieces
}

/** The named entities a highlighter emits. Numeric ones are handled by their code point. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
}

/**
 * Undo the highlighter's escaping, so a piece holds the file's own characters.
 *
 * The first version listed five entities, and the suite did not catch the gap because its own helper listed the same
 * five: measured, the library writes a single quote as `&#x27;` — **hexadecimal**, not the decimal `&#39;` this
 * looked for — so a string literal rendered as `&#x27;node:fs&#x27;` on screen and the test agreed it was fine. A
 * decoder that enumerates spellings is a decoder that is wrong about the next one, so this handles any numeric
 * reference and the small set of names, rather than a list.
 */
function unescapeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hexadecimal = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

/**
 * Render source as line-numbered, escaped, lightly highlighted markup.
 *
 * Every line is one `<span class="line">`, whose first child is the number in a non-selectable gutter:
 * the number is presentation, so selecting the panel and copying it gets the source and not the
 * numbers.
 */
export function renderCode(source: string, language: string, options: { readonly gutter?: boolean } = {}): string {
  const pieces = piecesFrom(highlightCode(source.replace(/\r\n?/g, '\n'), language))
  const out: string[] = ['<code class="code">']
  let line = 1
  let open = false
  const gutter = options.gutter !== false
  const startLine = (): void => {
    out.push(gutter ? `<span class="line"><span class="ln">${line}</span>` : '<span class="line">')
    open = true
  }
  startLine()
  for (const piece of pieces) {
    if (piece.newline) {
      out.push('\n')
      if (open) out.push('</span>')
      line += 1
      startLine()
      continue
    }
    out.push(piece.className === null ? escapeHtml(piece.text) : `<span class="${piece.className}">${escapeHtml(piece.text)}</span>`)
  }
  if (open) out.push('</span>')
  out.push('</code>')
  return out.join('')
}

/** Decide how to show one file's text, and produce the markup when there is any. */
export function renderSource(path: string, text: string): Rendered {
  const decision = rendererFor(path)
  /**
   * The document's own folder is the base for its relative images, so `![icon](heddle.svg)` in
   * `_context_/notes.md` looks beside that file rather than at the server root. Measured before this: the browser
   * resolved the reference against the page URL, the request answered `404`, and a document with an image showed a
   * broken marker.
   */
  if (decision.renderer === 'markdown') {
    return { renderer: 'markdown', html: `<div class="markdown">${renderMarkdown(text, { base: dirname(path), remoteImages: true })}</div>` }
  }
  if (decision.renderer === 'code' && decision.language !== undefined) {
    return { renderer: 'code', language: decision.language, html: renderCode(text, decision.language) }
  }
  /**
   * A page has no markup **here**, and that is deliberate rather than a gap: this function's answer is JSON about a
   * file, while the document itself comes from the HTML route with its resources rewritten, and the client puts it in
   * a sandboxed frame. The name is what tells the client which of the two to ask for.
   *
   * Measured: without this branch the decision fell through to `text`, so an HTML file was previewed by reading it out
   * as plain text — a page shown as its own source, which is the behaviour this was meant to replace.
   */
  if (decision.renderer === 'html') {
    return { renderer: 'html' }
  }
  return { renderer: 'text' }
}

/**
 * {@link renderSource} for a request handler: a markdown document is rendered off the event loop.
 *
 * A previewed document is somebody's file, and a long one renders as slowly as a long answer does (issue #19), so the
 * route that serves a preview must not do it on the thread every other request waits on. Every other renderer here is
 * linear and stays where it is.
 */
export async function renderSourceOffThread(path: string, text: string): Promise<Rendered> {
  if (rendererFor(path).renderer !== 'markdown') return renderSource(path, text)
  return { renderer: 'markdown', html: `<div class="markdown">${await renderMarkdownOffThread(text, { base: dirname(path), remoteImages: true })}</div>` }
}
