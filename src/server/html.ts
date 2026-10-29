/**
 * Previewing an HTML document: a page shown as a page, safely.
 *
 * This is the one renderer that has to **execute nothing**. Every other type becomes markup this project wrote;
 * an HTML file is a program, and a preview that runs it is a preview that runs whatever is in the workspace with
 * the session cookie attached. So the design has three parts, and each is load-bearing:
 *
 * 1. **The document is sanitised in the browser, by DOMPurify.** Measured before choosing: `dompurify` has **zero
 *    dependencies** and runs where the DOM already is, while `isomorphic-dompurify` and `sanitize-html` pull in
 *    jsdom or four packages to parse HTML that the browser has already parsed. It is the sanitiser the industry
 *    uses, and the allow-list below is narrower than its default rather than wider: this is a reading pane, not a
 *    page builder, so `<script>`, `<iframe>`, forms and event attributes are not wanted at all.
 * 2. **The result is shown in a sandboxed `iframe`.** Sanitising is a filter, and a filter is a list of what its
 *    author thought of; an iframe with `allow-same-origin` and **no** `allow-scripts` is a boundary the browser
 *    enforces. A document's own CSS also cannot reach the harness UI from in there, which is what makes a page look
 *    like a page instead of repainting the app around it.
 * 3. **The server rewrites the document's relative resources**, because a document written beside its images says
 *    `<img src="icon.png">` and the browser would look for that at the **server root**. The base element would do
 *    the same job for anything the browser fetches itself, and it is set as well; the rewrite is what makes an
 *    attribute visible to the sanitiser, which compares every URL against where it points.
 */

/** The part of a document a preview is allowed to contain. Anything outside it is dropped. */
export const ALLOWED_TAGS: readonly string[] = [
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd',
  'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'nav',
  'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'section', 'small', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
  /** Presentation a reading pane needs: the document's own stylesheet, and a rule inside it. */
  'link', 'style',
]

/** The attributes those elements may carry. `srcset`, `sizes`, `media` and `alt` are how an image is described. */
export const ALLOWED_ATTRS: readonly string[] = [
  'abbr', 'align', 'alt', 'class', 'colspan', 'dir', 'height', 'href', 'hreflang', 'id', 'lang', 'media', 'name',
  'rel', 'role', 'sizes', 'span', 'src', 'srcset', 'start', 'style', 'summary', 'title', 'type', 'valign', 'width',
]

/**
 * The resources a document may pull in, as a pattern DOMPurify tests each URL against.
 *
 * A local document's resources are served by this server's own route, or are already absolute on some other host;
 * a `javascript:` or `data:` URL is not a resource a reading pane loads. The pattern is deliberately about the
 * **shape of an address** rather than about a scheme being absent, so a `data:` image cannot slip through it.
 */
export const ALLOWED_URI = /^(?:https?:|\/|\.{1,2}\/|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

/**
 * The policy a previewed document runs under, as a `meta` element inside it.
 *
 * The sanitiser should have removed every script; this says so in a language the **browser** enforces, so a bug in
 * the sanitiser is not the only thing standing between a document and the session. `default-src 'none'` with
 * explicit exceptions is the tightest form available: no script at all, no framing, no forms, and resources only
 * from this server or a remote host the document names.
 */
export const PREVIEW_CSP =
  "default-src 'none'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; media-src 'self' https:; frame-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * Rewrite a document's relative resources to the route that serves them.
 *
 * `<img src="icon.png">` means *beside this document*, and a browser resolves it against wherever the document is
 * being shown — inside the preview iframe that is not this document's folder. `src`, `href` and `srcset` are the
 * attributes a browser fetches, so those are the ones rewritten, and anything already absolute or remote is left
 * alone. The rewrite happens **before** the sanitiser sees the tag, so what the sanitiser compares is the address
 * the browser will actually use.
 */
/**
 * Whether a path is a document the page previews as a page: an `.html` or `.htm` file, by extension.
 *
 * DSH registers its HTML renderer for exactly these two extensions (`dsh-client-ui-sidebar-documentpreview`,
 * `extensions: ["html", "htm"]`); a `.docx` goes to its Office renderer and anything else to its own renderer or plain
 * text, so no other file is ever framed as a page. `GET /api/html` refuses the rest, rather than decoding a binary file
 * as text and handing it to the frame.
 */
export function isHtmlDocument(path: string): boolean {
  const leaf = path.split(/[\\/]/).pop() ?? ''
  const dot = leaf.lastIndexOf('.')
  if (dot <= 0) return false
  const extension = leaf.slice(dot + 1).toLowerCase()
  return extension === 'html' || extension === 'htm'
}

/** The sentence `GET /api/html` answers, with `415`, for a file that is not an HTML document. */
export const NOT_AN_HTML_DOCUMENT = 'not an HTML document; only .html and .htm files are previewed as a page'

export function rewriteResources(html: string, base: string, serve: (path: string) => string): string {
  const rewriteUrl = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return value
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return value
    if (trimmed.startsWith('//') || trimmed.startsWith('/') || trimmed.startsWith('#')) return value
    const [path, fragment] = splitAtFragment(trimmed)
    return `${serve(joinPath(base, path))}${fragment}`
  }
  return html
    .replace(/(\s(?:src|href)\s*=\s*)(["'])(.*?)\2/gi, (_whole, lead: string, quote: string, value: string) => `${lead}${quote}${rewriteUrl(value)}${quote}`)
    .replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (_whole, lead: string, quote: string, value: string) => {
      const rewritten = value
        .split(',')
        .map((candidate: string) => {
          const parts = candidate.trim().split(/\s+/)
          const url = parts.shift() ?? ''
          return [rewriteUrl(url), ...parts].join(' ')
        })
        .join(', ')
      return `${lead}${quote}${rewritten}${quote}`
    })
}

/** A path split at its `#`, so a fragment is not treated as part of the filename. */
function splitAtFragment(url: string): [string, string] {
  const at = url.indexOf('#')
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at)]
}

/** A path joined to the folder of the document that referred to it, without a filesystem. */
function joinPath(base: string, relative: string): string {
  const parts = `${base}/${relative}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' && out.length === 0) {
      out.push('')
      continue
    }
    if (part === '.') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}
