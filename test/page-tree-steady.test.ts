import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * #143, run out of the page: its own `renderTree`, `loadChildren`, `nodeRow`, `paintSessionRows`, `markSelection` and
 * what they call, over its own workspace-tree block, with a stand-in DOM (a small selector engine included) and a network
 * the test answers request by request, so it can look at the tree on the page while a refresh's reads are out.
 *
 * The bug (found by developer-ten, measured by developer-six): every refresh — after each message, answer and turn end,
 * any session's — replaced the rows with every group folded, then opened each remembered group one after another, a
 * `GET /api/tree` apiece, and marked the selection last. For 40 ms to over a second the open workspaces' session rows and
 * the selected row were gone and the rows below moved up, so a click aimed at a session landed on another row in 4 of 7
 * tries. DSH's tree is a keyed React list (dsh-client-ui-workspace `lib/client.js:3307`, `:3328`) whose expansion is state
 * (`:1284-1286`, derived at `:3061-3068`), so a refresh updates rows in place and `aria-selected` (`:2257`, `:2278`)
 * never leaves the open session.
 *
 * Expected: the new tree is drawn off the page with its open groups' levels read at once, the selection marked in it, and
 * it goes in once; a row that stays keeps its element; an older drawing never lands over a newer one; a level whose read
 * fails draws its failure line in the new tree.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = (name: string): string => {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin > 0 && end > begin, `the page has its ${name} block`)
  return page.slice(begin, end)
}

