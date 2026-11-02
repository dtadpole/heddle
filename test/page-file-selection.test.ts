import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function fn(name: string) {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0)
  return page.slice(start, page.indexOf('\n}', start) + 2)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const html = deferred<unknown>()
  const htmlStarted = deferred<void>()
  const purifier = deferred<{ sanitize: (value: string) => string }>()
  const purifierStarted = deferred<void>()
  const children: Array<{ textContent: string; hidden: boolean; attributes: Record<string, string>; [key: string]: unknown }> = []
  const body = { textContent: '', innerHTML: '', hidden: false, dataset: { renderer: '' }, replaceChildren(...nodes: typeof children) { children.splice(0, children.length, ...nodes) } }
  const head = { textContent: '' }
  const shellStarted = deferred<void>()
  let shellAutoLoad = true
  let imported = ''
  const makeFrame = (): any => ({
    attributes: {} as Record<string, string>, onload: null, onerror: null,
    setAttribute(name: string, value: string) { this.attributes[name] = value },
    removeAttribute(name: string) { delete this.attributes[name] },
    cloneNode() { return makeFrame() },
    replaceWith(next: any) { frame = next },
    contentDocument: {
      URL: 'http://localhost/api/html/frame', contentType: 'text/html',
      importNode(node: { html: string }, deep: boolean) { assert.equal(deep, true); return node },
      documentElement: { replaceWith(node: { html: string }) { imported = node.html } },
    },
    set src(value: string) {
      this.attributes.src = value
      shellStarted.resolve()
      if (shellAutoLoad) queueMicrotask(() => this.onload?.())
    },
  })
  let frame = makeFrame()
  const pane = { hidden: true }
  const context = {
    fileBody: body, fileHead: head, get htmlView() { return frame }, set htmlView(value) { frame = value }, fileHtml: pane,
    location: { href: 'http://localhost/' }, URL, setTimeout, clearTimeout,
    DOMParser: class { parseFromString(html: string, type: string) { assert.equal(type, 'text/html'); return { documentElement: { html } } } },
    PREVIEW_TAGS: [], PREVIEW_ATTRS: [],
    document: {
      getElementById: () => ({ setAttribute() {} }),
      createElement: () => ({ textContent: '', hidden: false, attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value } }),
    },
    closeSchedulesPage() {},
    chooseSelected() {}, renderRing() {}, showView: async () => {}, humanBytes: () => '10 B',
    loadPurifier: () => { purifierStarted.resolve(); return purifier.promise },
    fetch: async (url: string) => {
      if (url.includes('network-failure')) throw new Error('offline')
      return { ok: !url.includes('invalid'), json: async () => {
      if (url.startsWith('/api/html')) { htmlStarted.resolve(); return html.promise }
      const path = decodeURIComponent(url.split('=')[1]!)
      if (path.endsWith('.png')) return { path, name: 'pixel.png', bytes: 68, renderer: 'image', image: { mediaType: 'image/png', src: path.includes('foreign-source') ? 'https://example.invalid/pixel.png' : '/api/raw?path=' + encodeURIComponent(path) } }
      return { path, error: 'not UTF-8 text', bytes: 10, lines: 1, renderer: path.endsWith('.html') ? 'html' : 'text', text: 'NEW TEXT' }
    } }
    },
  }
  const api = runInNewContext(`let fileFetches = 0; let cancelHtmlFrame = null; ${fn('showFile')} ${fn('showHtml')}; ({showFile})`, context) as { showFile(node: { path: string }): Promise<void> }
  const snapshot = () => JSON.stringify({ body, head, frame: imported, hidden: pane.hidden })
  return { ...api, html, htmlStarted, purifier, purifierStarted, shellStarted, snapshot, body, get frame() { return frame }, get imported() { return imported }, get shellAutoLoad() { return shellAutoLoad }, set shellAutoLoad(value: boolean) { shellAutoLoad = value }, pane, children }
}

