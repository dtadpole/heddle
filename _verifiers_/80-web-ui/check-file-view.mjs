import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The file pane, by what kind of file was opened.
 *
 * A source file used to arrive as one wall of text in a `<pre>`, which is unnecessary: a reader of
 * JavaScript or Python wants the line they are on, and a reader of a document wants a document. This
 * check judges both halves of that claim — the decision and the markup over HTTP, and the pane in a
 * browser — because the security property lives in the first and the usefulness in the second.
 *
 * The property that matters is that a file's bytes are **shown**, never obeyed: a file containing
 * `<script>` must appear as text in the panel and must not run. That is judged with a global the script
 * would set if it ran, rather than by trusting the absence of a tag.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`file-view-${label}`)
  const work = fixtureDir(`file-view-${label}-work`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config } },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 15s\n${output}`))
        }
      }, 15_000).unref()
    })()
  })
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const PYTHON = [
  '# a tiny tool',
  'import sys',
  '',
  'def greet(name):',
  '    """Say hello."""',
  '    return f"hello {name}"',
  '',
  'if __name__ == "__main__":',
  '    print(greet(sys.argv[1]))',
  '',
].join('\n')

const JAVASCRIPT = [
  '// a tiny script',
  'const LIMIT = 42;',
  '',
  'export function clamp(value) {',
  '  if (value > LIMIT) return LIMIT; /* cap it */',
  '  return value;',
  '}',
  '',
].join('\n')

/** A file whose bytes would be a script if anything rendered them as markup. */
const HOSTILE = '<script>window.__ran = true</script>\nconst ok = 1;\n'

test('the file route decides by kind, and never lets a file become markup', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('api')
  try {
    mkdirSync(join(server.work, 'src'), { recursive: true })
    writeFileSync(join(server.work, 'tool.py'), PYTHON)
    writeFileSync(join(server.work, 'src', 'clamp.js'), JAVASCRIPT)
    writeFileSync(join(server.work, 'README.md'), '# Title\n\n- one\n')
    writeFileSync(join(server.work, 'notes.txt'), 'plain words\n')
    writeFileSync(join(server.work, 'hostile.js'), HOSTILE)

    const cookie = await cookieFor(server.url)
    const registered = await api(server.url, cookie, '/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: server.work }),
    })
    assert.equal(registered.status, 200, 'the fixture folder is a workspace root')

    const python = await api(server.url, cookie, `/api/file?path=${encodeURIComponent(join(server.work, 'tool.py'))}`)
    assert.equal(python.status, 200)
    assert.equal(python.body.renderer, 'code')
    assert.equal(python.body.language, 'python')
    /**
     * The classes are `highlight.js`'s, because the panel is rendered by that library now — the same one that colours
     * a fenced block inside a document, so a keyword is classified once in the project rather than twice.
     */
    assert.match(String(python.body.html), /hljs-keyword">def</, 'the language is highlighted, not guessed at')
    assert.match(String(python.body.html), /<span class="ln">1<\/span>/, 'and it carries a gutter')

    const javascript = await api(server.url, cookie, `/api/file?path=${encodeURIComponent(join(server.work, 'src', 'clamp.js'))}`)
    assert.equal(javascript.body.language, 'javascript')
    assert.match(String(javascript.body.html), /hljs-comment">\/\/ a tiny script</)

    const markdown = await api(server.url, cookie, `/api/file?path=${encodeURIComponent(join(server.work, 'README.md'))}`)
    assert.equal(markdown.body.renderer, 'markdown', 'a document is rendered as a document')
    assert.match(String(markdown.body.html), /<h1>Title<\/h1>/)

    const text = await api(server.url, cookie, `/api/file?path=${encodeURIComponent(join(server.work, 'notes.txt'))}`)
    assert.equal(text.body.renderer, 'text')
    assert.equal(text.body.html, undefined, 'plain text is handed over verbatim, with no markup to inject')

    const hostile = await api(server.url, cookie, `/api/file?path=${encodeURIComponent(join(server.work, 'hostile.js'))}`)
    assert.equal(hostile.body.renderer, 'code')
    assert.ok(!String(hostile.body.html).includes('<script'), 'the file’s script tag does not survive as a tag')
    assert.match(String(hostile.body.html), /&lt;script&gt;/, 'it is visible as text instead')
  } finally {
    await server.close()
  }
})

test('the browser shows a Python file as source, and does not run what a file says', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page')
  const browser = await openBrowser()
  try {
    writeFileSync(join(server.work, 'tool.py'), PYTHON)
    writeFileSync(join(server.work, 'hostile.js'), HOSTILE)
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })

    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)
    // Open the workspace root, so its files are drawn.
    /**
     * The row is the control now: the owner removed the `+` / `−` box once clicking a folder began to open and
     * close it, so this clicks the row rather than a control that no longer exists.
     */
    assert.ok(await browser.waitFor('document.querySelector("#tree .row") !== null', 10_000), 'the workspace row is drawn')
    /**
     * Open the root only when it says it is closed. The page opens the first workspace on a first visit (measured from
     * DSH, 2026-10-17), so an unconditional click closed the branch it meant to open and the file below was never drawn
     * — the failure read as `Cannot read properties of undefined (reading 'click')` two steps later.
     */
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree .row')
      if (row.closest('li').dataset.open === 'false') row.click()
      return true
    })()`)
    assert.ok(
      await browser.waitFor(`Array.from(document.querySelectorAll('#tree .row')).some((row) => row.dataset.path.endsWith('tool.py'))`, 10_000),
      'the workspace\'s files are drawn once it is open',
    )
    await browser.evaluate(`Array.from(document.querySelectorAll('#tree .row')).find((row) => row.dataset.path.endsWith('tool.py')).click()`)
    await browser.waitFor('document.querySelectorAll("#file-body .line").length > 0', 10_000)

    const shown = await browser.evaluate(`(() => {
      const body = document.getElementById('file-body')
      return {
        renderer: document.getElementById('file').querySelector('#file-body').dataset.renderer,
        lines: body.querySelectorAll('.line').length,
        keywords: body.querySelectorAll('.hljs-keyword').length,
        text: body.innerText,
      }
    })()`)
    assert.equal(shown.renderer, 'code', 'the pane says how it is showing the file')
    assert.equal(shown.lines, PYTHON.split('\n').length, 'every line has a row, including the last empty one')
    assert.ok(shown.keywords > 0, 'and Python keywords are marked')
    assert.match(shown.text, /def greet\(name\):/, 'the source is on screen')

    // The hostile file: shown, and not obeyed. The global is what a script would set if it ran.
    await browser.evaluate(`Array.from(document.querySelectorAll('#tree .row')).find((row) => row.dataset.path.endsWith('hostile.js')).click()`)
    await browser.waitFor('document.getElementById("file-body").innerText.includes("__ran")', 10_000)
    const ran = await browser.evaluate('window.__ran === true')
    assert.equal(ran, false, 'the file was displayed, not executed')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * A file route serves a workspace's own bytes on the page's origin, with the session cookie in scope, so whatever a
 * browser can run there runs as the user. Measured 2026-10-29 (DSH parity R-developer-twelve-16): `/api/raw` served
 * a workspace SVG inline, and opened directly its script ran and its `fetch('/api/sessions')` answered 200. DSH
 * answers its own file route with `Content-Security-Policy: sandbox; default-src 'none'` and
 * `X-Content-Type-Options: nosniff` on every answer, because "HTML and SVG files may be opened directly on the
 * authenticated API origin"; heddle's file routes now do the same, success or failure.
 */
