import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The rows of "In one list", run out of the page: `renderFlatList` with the page's own `WorkspaceTree` rules and a small
 * stand-in for the DOM.
 *
 * F3 (developer-ten's review of stack-2): the flat list's row opened an archived session. Its click called
 * `showSession` with no archive guard, while "Show archived" and "Archived only" keep archived rows in the list. DSH's
 * `FlatList` draws its tree's `SessionNodeItem` and hands it the tree's `guardedOpen` (`dsh-client-ui-workspace`
 * lib/client.js:3978-3987, :3532-3538), so an archived row says why to a screen reader (`aria-description`, :2279) and its
 * click raises "Archived sessions cannot be opened. Unarchive it to view." instead of opening, as the tree's rows here do.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* workspace-tree:begin */')
const end = page.indexOf('/* workspace-tree:end */')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}\n', start) + 2)
}

interface Element {
  tagName: string
  tabIndex: number
  dataset: Record<string, string>
  children: Element[]
  getAttribute(name: string): string | null
  onclick: (() => Promise<void>) | null
  onkeydown: ((event: unknown) => void) | null
}

interface Drawn {
  rows: Element[]
  opened: string[]
  notified: number
  ARCHIVED_NOT_OPENABLE: string
}

/** Draw the flat list over `sessions` with archived rows shown, and answer its items and what a click did. */
async function draw(sessions: object[]): Promise<Drawn> {
  const api = runInNewContext(
    `
    ${page.slice(begin, end)}
    /** A DOM element as far as the flat list uses one; li and div are no Tab stop until a tabIndex says so. */
    class Element {
      constructor(tag) {
        this.tagName = tag.toUpperCase()
        this.tabIndex = -1
        this.dataset = {}
        this.attributes = {}
        this.children = []
        this.className = ''
        this.textContent = ''
        this.onclick = null
        this.onkeydown = null
      }
      setAttribute(name, value) { this.attributes[name] = String(value) }
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null }
      append(...children) { this.children.push(...children) }
      replaceChildren(...children) { this.children = children }
      querySelectorAll(selector) {
        if (selector !== 'li[data-kind="session"]') throw new Error('unexpected selector ' + selector)
        return this.children.filter((child) => child.tagName === 'LI' && child.dataset.kind === 'session')
      }
    }
    const document = { createElement: (tag) => new Element(tag) }
    const treeList = new Element('ul')
    const rowIndex = new Map()
    let heldTreeFocus = null
    let shownOrders = {}
    let current = null
    const archiveMode = 'show'
    const orderState = WorkspaceTree.readOrder(null)
    const opened = []
    let notified = 0
    const treeFocus = () => null
    const restoreTreeFocus = () => {}
    const loadSearchIndex = async () => ({ sessions: SESSIONS, roots: [] })
    const kindIcon = () => new Element('svg')
    const workspaceOf = () => null
    const relativeAge = () => '1d'
    const showSession = async (id) => { opened.push(id); return true }
    const notifyArchivedNotOpenable = () => { notified += 1 }
    const wireSessionDrag = () => {}
    const setNote = () => {}
    const paintEmptyList = () => {}
    const paintConversationTarget = () => {}
    ${source('renderFlatList')}
    ;({
      draw: async () => { await renderFlatList(); return treeList.children },
      opened: () => [...opened],
      notified: () => notified,
      ARCHIVED_NOT_OPENABLE: WorkspaceTree.ARCHIVED_NOT_OPENABLE,
    })
    `,
    { SESSIONS: sessions, Map, Set, Promise, JSON, Object, Array, String, Number, Date, Math, Error },
  ) as { draw(): Promise<Element[]>; opened(): string[]; notified(): number; ARCHIVED_NOT_OPENABLE: string }
  const rows = await api.draw()
  return {
    rows,
    /** Copied into this realm: an array made in the page's context has another prototype, which deepEqual compares. */
    get opened() {
      return [...api.opened()]
    },
    get notified() {
      return api.notified()
    },
    ARCHIVED_NOT_OPENABLE: api.ARCHIVED_NOT_OPENABLE,
  }
}