test('PNG uses authorized raw img with accessible loading, success and error states', async () => {
  const state = harness()
  await state.showFile({ path: '/w/pixel & snow.png' })
  assert.equal(state.body.dataset.renderer, 'image')
  assert.equal(state.children.length, 2)
  const [status, image] = state.children
  assert.ok(status && image)
  assert.equal(image.src, '/api/raw?path=%2Fw%2Fpixel%20%26%20snow.png')
  assert.equal(image.referrerPolicy, 'no-referrer')
  assert.equal(image.alt, 'Image preview: pixel.png')
  assert.equal(image.hidden, true)
  ;(image.onload as () => void)()
  assert.equal(image.hidden, false)
  assert.equal(status.hidden, true)
  ;(image.onerror as () => void)()
  assert.equal(image.hidden, true)
  assert.equal(status.attributes.role, 'alert')
  assert.match(status.textContent, /could not be displayed/)
  await state.showFile({ path: '/w/new.txt' })
  const latest = state.snapshot()
  ;(image.onload as () => void)()
  ;(image.onerror as () => void)()
  assert.equal(state.snapshot(), latest, 'stale image callbacks do not overwrite the newer selection')
})

test('PNG rejects a source other than its exact same-origin raw route', async () => {
  const state = harness()
  await state.showFile({ path: '/w/foreign-source.png' })
  assert.equal(state.children.length, 0)
  assert.match(state.body.textContent, /invalid PNG preview source/)
})

test('an older HTML second-fetch cannot overwrite a newer plain selection', async () => {
  const state = harness()
  const old = state.showFile({ path: '/w/old.html' })
  await state.htmlStarted.promise
  await state.showFile({ path: '/w/new.txt' })
  const latest = state.snapshot()
  state.html.resolve({ html: '<head></head><body>OLD</body>' })
  // Old implementation reaches lazy purifier; let it finish so the assertion exposes the stale publication.
  state.purifier.resolve({ sanitize: (value) => value })
  await old
  assert.equal(state.snapshot(), latest)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`a superseded lazy sanitizer ${outcome} cannot change the pane`, async () => {
    const state = harness()
    const old = state.showFile({ path: '/w/old.html' })
    await state.htmlStarted.promise
    state.html.resolve({ html: '<head></head><body>OLD</body>' })
    await state.purifierStarted.promise
    await state.showFile({ path: '/w/new.txt' })
    const latest = state.snapshot()
    if (outcome === 'success') state.purifier.resolve({ sanitize: (value) => value })
    else state.purifier.reject(new Error('not loaded'))
    await old
    assert.equal(state.snapshot(), latest)
  })
}

test('the active HTML selection still publishes its sanitized frame', async () => {
  const state = harness()
  const current = state.showFile({ path: '/w/current.html' })
  await state.htmlStarted.promise
  state.html.resolve({ html: '<head></head><body>CURRENT</body>' })
  state.purifier.resolve({ sanitize: (value) => value })
  await current
  assert.match(state.imported, /CURRENT/)
  assert.equal(state.pane.hidden, false)
  assert.equal(state.body.hidden, true)
})


test('HTML publication honors base-none without injecting a base and preserves sanitization and sandbox', async () => {
  const state = harness()
  const current = state.showFile({ path: '/w/current.html' })
  await state.htmlStarted.promise
  state.html.resolve({ html: '<head><base href="https://example.invalid/"></head><body>CURRENT</body>', csp: "default-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'" })
  let options: { FORBID_TAGS: string[]; FORBID_ATTR: string[]; WHOLE_DOCUMENT: boolean } | undefined
  state.purifier.resolve({ sanitize: (value: string, config?: typeof options) => {
    options = config
    return value.replace(/<base[^>]*>/gi, '')
  } })
  await current
  assert.doesNotMatch(state.imported, /<base\b/i, 'no application base contradicts the CSP')
  assert.doesNotMatch(state.imported, /http-equiv/, 'parent injects no policy markup or JSON policy')
  assert.equal(state.frame.attributes.src, '/api/html/frame')
  assert.equal(state.frame.attributes.referrerpolicy, 'no-referrer')
  assert.equal(state.frame.attributes.sandbox, 'allow-same-origin', 'no scripts, forms or navigation permissions added')
  assert.ok(options?.FORBID_TAGS.includes('base'), 'source base remains forbidden by the actual sanitizer configuration')
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form']) assert.ok(options?.FORBID_TAGS.includes(tag), tag)
  assert.ok(options?.FORBID_ATTR.includes('srcdoc'))
  assert.equal(options?.WHOLE_DOCUMENT, true)
})

