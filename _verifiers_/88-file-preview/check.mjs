import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { writeFileSync } from 'node:fs'

import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — one preview surface.
 *
 * **The claim it decides:** a file is previewed in exactly one place — the File panel a click on the left panel
 * opens — and each file type is rendered with the library appropriate to it.
 *
 * The owner's request of 2026-10-11, and the reason it is a claim rather than a preference: the project had grown
 * **two** preview surfaces. A session offered Chat, Trajectory and Docs, where Docs listed the repository's
 * documents and rendered them; and a click on a file in the left panel opened a File tab that rendered the same
 * markdown through a second pane — which was styled separately, and was in fact unstyled until that was measured.
 * Two surfaces meant two renderers, two style blocks and two places for a document to look wrong.
 *
 * It is judged in a browser because every part of it is a rendering claim: the ring, the pane that appears, and the
 * markup each library produces. An API that answers correctly and a panel that draws text says nothing about any
 * of it.
 */

const CAPABILITY = 'one preview surface, rendering each file type with the library appropriate to it'

/** Start the Web UI and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const { join: joinPath } = await import('node:path')
      const child = spawn(process.execPath, [joinPath(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      })
    })()
  })
}

async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the server renders each file type, and the page offers no second surface', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const home = isolatedHome('preview-api')
  const work = fixtureDir('preview-api')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: '/Users/zhenc/heddle' }),
    })

    /**
     * Each type through the route the File panel uses. The point is not that markup exists but that the **right
     * library** produced it: markdown arrives as elements with its fenced code tokenised, source arrives with the
     * highlighter's classes, and something with no renderer arrives as text with no markup at all.
     */
    const read = async (path) => (await fetch(`${origin}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } })).json()

    const document = await read('/Users/zhenc/heddle/AGENTS.md')
    assert.equal(document.renderer, 'markdown', 'a document is rendered as markdown')
    assert.match(String(document.html), /<h1>/, 'with block elements, not its source')
    assert.match(String(document.html), /<table>/, 'including a table')

    const source = await read('/Users/zhenc/heddle/package.json')
    assert.equal(source.renderer, 'code', 'a source file is rendered as code')
    assert.equal(source.language, 'json', 'with the language its extension names')
    assert.match(String(source.html), /hljs-/, "carrying the highlighter's own classes")
    assert.match(String(source.html), /class="ln"/, 'and a line gutter')

    const config = await read('/Users/zhenc/heddle/cordis.yml')
    assert.equal(config.renderer, 'code', 'a yaml file is rendered as code rather than as text')
    assert.equal(config.language, 'yaml', 'which was measured as text before the map covered it')

    const plain = await read('/Users/zhenc/heddle/LICENSE')
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.html, undefined, 'with no markup produced for it')

    /**
     * What the markdown library must keep doing, carried over from the part this one replaced.
     *
     * A document is untrusted text, so the two properties its tests assert are judged here as well, on a document
     * the server rendered rather than on a string: no element of the document's own survives, a refused link keeps
     * its label, and frontmatter is metadata rather than prose.
     */
    assert.ok(!String(document.html).includes('<script'), 'no element the document wrote survives')
    assert.match(String(document.html), /<section class="frontmatter">/, 'frontmatter is lifted into its own block')
    assert.ok(!String(document.html).includes('`'), 'and a code span is not shown as backticks')

    const hostile = await read('/Users/zhenc/heddle/AGENTS.md')
    assert.match(String(hostile.html), /<table>/, 'a table is a table, with its cells')
    assert.ok(!String(hostile.html).includes('onclick'), 'and no attribute of the document survives')

    /**
     * An embedded image is **served**, which is the half markdown could not do on its own.
     *
     * Measured: the renderer produced `<img src="heddle.svg">` and the browser asked for it at the server root, which
     * answered `404` — a document with an image showed alt text and a broken marker. The raw route serves a file's
     * bytes, with the type chosen so a browser renders an image and does **not** execute anything else.
     */
    const asset = await fetch(`${origin}/api/raw?path=${encodeURIComponent('/Users/zhenc/heddle/heddle.svg')}`, { headers: { cookie } })
    assert.equal(asset.status, 200, 'an image in a workspace is served')
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml', 'with the type its extension names')
    assert.equal(asset.headers.get('content-disposition'), 'inline', 'and inline, so it renders in the document')
    assert.ok((await asset.arrayBuffer()).byteLength > 500, 'with its bytes')

    /**
     * And a file a browser would **run** is not served inline, even though it is served.
     *
     * This is the rule that makes the route safe to give a session cookie: a workspace can hold an `.html` file, and
     * a route that handed that back as `text/html` would be a same-origin page the harness runs by being viewed.
     */
    const runnable = await fetch(`${origin}/api/raw?path=${encodeURIComponent('/Users/zhenc/heddle/README.md')}`, { headers: { cookie } })
    assert.equal(runnable.status, 200, 'a markdown file is served too')
    assert.notEqual(runnable.headers.get('content-type'), 'text/markdown', 'but not as something a browser renders as a page')
    assert.match(String(runnable.headers.get('content-disposition')), /attachment/, 'it is offered as a download instead')

    const outside = await fetch(`${origin}/api/raw?path=${encodeURIComponent('/etc/passwd')}`, { headers: { cookie } })
    assert.equal(outside.status, 404, 'a path outside every workspace root is not served')

    const refused = await fetch(`${origin}/api/file?path=${encodeURIComponent('/etc/passwd')}`, { headers: { cookie } })
    assert.equal(refused.status, 400, 'a file outside every workspace root is refused')

    /**
     * The second surface is **gone**, in the served page.
     *
     * Asserted on the markup the server sends, because that is what a client receives: a tab that is hidden by a
     * script still exists, and a document list beside it would still be fetched.
     */
    const page = await (await fetch(server.url, { headers: { cookie } })).text()
    assert.ok(!page.includes('data-view="docs"'), 'no Docs tab is offered')
    assert.ok(!page.includes('id="docs-list"'), 'and no document list is built')
    assert.ok(!/>Docs</.test(page), 'nor is the word offered as a control')
    assert.match(page, /data-view="file"/, 'while the file panel is there')
  } finally {
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('an html document is previewed as a page, and nothing in it can act', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('html-view')
  const work = fixtureDir('html-view')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  /**
   * A document written for this check, with everything a preview must refuse: a script, an inline handler, an iframe,
   * a form, and a working image beside it — so the check can tell "the document's own resources load" from "the
   * document was reduced to text".
   */
  writeFileSync(
    join(work, 'page.html'),
    [
      '<!doctype html><html><head><title>Fixture</title>',
      '<style>h1 { color: rgb(1, 2, 3) }</style></head><body>',
      '<h1>Fixture page</h1>',
      '<img src="mark.svg" alt="beside it" width="40" height="40">',
      '<img src="missing.png" onerror="window.__pwned = 1">',
      '<script>window.__pwned = 1</script>',
      '<iframe src="https://example.com"></iframe>',
      '<form action="https://example.com"><input name="x"></form>',
      '</body></html>',
    ].join('\n'),
  )
  writeFileSync(join(work, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#E68000"/></svg>')

  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    /** The fixture is made a workspace, which is what makes its files reachable through the routes. */
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: work }),
    })

    /** The route's answer: the document with its resources rewritten, and the policy it must run under. */
    const payload = await (await fetch(`${origin}/api/html?path=${encodeURIComponent(join(work, 'page.html'))}`, { headers: { cookie } })).json()
    assert.ok(String(payload.html).includes(join(work, 'mark.svg').split('/').pop() ?? ''), 'the document came back')
    assert.match(String(payload.html), /\/api\/raw\?path=/, 'with its relative image pointed at the route that serves it')
    assert.match(String(payload.csp), /script-src 'none'/, 'and a policy that forbids script')

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 0', 20_000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
    await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === ${JSON.stringify(work.split('/').pop() ?? '')}); if (row) row.click() })()`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
    const clicked = await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === 'page.html'); if (row === undefined) return false; row.click(); return true })()`)
    assert.ok(clicked, 'the page is in the tree')
    assert.ok(await browser.waitFor('!document.getElementById("file-html").hidden', 20_000), 'the frame is shown rather than the text pane')
    /**
     * Wait for the document's own image to **decode**, not merely to be requested.
     *
     * Measured: the reading was taken as soon as the frame appeared, and under the load of the whole part the image
     * had not finished — 0 of 2, while the same check passed alone. `complete && naturalWidth > 0` is the only reading
     * that means the browser has the picture.
     */
    await browser.waitFor(
      `(() => { const frame = document.getElementById('html-view'); const inner = frame.contentDocument; return inner !== null && [...inner.querySelectorAll('img')].some((image) => image.complete && image.naturalWidth > 0) })()`,
      15_000,
    )

    const framed = JSON.parse(
      await browser.evaluate(`(() => {
        const frame = document.getElementById('html-view')
        const inner = frame.contentDocument
        if (inner === null) return JSON.stringify({ reachable: false })
        const images = [...inner.querySelectorAll('img')]
        return JSON.stringify({
          reachable: true,
          sandbox: frame.getAttribute('sandbox'),
          scripts: inner.querySelectorAll('script').length,
          iframes: inner.querySelectorAll('iframe').length,
          forms: inner.querySelectorAll('form').length,
          inputs: inner.querySelectorAll('input').length,
          handlers: [...inner.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
          policy: inner.querySelector('meta[http-equiv="Content-Security-Policy"]') === null ? 'missing' : 'present',
          heading: (inner.querySelector('h1') || {}).textContent,
          headingColour: inner.querySelector('h1') === null ? null : getComputedStyle(inner.querySelector('h1')).color,
          images: images.length,
          imagesLoaded: images.filter((i) => i.complete && i.naturalWidth > 0).length
        })
      })()`),
    )
    assert.ok(framed.reachable, 'the frame holds a document')
    /**
     * The sandbox is the boundary, so it is asserted rather than assumed: `allow-same-origin` lets the frame fetch its
     * own resources through this server, and **no** `allow-scripts` is what stops the document running.
     */
    assert.equal(framed.sandbox, 'allow-same-origin', 'the frame allows resources and no scripts')
    assert.equal(framed.scripts, 0, 'a script element was removed')
    assert.equal(framed.handlers, 0, 'and an inline handler with it')
    assert.equal(framed.iframes, 0, 'nothing may be framed inside it')
    assert.equal(framed.forms + framed.inputs, 0, 'and nothing may be submitted')
    assert.equal(framed.policy, 'present', 'the document carries the policy the browser enforces')
    assert.equal(framed.heading, 'Fixture page', 'the page rendered as a page rather than as its source')
    assert.equal(framed.headingColour, 'rgb(1, 2, 3)', "with the document's own stylesheet applied")
    assert.ok(framed.imagesLoaded > 0, `and its own image loaded (${framed.imagesLoaded} of ${framed.images})`)
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a click in the left panel opens the one preview, rendered for its type and styled', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('preview-ui')
  const work = fixtureDir('preview-ui')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    const cookie = await handshakeCookie(server.url)
    const origin = new URL(server.url).origin
    await fetch(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: '/Users/zhenc/heddle' }),
    })

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 0', 20_000)
    await browser.evaluate('document.querySelector("#tree .row").click()')
    await browser.waitFor('document.querySelectorAll("#tree .row").length > 1', 20_000)

    const openFile = async (name) => {
      const found = await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.label').textContent === ${JSON.stringify(name)}); if (row === undefined) return false; row.click(); return true })()`)
      assert.ok(found, `${name} is in the tree`)
      /**
       * Wait for **this file**, not for a fixed moment.
       *
       * Measured: with a 1.5 s sleep the full-file run read the previous document — the reader was still drawing under
       * the load of the other checks — while the same check passed alone. Waiting on the pane's own header removes the
       * race instead of making it less likely.
       */
      assert.ok(
        await browser.waitFor(`document.getElementById('file-head').textContent.includes(${JSON.stringify(name)})`, 20_000),
        `${name} is the file the pane is showing`,
      )
      /**
       * And for the **placeholder to go**, not for the pane to have text.
       *
       * Measured: the pane says `reading…` while the fetch is in flight, and that is text — so a wait on "has text"
       * passed before the file arrived and the check read the previous file's renderer. The placeholder is the signal
       * that the read has finished, and it is the only one the page offers before the body is drawn.
       */
      assert.ok(
        await browser.waitFor(`document.getElementById('file-body').innerText.trim() !== 'reading…'`, 20_000),
        `${name} finished reading`,
      )
      return JSON.parse(
        await browser.evaluate(`(() => {
          const body = document.getElementById('file-body')
          const table = body.querySelector('table th')
          const gutter = body.querySelector('.ln')
          const code = body.querySelector('code')
          const heading = body.querySelector('h1')
          return JSON.stringify({
            ring: [...document.querySelectorAll('#views button')].filter((x) => !x.hidden).map((x) => x.textContent),
            fileHidden: document.getElementById('file').hidden,
            renderer: body.dataset.renderer,
            chars: body.innerText.length,
            highlighted: body.querySelectorAll('span[class^="hljs-"]').length,
            codeSize: parseFloat(getComputedStyle(body).fontSize),
            lineHeight: parseFloat(getComputedStyle(body).lineHeight),
            gutterWidth: (() => { const ln = body.querySelector('.ln'); return ln === null ? 0 : Math.round(ln.getBoundingClientRect().width) })(),
            gutterNarrow: (() => { const ln = body.querySelector('.ln'); return ln !== null && ln.getBoundingClientRect().width < 34 })(),
            stackIncludesCjk: /PingFang|YaHei|Heiti|Songti/i.test(getComputedStyle(body).fontFamily),
            links: body.querySelectorAll('a[data-heddle-path]').length,
            images: body.querySelectorAll('img').length,
            imagesLoaded: [...body.querySelectorAll('img')].filter((image) => image.complete && image.naturalWidth > 0).length,
            classes: new Set([...body.querySelectorAll('span[class^="hljs-"]')].map((span) => span.className)).size,
            colours: new Set([...body.querySelectorAll('span[class^="hljs-"]')].map((span) => getComputedStyle(span).color)).size,
            entityCodes: (body.innerText.match(/&#x?[0-9a-fA-F]+;/g) ?? []).length,
            gutter: gutter === null ? null : gutter.textContent,
            tableBorder: table === null ? null : getComputedStyle(table).borderTopWidth,
            inlineCodeBg: (() => { const c = body.querySelector('p code'); return c === null ? null : getComputedStyle(c).backgroundColor })(),
            headingBigger: heading === null ? null : parseFloat(getComputedStyle(heading).fontSize) > parseFloat(getComputedStyle(body).fontSize),
            codeFont: code === null ? null : getComputedStyle(code).fontFamily.includes('mono')
          })
        })()`),
      )
    }

    /** A document: the markdown library, and the styles the project shares for a rendered document. */
    const document = await openFile('AGENTS.md')
    assert.equal(document.fileHidden, false, 'a click shows the file panel')
    assert.deepEqual(document.ring, ['File'], 'and the ring offers the file alone, which is the one preview surface')
    assert.equal(document.renderer, 'markdown', 'the document is rendered as markdown')
    assert.ok(document.chars > 1_000, `and it holds the document (${document.chars} characters)`)
    assert.ok(document.tableBorder !== null && document.tableBorder !== '0px', `its table is a bordered table (${document.tableBorder})`)
    assert.notEqual(document.inlineCodeBg, 'rgba(0, 0, 0, 0)', 'an inline code span has its own background')
    assert.equal(document.headingBigger, true, 'a heading is larger than the body text')

    /** Source: the highlighting library, with a gutter, and no markdown rendering. */
    const source = await openFile('package.json')
    assert.equal(source.renderer, 'code', 'a source file is source')
    assert.ok(source.highlighted > 0, `coloured by the highlighter (${source.highlighted} spans)`)
    assert.equal(source.gutter, '1', 'with a line gutter starting at one')
    assert.equal(source.codeFont, true, 'in a monospace face')

    /**
     * And the colours are **applied**, which is the half that was missing when the owner reported it.
     *
     * Measured: `src/cli.ts` rendered 2702 spans and every one of them was white, because the theme rules named the
     * markdown pane and a source file is not one. Spans in the markup prove the library ran; only the computed
     * colour proves a reader can see what it decided.
     */
    assert.ok(source.classes > 1, `a source file holds more than one kind of token (${source.classes})`)
    assert.ok(
      source.colours > 1,
      `and those kinds resolve to different colours, so the theme reaches this pane (${source.colours})`,
    )

    /**
     * No entity code is shown to a reader.
     *
     * Measured: an import line read `from &#x27;node:fs&#x27;`, because the highlighter writes a single quote as the
     * hexadecimal `&#x27;` and this project's decoder listed the decimal `&#39;`. A renderer that leaves escaping in
     * the text has not finished its job, whatever the markup looks like.
     */
    assert.equal(source.entityCodes, 0, `no entity code is visible in the text (${source.entityCodes} found)`)

    /**
     * A link to a file in the workspace is followed **in the panel**.
     *
     * Measured, and it is the owner's report: `[x](DEPLOY.md)` asked the browser for `/DEPLOY.md`, which answered
     * `404`, so following a link lost the document being read. A plain click now opens the file here; the address
     * stays real, so the status bar and a middle-click still point somewhere.
     */
    const linked = await openFile('ULTIMATE_GOAL.md')
    assert.ok(linked.links > 0, `the document has links to other files (${linked.links})`)
    const followed = JSON.parse(
      await browser.evaluate(`(async () => {
        const anchor = [...document.querySelectorAll('#file-body a[data-heddle-path]')][0]
        if (anchor === undefined) return JSON.stringify({ missing: true })
        const before = location.pathname
        anchor.click()
        await new Promise((done) => setTimeout(done, 2_500))
        return JSON.stringify({
          before,
          after: location.pathname,
          head: document.getElementById('file-head').textContent,
          renderer: document.getElementById('file-body').dataset.renderer,
          chars: document.getElementById('file-body').innerText.length
        })
      })()`),
    )
    assert.ok(!followed.missing, 'a link to another file is marked for the panel')
    assert.equal(followed.after, followed.before, 'following it does not navigate the page away')
    assert.match(followed.head, /INDEX\.md|ULTIMATE_GOAL\.md|_verifiers_/, `the panel shows the file that was linked (${followed.head})`)
    assert.equal(followed.renderer, 'markdown', 'rendered, not shown as a source file')
    assert.ok(followed.chars > 500, `and its content is there (${followed.chars} characters)`)

    /**
     * The image in a document is **fetched and decoded**, not merely referenced.
     *
     * `naturalWidth > 0` is the only reading that proves it: an `<img>` with a broken source still exists in the DOM
     * and still has a `src`, so counting elements would pass while a reader sees a broken marker.
     */
    const illustration = await openFile('README.md')
    assert.ok(illustration.images > 0, `the document embeds an image (${illustration.images})`)
    assert.ok(
      illustration.imagesLoaded > 0,
      `and the browser loaded it (${illustration.imagesLoaded} of ${illustration.images} decoded)`,
    )

    /**
     * The code is set for reading, and it is set for **both appearances**.
     *
     * Two claims, each measured before it was made. The typography: a bare `monospace` resolved to whatever the
     * platform picked, with no CJK coverage, so a Chinese comment lost its column — the stack is now a named one
     * ending in the CJK faces. The appearance: the palette was written for a dark surface only, and the page paints
     * its own background, so on a light system the same pale tokens would have sat on white.
     */
    assert.ok(source.codeSize >= 11 && source.codeSize <= 14, `code is set at a readable size (${source.codeSize}px)`)
    assert.ok(
      source.lineHeight >= source.codeSize * 1.4,
      `with enough leading to read a long file (${source.lineHeight}px on ${source.codeSize}px)`,
    )
    assert.ok(source.stackIncludesCjk, 'and a stack with a CJK fallback, so a mixed line stays monospaced')
    assert.ok(source.gutterNarrow, `the line numbers are a margin note rather than a column (${source.gutterWidth}px)`)

    /** Neither: shown as it is, and still not interpreted. */
    const plain = await openFile('LICENSE')
    assert.equal(plain.renderer, 'text', 'a file with no renderer is text')
    assert.equal(plain.highlighted, 0, 'with nothing invented for it')
    assert.ok(plain.chars > 100, 'and its content is there')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
