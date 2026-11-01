import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * C22, the session hover card's statuses, run out of the page: its own `rowHoverCard` (the page's half of the card) over
 * its own hover-card and workspace-tree blocks, with the requests answered and the DOM stood in for.
 *
 * DSH's session card lists every status of the session (`SessionHoverContent` over `sessionStatuses`,
 * dsh-client-ui-workspace `lib/client.js:2141-2165`, `:2068-2117`): its live pending interaction — an approval, a plan
 * review or an ordinary question (`visiblePendingKind`, `:1048-1055`) — or its running turn, then `{n} subagent(s)
 * running` (`runningChildCount`, `:1056-1058`), else an unread `Completed` (`completionUnread`, `:1068`), else `Idle`.
 * Before (R-developer-eight-25, ff8add30's own note): the card read only `/api/approvals` and `runningSessions`, so a
 * session waiting on a question or a plan review, or whose subagent was running, or whose turn ended unseen, read `Idle`.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const between = (begin: string, end: string) => page.slice(page.indexOf(begin), page.indexOf(end))
const tree = between('/* workspace-tree:begin */', '/* workspace-tree:end */')
const cards = between('/* hover-card:begin */', '/* hover-card:end */')
/** The page's half of the card: `const rowHoverCard = (() => { … })()`. */
const half = (() => {
  const start = page.indexOf('\nconst rowHoverCard = (() => {')
  assert.ok(start >= 0, 'the page defines rowHoverCard')
  return page.slice(start + 1, page.indexOf('\n})()\n', start) + 5)
})()

const ID = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = 'session-22222222-2222-4222-8222-222222222222'
const OTHER = 'session-33333333-3333-4333-8333-333333333333'

interface World {
  /** `/api/approvals`' requests. */
  approvals?: unknown[]
  /** `/api/questions?session=` answers, by session; a number is a status with no body. */
  questions?: Record<string, unknown[] | number>
  running?: string[]
  unread?: string[]
  /** What `/api/sessions` listed last (`listedMetas`), and what the tree kept of the children (`childSessions`). */
  listed?: unknown[]
  children?: unknown[]
}

/** Rest the pointer on the session row for the dwell and answer the card's status lines, and every URL it asked for. */
async function hover(world: World): Promise<{ statuses: { state: string; label: string }[]; asked: string[] }> {
  const run = runInNewContext(
    `
    ${tree}
    ${cards}
    class Element {}
    const make = (tag) => Object.assign(Object.create(Element.prototype), {
      tagName: String(tag).toUpperCase(), className: '', hidden: false, textContent: '', dataset: {}, style: {}, children: [], attributes: {},
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      removeAttribute(name) { delete this.attributes[name] },
      append(...nodes) { this.children.push(...nodes) },
      replaceChildren(...nodes) { this.children = nodes },
      addEventListener() {},
      contains: () => false,
      querySelector: () => null,
      getBoundingClientRect: () => ({ top: 10, right: 200, left: 0, bottom: 42 }),
      offsetHeight: 80,
    })
    const document = { createElement: make, createElementNS: (_ns, tag) => make(tag), body: make('body') }
    const window = { innerHeight: 900, addEventListener() {}, getSelection: () => null }
    const navigator = {}
    const CSS = { escape: (text) => text }
    const listeners = {}
    const events = { addEventListener: (type, handler) => { listeners['events:' + type] = handler } }
    const timers = new Map()
    let ticket = 0
    const setTimeout = (handler) => { ticket += 1; timers.set(ticket, handler); return ticket }
    const clearTimeout = (id) => { timers.delete(id) }
    const asked = []
    const fetch = async (url) => {
      asked.push(url)
      const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
      if (url === '/api/approvals') return answer(200, { requests: WORLD.approvals ?? [] })
      if (url === '/api/schedule/catalog') return answer(200, { tasks: [] })
      const match = /^\\/api\\/questions\\?session=(.+)$/.exec(url)
      if (match !== null) {
        const session = decodeURIComponent(match[1])
        const given = (WORLD.questions ?? {})[session] ?? []
        return typeof given === 'number' ? answer(given, { error: 'refused' }) : answer(200, { session, requests: given })
      }
      return answer(404, {})
    }
    /** The session row the pointer rests on, inside its list item, inside the tree. */
    const li = make('li')
    li.dataset.kind = 'session'
    li.dataset.sessionId = ID
    li.dataset.rowKey = 'session:' + ID
    const row = make('div')
    row.parentElement = li
    row.isConnected = true
    row.dataset.path = 'session:' + ID
    const label = make('span')
    label.textContent = 'the session'
    row.querySelector = (selector) => (selector === ':scope > .label' ? label : null)
    row.closest = (selector) => (selector === '.row' ? row : null)
    const treeList = {
      addEventListener: (type, handler) => { listeners['tree:' + type] = handler },
      contains: (node) => node === row,
      querySelector: () => row,
    }
    const meta = { id: ID, title: 'the session', turns: 2, updated: new Date(Date.now() - 120000).toISOString() }
    const rowIndex = new Map([['session:' + ID, { node: { kind: 'session', session: meta, archived: false } }]])
    let searchIndex = null
    const runningSessions = new Set(WORLD.running ?? [])
    const unreadSessions = new Set(WORLD.unread ?? [])
    const listedMetas = new Map((WORLD.listed ?? []).map((entry) => [entry.id, entry]))
    let childSessions = WORLD.children ?? []
    const runningSpinner = () => make('svg')
    const kindIcon = () => make('svg')
    ${half}
    ;(async () => {
      listeners['tree:pointerover']({ target: row })
      for (const handler of [...timers.values()]) handler()
      timers.clear()
      for (let round = 0; round < 10; round += 1) await Promise.resolve()
      await new Promise((resolve) => resolve())
      const card = document.body.children[0]
      const lines = card.hidden ? [] : card.children.filter((line) => line.className === 'hover-status')
      return JSON.stringify({
        statuses: lines.map((line) => ({ state: line.children[0].dataset.state, label: line.children[1].textContent })),
        asked,
      })
    })()
    `,
    { WORLD: world, ID, JSON, Promise, Map, Set, Array, Object, String, Number, Date, Math, Error, RegExp, Intl, encodeURIComponent, decodeURIComponent },
  ) as Promise<string>
  return JSON.parse(await run)
}

test('the card reads the hovered session\'s questions, and a waiting question is Waiting for answer, over its running turn', async () => {
  const card = await hover({
    running: [ID],
    questions: { [ID]: [{ id: 'question-1', session: ID, state: 'waiting', questions: [{ id: 'color', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }] }] },
  })
  assert.ok(card.asked.includes(`/api/questions?session=${encodeURIComponent(ID)}`), `the dwell asks for this session's questions\nasked: ${JSON.stringify(card.asked)}`)
  assert.deepEqual(card.statuses, [{ state: 'warning', label: 'Waiting for answer' }], `saw: ${JSON.stringify(card)}`)
})

test('a plan put to the person reads Plan awaiting review, and outranks an approval of the same session', async () => {
  const card = await hover({
    approvals: [{ id: 'approval-1', session: ID }],
    questions: {
      [ID]: [{ id: 'question-2', session: ID, state: 'continued', questions: [{ id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?', options: [{ label: 'Approve' }, { label: 'Keep planning' }] }] }],
    },
  })
  assert.deepEqual(card.statuses, [{ state: 'warning', label: 'Plan awaiting review' }], `saw: ${JSON.stringify(card)}`)
})

test('a session whose subagent child runs says how many, from the listed children and the live running set', async () => {
  const child = { id: CHILD, origin: 'subagent', parentSession: ID, running: true }
  const stopped = { id: OTHER, origin: 'subagent', parentSession: ID, running: true }
  const card = await hover({ running: [CHILD], listed: [{ id: ID }, child, stopped] })
  assert.deepEqual(card.statuses, [{ state: 'ongoing', label: '1 subagent running' }], `a child the live set no longer runs is not counted\nsaw: ${JSON.stringify(card)}`)
  const fromTree = await hover({ running: [ID, CHILD, OTHER], children: [child, stopped] })
  assert.deepEqual(fromTree.statuses, [{ state: 'ongoing', label: 'Running' }, { state: 'ongoing', label: '2 subagents running' }], `with no list read yet, the tree's children; a running turn comes first\nsaw: ${JSON.stringify(fromTree)}`)
})

test('a turn that ended while the session was off screen reads Completed, and an approval still reads Waiting for approval', async () => {
  assert.deepEqual((await hover({ unread: [ID] })).statuses, [{ state: 'done', label: 'Completed' }])
  assert.deepEqual((await hover({ approvals: [{ id: 'approval-1', session: ID }], questions: { [ID]: 503 } })).statuses, [{ state: 'warning', label: 'Waiting for approval' }], 'a profile without the questions plugin is no question wait')
  assert.deepEqual((await hover({ approvals: [{ id: 'approval-1', session: OTHER }] })).statuses, [{ state: 'idle', label: 'Idle' }], "another session's approval is not this one's")
})