test('shell waits for load, imports only sanitized output, and ignores response CSP text', async () => {
  const state = harness()
  state.shellAutoLoad = false
  const current = state.showFile({ path: '/w/current.html' })
  await state.htmlStarted.promise
  state.html.resolve({ html: 'RAW SCRIPT SENTINEL', csp: 'UNTRUSTED POLICY' })
  state.purifier.resolve({ sanitize: () => '<html><head></head><body>CLEAN ONLY</body></html>' })
  await state.shellStarted.promise
  assert.equal(state.imported, '', 'nothing is injected before shell load')
  assert.equal(state.frame.attributes.src, '/api/html/frame', 'no file path reaches iframe URL')
  state.frame.onload()
  await current
  assert.match(state.imported, /CLEAN ONLY/)
  assert.doesNotMatch(state.imported, /RAW|UNTRUSTED/)
})

for (const failure of ['load-error', 'wrong-origin', 'initial-blank', 'non-html', 'denied-access'] as const) {
  test(`shell ${failure} fails closed with visible text`, async () => {
    const state = harness()
    state.shellAutoLoad = false
    const current = state.showFile({ path: '/w/current.html' })
    await state.htmlStarted.promise
    state.html.resolve({ html: '<head></head><body>CLEAN</body>' })
    state.purifier.resolve({ sanitize: (value) => value })
    await state.shellStarted.promise
    if (failure === 'load-error') state.frame.onerror()
    else {
      if (failure === 'wrong-origin') state.frame.contentDocument.URL = 'https://example.invalid/api/html/frame'
      if (failure === 'initial-blank') state.frame.contentDocument.URL = 'about:blank'
      if (failure === 'non-html') state.frame.contentDocument.contentType = 'text/plain'
      if (failure === 'denied-access') Object.defineProperty(state.frame, 'contentDocument', { get() { throw new Error('access denied') } })
      state.frame.onload()
    }
    await current
    assert.equal(state.imported, '')
    assert.equal(state.pane.hidden, true)
    assert.equal(state.body.hidden, false)
    assert.match(state.body.textContent, /could not read this file/)
  })
}

for (const outcome of ['load', 'error'] as const) {
  test(`abandoned shell ${outcome} callback cannot touch a newer selection`, async () => {
    const state = harness()
    state.shellAutoLoad = false
    const old = state.showFile({ path: '/w/old.html' })
    await state.htmlStarted.promise
    state.html.resolve({ html: '<head></head><body>OLD</body>' })
    state.purifier.resolve({ sanitize: (value) => value })
    await state.shellStarted.promise
    const callback = outcome === 'load' ? state.frame.onload : state.frame.onerror
    await state.showFile({ path: '/w/new.txt' })
    await old
    const latest = state.snapshot()
    callback()
    assert.equal(state.snapshot(), latest)
    assert.equal(state.imported, '')
  })
}

test('shared source cancels on leaving file view and never uses source-document writing', () => {
  const source = fn('showHtml')
  assert.doesNotMatch(source, /\.srcdoc\s*=|document\.write|body\.csp|parseFromString\(body\./)
  assert.match(source, /parseFromString\(clean, 'text\/html'\)/)
  assert.match(source, /documentElement\.replaceWith\(inner\.importNode/)
  assert.match(source, /ticket !== fileFetches \|\| htmlView !== frame/)
  assert.match(fn('showView'), /next !== 'file'[\s\S]*\+\+fileFetches[\s\S]*cancelHtmlFrame\(\)/)
})

for (const path of ['/w/invalid.bin', '/w/network-failure.txt']) {
  test(`a failed new selection is visible after a settled HTML preview: ${path}`, async () => {
    const state = harness()
    const html = state.showFile({ path: '/w/current.html' })
    await state.htmlStarted.promise
    state.html.resolve({ html: '<head></head><body>OLD HTML</body>' })
    state.purifier.resolve({ sanitize: (value) => value })
    await html
    assert.equal(state.pane.hidden, false)
    await state.showFile({ path })
    assert.equal(state.body.hidden, false, 'Refs #113: refusal text must be visible')
    assert.equal(state.pane.hidden, true, 'old HTML must not remain visible under failed filename')
    assert.equal(state.body.dataset.renderer, 'text')
    assert.match(state.body.textContent, /not UTF-8|could not read/)
  })
}