/** A top-level function of the page, by name: from its line to the first line that closes it. */
function source(name: string): string {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

/** The same function when the page has it, else nothing: a name this fix adds, which the red run predates. */
function optional(name: string): string {
  return page.search(new RegExp(`\\n(?:async )?function ${name}\\(`)) >= 0 ? source(name) : ''
}

/** A one-line top-level `const` of the page, else nothing. */
function constant(name: string): string {
  return new RegExp(`\\nconst ${name} = [^\\n]*\\n`).exec(page)?.[0] ?? ''
}

/** The page's folded-groups memory (`COLLAPSED_KEY` and `collapsed`). */
function collapsedMemory(): string {
  const start = page.indexOf('\nconst COLLAPSED_KEY = ')
  if (start < 0) return 'const collapsed = new Set()'
  return page.slice(start + 1, page.indexOf('\n})()\n', start) + 5)
}

const REQUIRED = [
  'readExpanded',
  'rememberExpanded',
  'archiveQuery',
  'nodeRow',
  'groupRow',
  'sessionRow',
  'sessionNode',
  'paintSessionRows',
  'resetWatermarks',
  'watermarkFacts',
  'loadChildren',
  'toggle',
  'reopenChildGroups',
  'markSelection',
  'chooseSelected',
  'syncSelectionToSession',
  'folderRows',
  'learnDefinition',
  'failedLevel',
  'failedLevelLine',
  'paintGoneFolder',
  'clearDropMarks',
  'wireSessionDrag',
  'wireWorkspaceDrag',
  'treeFocus',
  'treeTools',
  'restoreTreeFocus',
  'menuButton',
  'menuItemsFor',
  'placeKeyed',
  'renderTree',
]
/** What this fix adds; absent on the page before it. */
const ADDED = [
  'paintDisclosure',
  'newestTreeDrawn',
  'treeDrawn',
  'treeOpening',
  'sameMembers',
  'watermarkState',
  'openOffPage',
  'openRowOffPage',
  'repaintSessionRowsOffPage',
  'treeItemKey',
  'treeItemSignature',
  'placeTree',
  'adoptTreeItem',
  'indexDrawnRows',
]

/** A stand-in DOM: elements with attributes, a dataset, children, focus, and the selectors the tree code uses. */
const DOM = String.raw`
const parsedSelectors = new Map()
function splitTop(text, separator) {
  const parts = []
  let depth = 0, quote = null, from = 0
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at]
    if (quote !== null) { if (ch === '\\') at += 1; else if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    else if (ch === separator && depth === 0) { parts.push(text.slice(from, at)); from = at + 1 }
  }
  parts.push(text.slice(from))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}
function parseCompound(text) {
  const compound = { scope: false, tag: null, classes: [], attrs: [], nots: [], focusVisible: false }
  let rest = text
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest)
  if (tag !== null) { if (tag[1] !== '*') compound.tag = tag[1].toUpperCase(); rest = rest.slice(tag[0].length) }
  while (rest.length > 0) {
    let match
    if ((match = /^\.([\w-]+)/.exec(rest)) !== null) compound.classes.push(match[1])
    else if ((match = /^\[([\w-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|([^\]]*)))?\]/.exec(rest)) !== null) {
      const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]
      compound.attrs.push({ name: match[1], value })
    } else if ((match = /^:scope/.exec(rest)) !== null) compound.scope = true
    else if ((match = /^:focus-visible/.exec(rest)) !== null) compound.focusVisible = true
    else if ((match = /^:not\(/.exec(rest)) !== null) {
      let depth = 1, at = match[0].length
      for (; at < rest.length && depth > 0; at += 1) { if (rest[at] === '(') depth += 1; else if (rest[at] === ')') depth -= 1 }
      compound.nots.push(parseCompound(rest.slice(match[0].length, at - 1)))
      match = [rest.slice(0, at)]
    } else throw new Error('the stand-in DOM cannot read the selector part ' + JSON.stringify(rest))
    rest = rest.slice(match[0].length)
  }
  return compound
}
function parseComplex(text) {
  const steps = []
  let at = 0, combinator = null
  while (at < text.length) {
    let spaced = false
    while (at < text.length && /\s/.test(text[at])) { at += 1; spaced = true }
    if (at >= text.length) break
    if (text[at] === '>') { combinator = '>'; at += 1; continue }
    if (spaced && steps.length > 0 && combinator === null) combinator = ' '
    let end = at, depth = 0, quote = null
    for (; end < text.length; end += 1) {
      const ch = text[end]
      if (quote !== null) { if (ch === '\\') end += 1; else if (ch === quote) quote = null; continue }
      if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth += 1
      else if (ch === ')' || ch === ']') depth -= 1
      else if (depth === 0 && (/\s/.test(ch) || ch === '>')) break
    }
    steps.push({ combinator: steps.length === 0 ? null : combinator ?? ' ', compound: parseCompound(text.slice(at, end)) })
    combinator = null
    at = end
  }
  return steps
}
function parseSelector(text) {
  if (!parsedSelectors.has(text)) parsedSelectors.set(text, splitTop(text, ',').map(parseComplex))
  return parsedSelectors.get(text)
}
function matchesCompound(element, compound, scope) {
  if (compound.scope && element !== scope) return false
  if (compound.tag !== null && element.tagName !== compound.tag) return false
  for (const name of compound.classes) if (!element.classList.contains(name)) return false
  for (const { name, value } of compound.attrs) {
    if (!element.hasAttribute(name)) return false
    if (value !== undefined && element.getAttribute(name) !== value) return false
  }
  for (const not of compound.nots) if (matchesCompound(element, not, scope)) return false
  if (compound.focusVisible && element.ownerDocument.activeElement !== element) return false
  return true
}
function matchesSteps(element, steps, index, scope) {
  if (!matchesCompound(element, steps[index].compound, scope)) return false
  if (index === 0) return true
  if (steps[index].combinator === '>') return element.parentElement !== null && matchesSteps(element.parentElement, steps, index - 1, scope)
  for (let above = element.parentElement; above !== null; above = above.parentElement) if (matchesSteps(above, steps, index - 1, scope)) return true
  return false
}
function matchesSelector(element, text, scope) {
  return parseSelector(text).some((steps) => matchesSteps(element, steps, steps.length - 1, scope))
}

const camelToData = (name) => 'data-' + name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = ownerDocument
    this.childList = []
    this.parentNode = null
    this.attributeMap = new Map()
    this.listeners = new Map()
    this.ownText = ''
    this.styleMap = new Map()
    const element = this
    this.dataset = new Proxy({}, {
      get: (_, name) => typeof name === 'string' && element.attributeMap.has(camelToData(name)) ? element.attributeMap.get(camelToData(name)) : undefined,
      set: (_, name, value) => { element.attributeMap.set(camelToData(name), String(value)); return true },
      deleteProperty: (_, name) => { element.attributeMap.delete(camelToData(name)); return true },
      has: (_, name) => element.attributeMap.has(camelToData(name)),
    })
    this.style = {
      setProperty: (name, value) => { element.styleMap.set(name, String(value)); element.writeStyle() },
      getPropertyValue: (name) => element.styleMap.get(name) ?? '',
      removeProperty: (name) => { element.styleMap.delete(name); element.writeStyle() },
    }
    this.classList = {
      contains: (name) => element.className.split(/\s+/).includes(name),
      add: (...names) => { element.className = [...new Set([...element.className.split(/\s+/), ...names])].filter(Boolean).join(' ') },
      remove: (...names) => { element.className = element.className.split(/\s+/).filter((each) => each && !names.includes(each)).join(' ') },
      toggle: (name, force) => { const on = force ?? !element.classList.contains(name); if (on) element.classList.add(name); else element.classList.remove(name); return on },
    }
    this.onclick = null
    this.onkeydown = null
  }
  writeStyle() {
    if (this.styleMap.size === 0) this.attributeMap.delete('style')
    else this.attributeMap.set('style', [...this.styleMap].map(([name, value]) => name + ': ' + value + ';').join(' '))
  }
  get attributes() { return [...this.attributeMap].map(([name, value]) => ({ name, value })) }
  setAttribute(name, value) { this.attributeMap.set(name, String(value)) }
  getAttribute(name) { return this.attributeMap.has(name) ? this.attributeMap.get(name) : null }
  hasAttribute(name) { return this.attributeMap.has(name) }
  removeAttribute(name) { this.attributeMap.delete(name) }
  get className() { return this.attributeMap.get('class') ?? '' }
  set className(value) { this.attributeMap.set('class', String(value)) }
  get id() { return this.attributeMap.get('id') ?? '' }
  set id(value) { this.attributeMap.set('id', String(value)) }
  get title() { return this.attributeMap.get('title') ?? '' }
  set title(value) { this.attributeMap.set('title', String(value)) }
  get type() { return this.attributeMap.get('type') ?? '' }
  set type(value) { this.attributeMap.set('type', String(value)) }
  get hidden() { return this.attributeMap.has('hidden') }
  set hidden(value) { if (value) this.attributeMap.set('hidden', ''); else this.attributeMap.delete('hidden') }
  get draggable() { return this.attributeMap.get('draggable') === 'true' }
  set draggable(value) { this.attributeMap.set('draggable', String(Boolean(value))) }
  get tabIndex() { return Number(this.attributeMap.get('tabindex') ?? -1) }
  set tabIndex(value) { this.attributeMap.set('tabindex', String(value)) }
  get children() { return [...this.childList] }
  get parentElement() { return this.parentNode }
  get firstChild() { return this.childList[0] ?? null }
  get firstElementChild() { return this.childList[0] ?? null }
  get nextSibling() { return this.parentNode === null ? null : (this.parentNode.childList[this.parentNode.childList.indexOf(this) + 1] ?? null) }
  get nextElementSibling() { return this.nextSibling }
  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === this.ownerDocument.documentElement
  }
  get textContent() { return this.childList.length === 0 ? this.ownText : this.childList.map((child) => child.textContent).join('') }
  set textContent(value) { for (const child of [...this.childList]) child.remove(); this.ownText = String(value ?? '') }
  contains(node) {
    for (let at = node; at !== null && at !== undefined; at = at.parentNode) if (at === this) return true
    return false
  }
  remove() {
    if (this.parentNode === null) return
    const document = this.ownerDocument
    /** A focused element taken out of the page loses focus, as a browser's focus fixup does. */
    if (document.activeElement !== document.body && this.contains(document.activeElement)) document.activeElement = document.body
    this.parentNode.childList.splice(this.parentNode.childList.indexOf(this), 1)
    this.parentNode = null
    this.ownerDocument.mutations += 1
  }
  insertBefore(node, reference) {
    if (typeof node !== 'object') throw new Error('the stand-in DOM takes elements only')
    /** A browser refuses to put an element inside itself (HierarchyRequestError). */
    if (node.contains(this)) throw new Error('HierarchyRequestError: the new child contains the parent')
    node.remove()
    const at = reference === null || reference === undefined ? -1 : this.childList.indexOf(reference)
    if (at === -1) this.childList.push(node)
    else this.childList.splice(at, 0, node)
    node.parentNode = this
    this.ownerDocument.mutations += 1
    return node
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null) }
  prepend(...nodes) { const first = this.firstChild; for (const node of nodes) this.insertBefore(node, first) }
  after(...nodes) { const parent = this.parentNode; const next = this.nextSibling; for (const node of nodes) parent.insertBefore(node, next) }
  replaceChildren(...nodes) { for (const child of [...this.childList]) child.remove(); this.append(...nodes) }
  descendants() { const all = []; const walk = (node) => { for (const child of node.childList) { all.push(child); walk(child) } }; walk(this); return all }
  matches(selector) { return matchesSelector(this, selector, null) }
  closest(selector) { for (let node = this; node !== null; node = node.parentNode) if (node.matches(selector)) return node; return null }
  querySelectorAll(selector) { return this.descendants().filter((node) => matchesSelector(node, selector, this)) }
  querySelector(selector) { return this.descendants().find((node) => matchesSelector(node, selector, this)) ?? null }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener) }
  removeEventListener() {}
  focus() { this.ownerDocument.activeElement = this }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  getAnimations() { return [] }
  animate() { return { finished: Promise.resolve() } }
  scrollIntoView() {}
}
const document = {
  mutations: 0,
  createElement: (tag) => new FakeElement(tag, document),
  createElementNS: (_, tag) => new FakeElement(tag, document),
}
document.documentElement = new FakeElement('html', document)
document.body = new FakeElement('body', document)
document.documentElement.append(document.body)
document.activeElement = document.body
const HTMLElement = FakeElement
const CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') }
`

const EXPANDED = 'heddle.tree.expanded.v1'

const workspace = (id: string, path: string, sessionIds: string[], parent: string | null = null) => ({
  id,
  path,
  title: path.split('/').pop(),
  origin: 'added',
  parent,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  sessionIds,
  status: 'ok',
})
const session = (id: string, cwd: string, minute: number, title = id) => {
  const at = `2026-10-31T17:${String(minute).padStart(2, '0')}:00.000Z`
  return { id, cwd, title, created: at, updated: at, turns: 1 }
}
const folder = (path: string) => ({ kind: 'folder', path, label: path.split('/').pop(), badge: null, session: null, children: null })
const file = (path: string) => ({ kind: 'file', path, label: path.split('/').pop(), badge: null, session: null, children: null })

/** `/w/b` is the first group the page opens, `/w/a` holds the open session `s-a2`, and its `docs` folder was left open. */
const A = '/w/a'
const B = '/w/b'
const DOCS = '/w/a/docs'
function world() {
  return {
    workspaces: [workspace('ws-a', A, ['s-a1', 's-a2', 's-a3']), workspace('ws-b', B, ['s-b1'])],
    sessions: [session('s-a1', A, 3), session('s-a2', A, 2), session('s-a3', A, 1), session('s-b1', B, 4)],
    trees: {
      [A]: { status: 200, body: { children: [folder(DOCS), file('/w/a/readme.md')] } },
      [B]: { status: 200, body: { children: [file('/w/b/notes.txt')] } },
      [DOCS]: { status: 200, body: { children: [file('/w/a/docs/plan.md')] } },
    } as Record<string, { status: number; body: unknown }>,
  }
}
type World = ReturnType<typeof world>

interface Row {
  key: string
  li: object
  selected: string | null
  open: string | undefined
  label: string
}
interface Page {
  render(): Promise<unknown>
  rows(): Row[]
  pending(): string[]
  hold(on: boolean): void
  releaseFirst(): boolean
  focus(key: string): void
  stamp(key: string): string | null
  more(path: string): object | null
  pressMore(path: string): void
  active(): object
  fold(path: string): Promise<unknown>
  level(path: string): { headings: string[]; lines: { text: string; code: string | null }[]; rows: string[] } | null
  notes: string[]
}

/** One page over `data`, the open session `s-a2`, with `expanded` remembered open. */
function load(data: World, expandedPaths: string[]): Page {
  const functions = [...REQUIRED.map(source), ...ADDED.map(optional)].join('\n')
  return runInNewContext(
    `
    ${DOM}
    ${block('workspace-tree')}
    ${block('workspace-folder')}
    let current = 's-a2'
    let groupingMode = 'tree'
    const archiveMode = 'hide'
    let orderState = WorkspaceTree.readOrder(null)
    let treeGroups = []
    let treeTops = []
    let knownWorkspaces = []
    let listedSessions = new Set()
    let childSessions = []
    let shownOrders = {}
    let selectedPath = null
    let activeFolder = null
    let heldTreeFocus = null
    let workspaceRoutes = 'unknown'
    let chosenWorkspace = null
    let sessionDragging = null
    let workspaceDragging = null
    let treeGeneration = 0
    let treeLanded = 0
    let treeWaiters = []
    const NEW_CONVERSATION_NOTE = 'a new conversation in '
    const EXPANDED_KEY = ${JSON.stringify(EXPANDED)}
    const stored = { [EXPANDED_KEY]: JSON.stringify(EXPANDED_PATHS) }
    const localStorage = { getItem: (key) => (key in stored ? stored[key] : null), setItem: (key, value) => { stored[key] = String(value) } }
    const watermarks = new Map()
    const definitionOf = new Map()
    const runningSessions = new Set()
    const pendingInteractions = new Map()
    const unreadSessions = new Set()
    const rowIndex = new Map()
    const rowEntries = new WeakMap()
    const levelsLoading = new WeakSet()
    const SessionIdCopy = { TEXT: { menu: 'Copy session ID' } }
    ${constant('TREE_VOLATILE_ATTRIBUTES')}
    const treeList = document.createElement('ul')
    treeList.id = 'tree'
    document.body.append(treeList)
    const notes = []
    const setNote = (text) => { notes.push(text) }
    const kindIcon = (kind, open = false) => { const icon = document.createElement('svg'); icon.setAttribute('data-icon', kind + (open ? ':open' : '')); return icon }
    const relativeAge = () => '1d'
    const titleMarquee = () => ({ enter() {}, leave() {} })
    const sessionRowStatus = () => ({ state: 'idle', label: 'Idle' })
    const paintRowStatus = () => {}
    const paintRunningMarks = () => {}
    const paintScheduleMarks = () => {}
    const paintConversationTarget = () => {}
    const paintNewConversationPlace = () => {}
    const forgetRemovedWorkspace = () => {}
    const noteSessions = () => {}
    const paintEmptyList = () => {}
    const newConversationTarget = () => null
    const applySearch = () => {}
    const renderFlatList = async () => {}
    ${functions}
    const expanded = readExpanded()
    ${collapsedMemory()}
    const held = []
    let holding = false
    const respond = (url) => {
      const path = url.startsWith('/api/tree?path=') ? decodeURIComponent(url.slice('/api/tree?path='.length)) : null
      const reply =
        url === '/api/workspaces' ? { status: 200, body: { workspaces: DATA.workspaces } }
        : url === '/api/sessions' ? { status: 200, body: DATA.sessions }
        : path !== null && path in DATA.trees ? DATA.trees[path]
        : { status: 404, body: { error: 'no route ' + url } }
      const body = JSON.parse(JSON.stringify(reply.body))
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => body }
    }
    /** Each answer is what the server held when it was asked; a held one arrives when the test lets it go. */
    const fetch = (url) => {
      const answer = respond(url)
      if (!holding) return Promise.resolve(answer)
      return new Promise((resolve) => held.push({ url, resolve: () => resolve(answer) }))
    }
    const rowLi = (key) => treeList.querySelector('li[data-row-key="' + CSS.escape(key) + '"]')
    ;({
      render: () => renderTree(),
      rows: () => treeList.querySelectorAll('li[role="treeitem"]').map((li) => ({
        key: li.dataset.rowKey,
        li,
        selected: li.getAttribute('aria-selected'),
        open: li.dataset.open,
        label: li.querySelector(':scope > .row > .label')?.textContent ?? '',
      })),
      pending: () => held.map((entry) => entry.url),
      hold: (on) => { holding = on },
      releaseFirst: () => { const next = held.shift(); if (next === undefined) return false; next.resolve(); return true },
      focus: (key) => rowLi(key).focus(),
      more: (path) => rowLi('node:' + path)?.querySelector(':scope > ul[role="group"] > li[data-slot="more"]') ?? null,
      pressMore: (path) => { const button = rowLi('node:' + path).querySelector(':scope > ul[role="group"] > li[data-slot="more"] > button'); button.onclick({ currentTarget: button }) },
      stamp: (key) => rowLi(key)?.querySelector(':scope > .row > .row-right > .age')?.dataset.stamp ?? null,
      active: () => document.activeElement,
      fold: (path) => { const li = rowLi('node:' + path); const entry = rowEntries.get(li) ?? rowIndex.get(path); return toggle(entry.node, li) },
      level: (path) => {
        const li = rowLi('node:' + path)
        const list = li?.querySelector(':scope > ul[role="group"]') ?? null
        if (list === null) return null
        return {
          headings: list.querySelectorAll(':scope > .tree-heading').map((heading) => heading.textContent),
          lines: list.querySelectorAll(':scope > .empty').map((line) => ({ text: line.textContent, code: line.dataset.filesCode ?? null })),
          rows: list.querySelectorAll(':scope > li[role="treeitem"]').map((row) => row.dataset.rowKey),
        }
      },
      notes,
    })
    `,
    {
      DATA: data,
      EXPANDED_PATHS: expandedPaths,
      JSON,
      Promise,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Proxy,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      Math,
      Error,
      RegExp,
      Symbol,
      Intl,
      encodeURIComponent,
      decodeURIComponent,
      queueMicrotask,
      console,
    },
  ) as Page
}

/** A value made in the page's context, copied into this realm: deepEqual compares prototypes, which differ across realms. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Every microtask the page has queued, run: what it does between two answers arriving. */
const settle = () => new Promise((done) => setImmediate(done))

const SESSIONS_OF_A = ['session:s-a1', 'session:s-a2', 'session:s-a3']
const describe = (rows: Row[]) => rows.map((row) => `${row.key}${row.open === 'true' ? '(open)' : ''}${row.selected === 'true' ? '*' : ''}`).join(' ')

/**
 * Let the held requests go one at a time until the drawing has landed, calling `sample` before the first and after each:
 * every state of the tree a person could see while the refresh's reads are out.
 */
async function stepThrough(view: Page, drawing: Promise<unknown>, sample: (moment: string) => void): Promise<void> {
  let landed = false
  void drawing.then(() => {
    landed = true
  })
  await settle()
  sample('as the refresh starts')
  for (let step = 0; step < 50; step += 1) {
    const next = view.pending()[0]
    if (next === undefined) {
      await settle()
      if (landed) break
      continue
    }
    view.releaseFirst()
    await settle()
    sample(`after ${next} answered`)
  }
  await drawing
  sample('once the refresh has landed')
}

test('a refresh keeps the open group\'s session rows and the selected row on the page while its reads are out, and keeps every row\'s element and order when nothing changed (#143)', async () => {
  const view = load(world(), [B, A, DOCS])
  await view.render()
  const before = view.rows()
  assert.deepEqual(
    plain(before.filter((row) => SESSIONS_OF_A.includes(row.key)).map((row) => [row.key, row.selected])),
    [
      ['session:s-a1', 'false'],
      ['session:s-a2', 'true'],
      ['session:s-a3', 'false'],
    ],
    `the first drawing shows A's sessions with the open one selected\nsaw: ${describe(before)}`,
  )
  assert.ok(before.some((row) => row.key === 'node:/w/a/docs/plan.md'), `and the remembered folder open\nsaw: ${describe(before)}`)

  view.hold(true)
  const failures: string[] = []
  await stepThrough(view, view.render(), (moment) => {
    const now = view.rows()
    const missing = SESSIONS_OF_A.filter((key) => !now.some((row) => row.key === key))
    const selected = now.filter((row) => row.selected === 'true').map((row) => row.key)
    const moved = now.length !== before.length || now.some((row, index) => row.key !== before[index]?.key || row.li !== before[index]?.li)
    if (missing.length > 0 || selected.join() !== 'session:s-a2' || moved) {
      failures.push(`${moment}: ${missing.length > 0 ? `missing ${missing.join(', ')}; ` : ''}selected [${selected.join(', ')}]${moved ? '; rows changed or moved' : ''}\n  ${describe(now)}`)
    }
  })
  assert.deepEqual(failures, [], `during a refresh with nothing changed, A's session rows and the selected row stay, each row the same element in the same place\nbefore: ${describe(before)}`)
})

test('the open groups\' levels are read at once, not one after another', async () => {
  const view = load(world(), [B, A])
  await view.render()
  view.hold(true)
  const drawing = view.render()
  await settle()
  assert.deepEqual(plain(view.pending()).sort(), ['/api/sessions', '/api/workspaces'], 'the two lists are read first')
  view.releaseFirst()
  view.releaseFirst()
  await settle()
  assert.deepEqual(plain(view.pending()).sort(), ['/api/tree?path=%2Fw%2Fa', '/api/tree?path=%2Fw%2Fb'], 'then both open workspaces\' folders, together')
  view.hold(false)
  while (view.releaseFirst()) await settle()
  await drawing
})

test('a row that changed is drawn anew and every other row keeps its element', async () => {
  const data = world()
  const view = load(data, [B, A])
  await view.render()
  const before = new Map(view.rows().map((row) => [row.key, row.li]))
  data.sessions = data.sessions.map((meta) => (meta.id === 's-a3' ? { ...meta, title: 'renamed elsewhere' } : meta))
  await view.render()
  const after = view.rows()
  const renamed = after.find((row) => row.key === 'session:s-a3')
  assert.equal(renamed?.label, 'renamed elsewhere', `the renamed row reads its new title\nsaw: ${describe(after)}`)
  /** Elements are compared as a yes or no: a failed equality of two stand-in elements would print the whole stand-in DOM. */
  assert.ok(renamed !== undefined && renamed.li !== before.get('session:s-a3'), 'drawn as a new row')
  const kept = after.filter((row) => row.key !== 'session:s-a3' && row.li === before.get(row.key)).map((row) => row.key)
  assert.deepEqual(plain(kept), plain(after.map((row) => row.key).filter((key) => key !== 'session:s-a3')), `every other row is the element it was\nsaw: ${describe(after)}`)
  assert.equal(after.find((row) => row.key === 'session:s-a2')?.selected, 'true', 'and the open session stays selected')
})

test('a session that got a new message keeps its row element, which takes the new stamp', async () => {
  const data = world()
  const view = load(data, [A])
  await view.render()
  const before = view.rows().find((row) => row.key === 'session:s-a1')
  const later = '2026-10-31T17:09:00.000Z'
  data.sessions = data.sessions.map((meta) => (meta.id === 's-a1' ? { ...meta, updated: later, turns: 2 } : meta))
  await view.render()
  const after = view.rows().find((row) => row.key === 'session:s-a1')
  assert.ok(before !== undefined && after !== undefined && after.li === before.li, 'the row is the element it was')
  assert.equal(view.stamp('session:s-a1'), later, 'and its age reads the new stamp')
})

test('a kept Show more still shows the group\'s other sessions in the list on the page', async () => {
  const data = world()
  const extra = Array.from({ length: 5 }, (_, index) => session(`s-x${index}`, A, 10 + index))
  data.workspaces = data.workspaces.map((entry) => (entry.id === 'ws-a' ? { ...entry, sessionIds: [...entry.sessionIds, ...extra.map((meta) => meta.id)] } : entry))
  data.sessions = [...data.sessions, ...extra]
  const view = load(data, [A])
  await view.render()
  const before = view.more(A)
  assert.ok(before !== null, 'eight sessions draw a Show more')
  const shown = view.rows().filter((row) => row.key.startsWith('session:')).length
  await view.render()
  assert.ok(view.more(A) === before, 'a refresh keeps the Show more element')
  view.pressMore(A)
  const after = view.rows().filter((row) => row.key.startsWith('session:')).length
  assert.ok(after > shown, `pressing it draws more sessions in the list on the page (${shown} before, ${after} after)`)
  assert.equal(after, 8, 'all eight')
})

test('a slower, older drawing never lands over a newer one, and its caller still goes on', async () => {
  const data = world()
  const view = load(data, [A])
  await view.render()
  view.hold(true)
  const older = view.render()
  await settle()
  view.hold(false)
  data.sessions = data.sessions.map((meta) => (meta.id === 's-a1' ? { ...meta, title: 'the newer title' } : meta))
  await view.render()
  assert.equal(view.rows().find((row) => row.key === 'session:s-a1')?.label, 'the newer title', 'the newer drawing is on the page')
  while (view.releaseFirst()) await settle()
  await older
  assert.equal(view.rows().find((row) => row.key === 'session:s-a1')?.label, 'the newer title', `the older drawing's answers, arriving last, draw nothing\nsaw: ${describe(view.rows())}`)
})

test('a level whose read fails draws its failure line in the new tree, and the sessions stay on the page throughout (#106)', async () => {
  const data = world()
  const view = load(data, [A])
  await view.render()
  const sessions = new Map(view.rows().filter((row) => SESSIONS_OF_A.includes(row.key)).map((row) => [row.key, row.li]))
  data.trees[A] = { status: 400, body: { error: 'cannot list "a": permission denied', code: 'workspace-file/unreadable' } }
  view.hold(true)
  const failures: string[] = []
  await stepThrough(view, view.render(), (moment) => {
    const now = view.rows()
    const gone = [...sessions].filter(([key, li]) => !now.some((row) => row.key === key && row.li === li)).map(([key]) => key)
    if (gone.length > 0) failures.push(`${moment}: ${gone.join(', ')} not on the page as before\n  ${describe(now)}`)
  })
  assert.deepEqual(failures, [], 'A\'s session rows stay, as the same elements')
  assert.deepEqual(
    plain(view.level(A)),
    {
      headings: ['Files'],
      lines: [{ text: 'Read failed: cannot list "a": permission denied', code: 'workspace-file/unreadable' }],
      rows: SESSIONS_OF_A,
    },
    'the workspace keeps its sessions and its Files heading, over the one failure line',
  )
  assert.deepEqual(plain(view.notes.filter((note) => note.startsWith('could not read'))), [], 'and no "could not read" note')
})

test('keyboard focus on a row stays on that element through a refresh', async () => {
  const view = load(world(), [B, A])
  await view.render()
  view.focus('session:s-a3')
  const focused = view.active()
  await view.render()
  assert.ok(view.active() === focused, 'the focused row was never taken out of the page: focus is on the same element')
})

test('a group a person folds while the refresh reads its levels stays folded once the refresh lands', async () => {
  const view = load(world(), [B, A])
  await view.render()
  view.hold(true)
  const drawing = view.render()
  await settle()
  view.releaseFirst()
  view.releaseFirst()
  await settle()
  /** Not awaited before the reads are let go: on the page before the fix, A was folded by the redraw, so this opens it and reads. */
  const folding = view.fold(A)
  view.hold(false)
  while (view.releaseFirst()) await settle()
  await Promise.all([folding, drawing])
  const rows = view.rows()
  assert.equal(rows.find((row) => row.key === 'node:/w/a')?.open, 'false', `A stays folded\nsaw: ${describe(rows)}`)
  assert.equal(rows.some((row) => SESSIONS_OF_A.includes(row.key)), false, 'with its sessions not drawn')
  assert.equal(rows.find((row) => row.key === 'node:/w/b')?.open, 'true', 'and B stays open')
})