const now = '2026-10-31T12:00:00.000Z'
const sessions = [
  { id: 'session-00000000-0000-0000-0000-00000000000a', title: 'Kept', turns: 2, created: now, updated: now, cwd: '/work' },
  { id: 'session-00000000-0000-0000-0000-00000000000b', title: 'Put away', turns: 2, created: now, updated: now, cwd: '/work', archived: true },
]
const item = (drawn: Drawn, id: string) => {
  const li = drawn.rows.find((one) => one.dataset.sessionId === id)
  assert.ok(li !== undefined, `the list draws ${id}`)
  return li
}
const rowOf = (li: Element) => li.children.find((child) => child.tagName === 'DIV') as Element

test("an archived row in the flat list says it will not open, and a click raises DSH's notice instead of opening it (F3)", async () => {
  const drawn = await draw(sessions)
  const archived = item(drawn, 'session-00000000-0000-0000-0000-00000000000b')
  assert.equal(archived.dataset.archived, 'true', 'the archived state is on the item, as on a tree row')
  assert.equal(archived.getAttribute('aria-description'), drawn.ARCHIVED_NOT_OPENABLE, "and a screen reader hears DSH's reason")
  await rowOf(archived).onclick?.()
  assert.deepEqual(drawn.opened, [], 'a click opens nothing')
  assert.equal(drawn.notified, 1, 'and raises the not-openable notice')

  const kept = item(drawn, 'session-00000000-0000-0000-0000-00000000000a')
  assert.equal(kept.dataset.archived, undefined, 'a row that is not archived carries no archived state')
  assert.equal(kept.getAttribute('aria-description'), null, 'and no reason')
  await rowOf(kept).onclick?.()
  assert.deepEqual(drawn.opened, ['session-00000000-0000-0000-0000-00000000000a'], 'its click opens it')
  assert.equal(drawn.notified, 1, 'without the notice')
})

test('a flat row is one Tab stop on its tree item, which takes Enter and Space only when the key is its own (F4, #92)', async () => {
  /**
   * The item carries role=treeitem and aria-selected (and, archived, aria-description); the focus was on the inner
   * `.row`, a div with no role, so a screen reader on it heard none of them. DSH puts the role, the states and the click
   * on one element (`dsh-client-ui-workspace` lib/client.js:2273-2282).
   */
  const drawn = await draw(sessions)
  const kept = item(drawn, 'session-00000000-0000-0000-0000-00000000000a')
  const row = rowOf(kept)
  assert.equal(kept.tabIndex, 0, 'the item is the Tab stop')
  assert.equal(row.tabIndex, -1, 'and the row inside it is none')
  assert.equal(row.onkeydown, null, 'and takes no keys of its own')
  let prevented = 0
  const key = (key: string, target: unknown) => kept.onkeydown?.({ key, target, preventDefault: () => (prevented += 1) })
  key('Enter', row)
  key(' ', { tagName: 'BUTTON' })
  key('a', kept)
  await Promise.resolve()
  assert.deepEqual(drawn.opened, [], 'a key whose target is not the item, or that is not Enter or Space, opens nothing')
  key('Enter', kept)
  await Promise.resolve()
  assert.deepEqual(drawn.opened, ['session-00000000-0000-0000-0000-00000000000a'], 'Enter on the item opens it')
  key(' ', kept)
  await Promise.resolve()
  assert.equal(drawn.opened.length, 2, 'and so does Space')
  assert.equal(prevented, 2, "and the page's own scroll on Space does not happen")
  const archived = item(drawn, 'session-00000000-0000-0000-0000-00000000000b')
  archived.onkeydown?.({ key: 'Enter', target: archived, preventDefault: () => {} })
  await Promise.resolve()
  assert.equal(drawn.opened.length, 2, 'Enter on an archived item opens nothing')
  assert.equal(drawn.notified, 1, 'and raises the notice, as its click does')
})
