import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** #84 part2: synthetic actual-function regressions for bounded user-text surfaces.
 * Execute actual page/menu functions with synthetic credentials, not another scanner or renderer.
 * This is bounded input presentation, not whole-screen/log/transport redaction.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
const surfacePage = process.env.HEDDLE_TEST_SURFACES_PAGE ? readFileSync(process.env.HEDDLE_TEST_SURFACES_PAGE, 'utf8') : page
const menu = readFileSync(process.env.HEDDLE_TEST_MENU ?? join(import.meta.dirname, '..', 'src/commands/menu.js'), 'utf8')
/** The page's English table (#80), so a lifted function that draws its words through t() shows them as the page does. */
const ENGLISH: Record<string, string> = (() => {
  const start = page.indexOf('  en: Object.freeze({')
  const table: Record<string, string> = {}
  if (start < 0) return table
  const end = page.indexOf('\n  }),', start)
  for (const match of page.slice(start, end).matchAll(/^\s+'([^']+)': '((?:[^'\\]|\\.)*)',$/gm)) table[match[1]!] = match[2]!.replace(/\\'/g, "'")
  return table
})()
function englishT(key: string, vars: Record<string, unknown> = {}): string {
  return (ENGLISH[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
const fakeKey = 'sk-' + 'FakeFixture'.repeat(3) + '1'
const otherKey = fakeKey.slice(0, -1) + '2'
const maskedKey = fakeKey.slice(0, 8) + '*'.repeat(fakeKey.length - 8)

function sourceFunction(source: string, name: string, indent = ''): string {
  const marker = `${indent}function ${name}(`
  const asyncMarker = `${indent}async function ${name}(`
  let start = source.indexOf(asyncMarker)
  if (start < 0) start = source.indexOf(marker)
  assert.ok(start >= 0, 'actual source defines ' + name)
  const end = source.indexOf(`\n${indent}}\n`, start)
  assert.ok(end > start, 'actual source ends ' + name)
  return source.slice(start, end + indent.length + 2).replace(/^export /, '')
}

class Node {
  className = ''
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Node[] = []
  parentElement: Node | null = null
  ownText = ''
  title = ''
  value = ''
  oninput?: () => void
  onclick?: () => void
  type = ''
  disabled = false
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  get isConnected(): boolean { return this.parentElement !== null }
  get nextElementSibling(): Node | null {
    const siblings = this.parentElement?.children ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  get textContent(): string { return this.ownText + this.children.map(n => n.textContent).join('') }
  set textContent(text: string) { this.replaceChildren(); this.ownText = String(text) }
  set innerHTML(_text: string) { throw new Error('user text must not enter an HTML parser') }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node) } }
  replaceChildren(...nodes: Node[]) {
    for (const child of this.children) child.parentElement = null
    this.children = []; this.ownText = ''; this.append(...nodes)
  }
  before(node: Node) {
    const parent = this.parentElement!
    if (node.parentElement) {
      const siblings = node.parentElement.children
      siblings.splice(siblings.indexOf(node), 1)
    }
    parent.children.splice(parent.children.indexOf(this), 0, node)
    node.parentElement = parent
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  all(): Node[] { return this.children.flatMap(node => [node, ...node.all()]) }
  querySelector(selector: string): Node | null {
    return this.all().find(node => node.className.split(' ').includes(selector.slice(1))) ?? null
  }
}
interface QueueItem { id: string; status: string; text: string; attachments?: unknown[] }
interface Event { type: string; commandId: string; name: string; args?: string; text?: string; kind?: string }
interface Harness {
  mask(text: string): string
  queue(item: QueueItem): Node
  edit(value: { id: string; text: string } | null): void
  editing(): { id: string; text: string } | null
  bubble(args: string): Node
  draw(event: Event): void
  history(turn: { commandId: string; name: string; args?: string; state: string; text?: string }): void
  remount(): void
  row: Node
  root: Node
  steer(text: string): Promise<boolean>
  requests: string[]
}
function harness(): Harness {
  const begin = page.indexOf('/* user-secrets:begin */')
  const end = page.indexOf('/* user-secrets:end */')
  assert.ok(begin >= 0 && end > begin)
  const root = new Node('div')
  const row = new Node('div')
  row.className = 'hc-command'; row.dataset.commandId = 'synthetic-command'
  const args = new Node('span'); args.className = 'hc-args'
  const state = new Node('span'); state.className = 'hc-state'
  const result = new Node('div'); result.className = 'hc-text'
  row.append(args, state, result); root.append(row)
  const requests: string[] = []
  return runInNewContext(`
    ${page.slice(begin, end)}
    const QUEUE_PREVIEW_CHARS = 200
    let editing = null
    function renderQueue() {}
    function copiedIcon() { return document.createElement('svg') }
    function closeIcon() { return document.createElement('svg') }
    function sendIcon() { return document.createElement('svg') }
    function editIcon() { return document.createElement('svg') }
    function steerItem() {}
    function removeItem() {}
    ${sourceFunction(page, 'queueActions')}
    function queueAttachmentStrip() { return document.createElement('aside') }
    ${sourceFunction(page, 'queuePreview')}
    ${sourceFunction(surfacePage, 'queueRow')}
    ${sourceFunction(menu, 'commandInputText').replace(/^export /, '')}
    ${menu.match(/^  const inputTextByBody = new WeakMap\(\)$/m)?.[0] ?? ''}
    const api = { maskUserText }
    const INPUT_BUBBLE_COMMANDS = new Set(['goal'])
    function rowFor() { return row }
    ${sourceFunction(menu, 'bubbleFor', '  ')}
    ${sourceFunction(menu, 'draw', '  ')}
    ${sourceFunction(menu, 'drawTurn', '  ')}
    const composerKey = 'synthetic-session'
    const QUEUE_KEY_NONE = 'none'
    function add() { throw new Error('unexpected steer refusal') }
    ${sourceFunction(page, 'steerNow')}
    ({ row, root, requests,
      mask: maskUserText,
      queue: queueRow,
      edit: (value) => { editing = value },
      editing: () => editing,
      bubble: (args) => bubbleFor(row, 'synthetic-command', 'goal', args),
      draw,
      history: drawTurn,
      remount: () => { root.replaceChildren(row) },
      steer: steerNow,
    })
  `, {
    root, row, requests, t: englishT,
    fetch: async (_url: string, options: { body: string }) => { requests.push(options.body); return { ok: true } },
    document: {
      createElement: (tag: string) => new Node(tag),
      createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node },
      querySelectorAll: (selector: string) => root.all().filter(node => selector === '[data-command-input]' ? 'commandInput' in node.dataset : selector === '.hc-command' && node.className === 'hc-command'),
    },
  }) as Harness
}
function assertNoRawAttributes(node: Node) {
  for (const element of [node, ...node.all()]) {
    for (const value of [element.title, ...Object.values(element.dataset), ...Object.values(element.attributes)]) {
      assert.ok(!value.includes(fakeKey) && !value.includes(otherKey), 'no new raw DOM attribute')
    }
  }
}

test('shared full-text projection preserves plain text, whitespace and repeated synthetic occurrences', () => {
  const h = harness()
  assert.equal(h.mask('plain password=ordinary\nword'), 'plain password=ordinary\nword')
  assert.equal(h.mask(`start ${fakeKey}\n${fakeKey} end`), `start ${maskedKey}\n${maskedKey} end`)
  assert.equal(h.mask(''), '')
})

test('actual queueRow masks full input before 200-code-point truncation and title', () => {
  const h = harness()
  // A credential starts just before the cut and has not reached scanner minimum at the cut.
  const prefix = '😀'.repeat(185) + ' '
  const item = { id: 'fake-queue', status: 'pending', text: prefix + fakeKey }
  const row = h.queue(item)
  const preview = row.querySelector('.preview')!
  const masked = prefix + maskedKey
  assert.equal(preview.textContent, Array.from(masked).slice(0, 200).join('') + '…')
  assert.equal(preview.title, masked)
  assert.equal(item.text, prefix + fakeKey, 'queue-owned original is unchanged')
  assertNoRawAttributes(row)
})

test('actual pending, sending and failed queue rows all use noninteractive masks', () => {
  const h = harness()
  for (const status of ['pending', 'sending', 'failed']) {
    const row = h.queue({ id: 'fake-' + status, status, text: fakeKey })
    assert.equal(row.querySelector('.preview')!.textContent, maskedKey)
    assert.equal(row.querySelector('.preview')!.title, maskedKey)
    assert.equal(row.all().filter(node => node.className === 'user-secret-toggle').length, 0)
    assertNoRawAttributes(row)
  }
})

test('actual queue editor keeps raw value/oninput and returning to preview masks again', () => {
  const h = harness()
  const item = { id: 'fake-edit', status: 'pending', text: fakeKey }
  h.edit({ id: item.id, text: item.text })
  const editingRow = h.queue(item)
  const editor = editingRow.querySelector('.editor')!
  assert.equal(editor.value, fakeKey)
  editor.value = otherKey; editor.oninput!()
  assert.equal(h.editing()!.text, otherKey)
  assert.equal(item.text, fakeKey, 'draft edit does not mutate queued original')
  editingRow.all().find(node => node.title === 'Cancel edit')!.onclick!()
  assert.equal(h.editing(), null)
  assert.equal(item.text, fakeKey, 'actual Cancel retains original')
  assert.equal(h.queue(item).querySelector('.preview')!.title, maskedKey)
  h.edit({ id: item.id, text: ' ' + otherKey + ' ' })
  h.queue(item).all().find(node => node.title === 'Save queued message')!.onclick!()
  assert.equal(item.text, otherKey, 'actual Save retains unmasked edited original')
  assert.equal(h.editing(), null)
  assert.equal(h.queue(item).querySelector('.preview')!.title, maskedKey)
})

test('actual goal bubble masks remainder, preserves static chip and uses original WeakMap identity', () => {
  const h = harness()
  const bubble = h.bubble(' ' + fakeKey)
  const body = bubble.querySelector('.hc-input-bubble')!
  const chip = body.querySelector('.hc-chip')!
  assert.equal(body.textContent, '/goal ' + maskedKey)
  assert.equal(chip.title, '/goal')
  assert.equal(chip.dataset.command, 'goal')
  assert.equal(h.bubble(' ' + fakeKey).querySelector('.hc-chip'), chip, 'same raw event preserves chip identity')
  const changed = h.bubble(' ' + otherKey).querySelector('.hc-chip')!
  assert.notEqual(changed, chip, 'different raw with identical mask still invalidates')
  assert.equal(body.textContent, '/goal ' + maskedKey)
  assertNoRawAttributes(bubble)
  h.remount()
  const remounted = h.bubble(' ' + otherKey)
  assert.notEqual(remounted.querySelector('.hc-chip'), changed, 'new body starts fresh')
  assert.equal(remounted.textContent, '/goal ' + maskedKey)
})

test('actual command draw masks goal-only args and input but leaves other args/results unchanged', () => {
  const h = harness()
  const event = { type: 'command/run', commandId: 'synthetic-command', name: 'goal', args: ' ' + fakeKey + '  ' }
  h.draw(event)
  assert.equal(h.row.querySelector('.hc-args')!.textContent, maskedKey)
  assert.equal(h.root.querySelector('.hc-input-bubble')!.textContent, '/goal ' + maskedKey)
  assert.equal(event.args, ' ' + fakeKey + '  ', 'recorded input is not rewritten')
  h.draw({ ...event, name: 'other' })
  assert.equal(h.row.querySelector('.hc-args')!.textContent, fakeKey, 'other command scope unchanged')
  h.draw({ type: 'command/done', commandId: event.commandId, name: 'goal', text: fakeKey })
  assert.equal(h.row.querySelector('.hc-text')!.textContent, fakeKey, 'goal result remains explicitly outside scope')
})

test('actual history draw rebuilds masked goal input and ignores removed placeholders', () => {
  const h = harness()
  const turn = { commandId: 'synthetic-command', name: 'goal', args: ' ' + fakeKey, state: 'done', text: 'Goal created' }
  h.history(turn)
  assert.equal(h.root.querySelector('.hc-input-bubble')!.textContent, '/goal ' + maskedKey)
  assert.equal(h.row.querySelector('.hc-args')!.textContent, maskedKey)
  h.root.replaceChildren()
  h.history(turn)
  assert.equal(h.root.children.length, 0, 'removed session placeholder must not recreate a row')
})

test('actual steering request retains original synthetic provider-facing text', async () => {
  const h = harness()
  assert.equal(await h.steer('use ' + fakeKey), true)
  assert.equal(JSON.parse(h.requests[0]!).prompt, 'use ' + fakeKey)
})
