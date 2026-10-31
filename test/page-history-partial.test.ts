import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function fn(name: string) {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `The page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end >= 0, `The page closes ${name}`)
  return page.slice(start, end + 2)
}

// Only the DOM operations used by assistant rows and their copy toolbar are needed.
// Setting textContent/innerHTML discards children, as in the browser: a stale toolbar
// must not survive the transition back to streaming plain markdown.
class Element {
  readonly tagName: string
  className = ''
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Element[] = []
  type = ''
  title = ''
  onclick?: () => Promise<void>
  private text = ''
  private html = ''
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  classList = {
    add: (name: string) => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}` },
    remove: (name: string) => { this.className = this.className.split(' ').filter((value) => value !== name).join(' ') },
  }
  get textContent(): string { return this.text + this.children.map((node) => node.textContent).join('') }
  set textContent(value: string) { this.text = value; this.html = ''; this.children = [] }
  get innerText(): string { return this.textContent }
  get innerHTML(): string { return this.html }
  set innerHTML(value: string) {
    this.html = value
    this.text = value.replace(/<[^>]*>/g, '')
    this.children = []
  }
  append(...nodes: Element[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: Element[]) { this.text = ''; this.html = ''; this.children = nodes }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  querySelectorAll(selector: string): Element[] {
    assert.ok(selector === '.actions' || selector === 'button', `Supported row selector: ${selector}`)
    return this.children.flatMap((node) => [
      ...((selector === 'button' ? node.tagName === 'BUTTON' : node.className.split(' ').includes('actions')) ? [node] : []),
      ...node.querySelectorAll(selector),
    ])
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}

function harness(renderedHtml: string) {
  const rows: Element[] = []
  const requests: string[] = []
  const copies: string[] = []
  const context = {
    log: {
      append: (row: Element) => rows.push(row),
      querySelectorAll(selector: string) {
        assert.equal(selector, '.turn.assistant:not([data-rendered])')
        return rows.filter((row) => row.dataset.kind === 'assistant' && row.dataset.rendered === undefined)
      },
    },
    document: { createElement: (tag: string) => new Element(tag) },
    lastTurnRow: () => rows.at(-1) ?? null,
    followChatTail() {}, keepRunningLast() {}, paintEmptyState() {}, settleReasoning() {}, updateStatusBar() {},
    copyIcon: () => new Element('svg'), copiedIcon: () => new Element('svg'),
    navigator: { clipboard: { writeText: async (text: string) => { copies.push(text) } } },
    setTimeout() {},
    fetch: async (url: string, options: { method: string; body: string }) => {
      assert.equal(url, '/api/markdown')
      assert.equal(options.method, 'POST')
      requests.push((JSON.parse(options.body) as { text: string }).text)
      return { ok: true, json: async () => ({ html: renderedHtml }) }
    },
  }
  const api = runInNewContext(`
    ${fn('add')}
    ${fn('renderSettledAnswers')}
    ${fn('messageActions')}
    ${fn('copyAction')}
    ({ add, renderSettledAnswers })
  `, context) as {
    add(kind: string, text: string, merge?: boolean, label?: undefined, tool?: { html: string }): void
    renderSettledAnswers(): Promise<void>
  }
  return { ...api, rows, requests, copies }
}

test('a partial pre-rendered assistant answer keeps raw markdown through a late text delta and copies the complete final answer', async () => {
  const partial = 'Keep **bold** and `code`'
  const delta = ' plus **tail**.'
  const complete = partial + delta
  const visible = 'Keep bold and code plus tail.'
  const html = '<p>Keep <strong>bold</strong> and <code>code</code> plus <strong>tail</strong>.</p>'
  const state = harness(html)
  state.add('assistant', partial, false, undefined, { html: '<p>Keep <strong>bold</strong> and <code>code</code></p>' })
  const row = state.rows[0]!
  assert.equal(row.dataset.rendered, 'true')
  assert.equal(row.dataset.copyText, 'Keep bold and code')
  assert.equal(row.querySelectorAll('.actions').length, 1)

  // The page's text-delta handler delegates to this exact assistant-row merge.
  state.add('assistant', delta)
  assert.equal(state.rows.length, 1, 'The delta extends the existing history row')
  assert.equal(row.textContent, complete, 'Streaming restores markdown source, not rendered text or toolbar content')
  assert.equal(row.dataset.rawText, complete, 'The complete raw markdown remains available for re-rendering')
  assert.equal(row.dataset.rendered, undefined, 'The partial render is invalidated')
  assert.equal(row.dataset.state, 'running')
  assert.equal(row.querySelectorAll('.actions').length, 0, 'The obsolete partial-answer toolbar is removed')

  await state.renderSettledAnswers()
  assert.deepEqual(state.requests, [complete], 'The renderer receives the complete markdown source')
  assert.equal(row.innerHTML, html)
  assert.equal(row.dataset.rendered, 'true')
  assert.equal(row.dataset.rawText, complete)
  assert.equal(row.dataset.copyText, visible, 'Copy uses the complete rendered answer rather than its markdown source')
  assert.equal(row.querySelectorAll('.actions').length, 1, 'Final rendering creates exactly one toolbar')
  assert.equal(row.querySelectorAll('button').length, 1)
  await row.querySelector('button')!.onclick!()
  assert.deepEqual(state.copies, [visible], 'The actual copy action writes the complete answer')

  await state.renderSettledAnswers()
  assert.deepEqual(state.requests, [complete], 'Repeated settlement does not render the same answer again')
  assert.equal(row.querySelectorAll('.actions').length, 1, 'Repeated settlement does not duplicate the toolbar')
})