const FILE_POLICY = "sandbox; default-src 'none'"
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/><script>window.__svgRan = true; document.title = "SVG RAN"</script></svg>\n'

test('every answer of the raw and upload routes is sandboxed and never sniffed, as DSH answers its file route', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('file-headers')
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'logo.svg'), HOSTILE_SVG)
    writeFileSync(join(server.work, 'style.css'), 'h1 { color: red; }\n')
    writeFileSync(join(server.work, 'page.html'), '<!doctype html><h1>page</h1><script>window.__ran = true</script>\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const headersOf = async (path, init = {}) => {
      const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie, ...(init.headers ?? {}) } })
      const body = await response.text()
      return { status: response.status, policy: response.headers.get('content-security-policy'), sniff: response.headers.get('x-content-type-options'), body }
    }
    const raw = (name) => `/api/raw?path=${encodeURIComponent(join(server.work, name))}`
    const cases = [
      ['an inline SVG', raw('logo.svg'), 200],
      ['an inline stylesheet', raw('style.css'), 200],
      ['a page offered as a download', raw('page.html'), 200],
      ['a missing file', raw('missing.txt'), 404],
      ['a request without a path', '/api/raw?path=', 400],
      ['a missing upload', '/api/uploads/no-such-file.svg', 404],
    ]
    const uploaded = await headersOf('/api/uploads?name=evil.svg', { method: 'POST', body: HOSTILE_SVG })
    assert.equal(uploaded.status, 200, `the upload was stored (${uploaded.status})`)
    const stored = String(JSON.parse(uploaded.body).path ?? '')
    const leaf = stored.split('/').pop()
    /**
     * An upload is read only for a session whose log references it (R-developer-two-10, DSH's session/attachment), so
     * a turn sends the SVG first; the served answer and the refusal for no session are both sandboxed and unsniffed.
     */
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'the logo', folder: server.work, attachments: [stored] }),
    })
    const turnText = await turn.text()
    const session = /"session":"(session-[0-9a-f-]{36})"/.exec(turnText)?.[1]
    assert.ok(session !== undefined, `the turn that sends the SVG names its session (HTTP ${turn.status}: ${turnText.slice(0, 160)})`)
    cases.push(['an uploaded SVG, read for the session that sent it', `/api/uploads/${encodeURIComponent(leaf)}?session=${session}`, 200])
    cases.push(['an uploaded SVG read for no session', `/api/uploads/${encodeURIComponent(leaf)}`, 404])
    for (const [what, path, status] of cases) {
      const answer = await headersOf(path)
      assert.equal(answer.status, status, `${what} answers ${status} (${answer.status})`)
      assert.equal(answer.policy, FILE_POLICY, `${what} is sandboxed with no sources (${answer.policy})`)
      assert.equal(answer.sniff, 'nosniff', `${what} is never sniffed into another type (${answer.sniff})`)
    }
  } finally {
    await server.close()
  }
})

