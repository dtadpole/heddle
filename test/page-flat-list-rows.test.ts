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