test('an SVG opened directly runs no script and cannot reach the API, while the same SVG still embeds as an image', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('svg')
  const browser = await openBrowser()
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'logo.svg'), HOSTILE_SVG)
    writeFileSync(join(server.work, 'README.md'), '# Logo\n\n![logo](logo.svg)\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })

    // The browser holds the session cookie, as a person's does, then opens the SVG itself.
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)
    await browser.goto(new URL(`/api/raw?path=${encodeURIComponent(join(server.work, 'logo.svg'))}`, server.url).href)
    await new Promise((resolve) => setTimeout(resolve, 800))
    const opened = await browser.evaluate(`(async () => {
      let api = null
      try { api = (await fetch('/api/sessions')).status } catch { api = 'refused' }
      return { ran: window.__svgRan === true, title: document.title, api }
    })()`)
    assert.equal(opened.ran, false, "the SVG's script did not run")
    assert.notEqual(opened.title, 'SVG RAN', 'and did not rename the document')
    assert.notEqual(opened.api, 200, `nothing in that document can use the session's API (${opened.api})`)

    // The same SVG, embedded by a document, is still an image.
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.querySelector("#tree .row") !== null', 10_000), 'the workspace row is drawn')
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree .row')
      if (row.closest('li').dataset.open === 'false') row.click()
      return true
    })()`)
    await browser.waitFor(`Array.from(document.querySelectorAll('#tree .row')).some((row) => row.dataset.path.endsWith('README.md'))`, 10_000)
    await browser.evaluate(`Array.from(document.querySelectorAll('#tree .row')).find((row) => row.dataset.path.endsWith('README.md')).click()`)
    assert.ok(
      await browser.waitFor(`(() => { const img = document.querySelector('#file-body img'); return !!img && img.complete && img.naturalWidth > 0 })()`, 10_000).catch(() => false),
      'the README still shows the SVG as an image',
    )
  } finally {
    browser.close()
    await server.close()
  }
})
