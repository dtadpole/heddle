import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The sidebar's row hover cards (C22 session rows, C41 workspace rows), judged out of the page that runs them.
 *
 * DSH opens a card beside a session row and beside a real workspace row after an 800 ms dwell: the session's title,
 * relative time, its own active scheduled tasks and its status; the workspace's title, home-abbreviated folder and
 * creation time. What goes on a card is a set of small decisions with traps in them (floored units, an unpadded date,
 * archived cards dropping `Idle`, overdue tasks first, two tasks then a count), so the pure block that makes them lives in
 * `page.html` between two markers and is loaded here.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* hover-card:begin */')
const end = page.indexOf('/* hover-card:end */')

interface Status {
  state: string
  label: string
}
interface SessionCard {
  kind: 'session'
  title: string
  time: string
  statuses: Status[]
  archived: boolean
  copyText?: string
}
interface WorkspaceCard {
  kind: 'workspace'
  title: string
  path: string
  created: string
  copyText?: string
}
interface Task {
  id: string
  name: string
  frequency: string
  scheduledAt: string
  absolute: string
  relative: string
}
interface Cards {
  OPEN_DELAY_MS: number
  CLOSE_DELAY_MS: number
  COPIED_MS: number
  GAP: number
  TASK_LIMIT: number
  timeAgo: (stamp: unknown, now: number) => string
  createdLabel: (stamp: unknown) => string
  abbreviateHome: (path: string, home: unknown) => string
  sessionCard: (facts: Record<string, unknown>, now: number) => SessionCard
  workspaceCard: (workspace: Record<string, unknown> | null, home: string) => WorkspaceCard | null
  clockLabel: (time: string) => string
  frequencyLabel: (record: Record<string, unknown>, at?: number) => string
  absoluteLabel: (scheduledAt: string) => string
  relativeLabel: (scheduledAt: string, now: number) => string
  sessionTasks: (catalog: unknown, sessionId: string, now: number) => { tasks: Task[]; more: number }
  place: (row: { top: number; right: number }, cardHeight: number, viewportHeight: number) => { left: number; top: number }
}

function load(): Cards {
  assert.ok(begin !== -1 && end > begin, 'the page carries the hover-card block between its markers')
  return new Function(`${page.slice(begin, end)}\nreturn HoverCards`)() as Cards
}

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test("a card opens on DSH's dwell and timings: 800 ms open, 200 ms close grace, 1 s Copied, two tasks", () => {
  const cards = load()
  assert.equal(cards.OPEN_DELAY_MS, 800)
  assert.equal(cards.CLOSE_DELAY_MS, 200)
  assert.equal(cards.COPIED_MS, 1000)
  assert.equal(cards.GAP, 8)
  assert.equal(cards.TASK_LIMIT, 2)
})

test("a session card's time is DSH's floored compact distance with ago, and bare now under a minute", () => {
  const cards = load()
  assert.equal(cards.timeAgo(ago(59_000), NOW), 'now')
  assert.equal(cards.timeAgo(ago(119_000), NOW), '1min ago', 'floored, not rounded')
  assert.equal(cards.timeAgo(ago(5 * MIN), NOW), '5min ago')
  assert.equal(cards.timeAgo(ago(3 * HOUR + 59 * MIN), NOW), '3h ago')
  assert.equal(cards.timeAgo(ago(4 * DAY), NOW), '4d ago')
  assert.equal(cards.timeAgo(ago(65 * DAY), NOW), '2mo ago')
  assert.equal(cards.timeAgo(ago(400 * DAY), NOW), '1y ago')
  assert.equal(cards.timeAgo(new Date(NOW + 5 * MIN).toISOString(), NOW), 'now', 'a clock ahead of the reader is now')
  assert.equal(cards.timeAgo(undefined, NOW), '')
})

test('a session card: the full title, time, status, and the stored title as what a click copies', () => {
  const cards = load()
  const facts = { label: 'a very long session title the row clips', title: 'a very long session title the row clips', blank: false, stamp: ago(5 * MIN), running: false, pendingApproval: false, archived: false }
  assert.deepEqual(cards.sessionCard(facts, NOW), {
    kind: 'session',
    title: 'a very long session title the row clips',
    time: '5min ago',
    statuses: [{ state: 'idle', label: 'Idle' }],
    archived: false,
    copyText: 'a very long session title the row clips',
  })
  assert.deepEqual(cards.sessionCard({ ...facts, running: true }, NOW).statuses, [{ state: 'ongoing', label: 'Running' }])
  assert.deepEqual(
    cards.sessionCard({ ...facts, running: true, pendingApproval: true }, NOW).statuses,
    [{ state: 'warning', label: 'Waiting for approval' }],
    'a pending interaction is the primary status, over a running turn',
  )
})

test('a blank session card has no time and copies nothing; an untitled one copies nothing either', () => {
  const cards = load()
  const blank = cards.sessionCard({ label: 'New session', title: '', blank: true, stamp: ago(MIN), archived: false }, NOW)
  assert.equal(blank.title, 'New session')
  assert.equal(blank.time, '')
  assert.equal(blank.copyText, undefined)
  const untitled = cards.sessionCard({ label: 'Untitled', blank: false, stamp: ago(2 * HOUR), archived: false }, NOW)
  assert.equal(untitled.time, '2h ago')
  assert.equal(untitled.copyText, undefined, "DSH copies the stored title only, never the row's fallback")
})

test('an archived session card drops Idle and says Archived; a running one keeps Running', () => {
  const cards = load()
  const idle = cards.sessionCard({ label: 'old', title: 'old', stamp: ago(DAY), archived: true }, NOW)
  assert.deepEqual(idle.statuses, [])
  assert.equal(idle.archived, true)
  const running = cards.sessionCard({ label: 'old', title: 'old', stamp: ago(DAY), archived: true, running: true }, NOW)
  assert.deepEqual(running.statuses, [{ state: 'ongoing', label: 'Running' }])
})

test('a workspace card: title, home-abbreviated folder, DSH created line; the full path is what a click copies', () => {
  const cards = load()
  const created = new Date(2026, 9, 5, 9, 3).toISOString()
  assert.deepEqual(cards.workspaceCard({ label: 'heddle', path: '/Users/ada/work/heddle', createdAt: created }, '/Users/ada'), {
    kind: 'workspace',
    title: 'heddle',
    path: '~/work/heddle',
    created: 'Created 2026-10-5 09:03',
    copyText: '/Users/ada/work/heddle',
  })
  assert.equal(cards.workspaceCard({ label: 'Ungrouped', path: '' }, '/Users/ada'), null, 'a row without a creation time has no card (the Ungrouped bucket)')
  assert.equal(cards.workspaceCard(null, '/Users/ada'), null)
})

test("the home abbreviation is DSH's: the home itself is ~, a sibling prefix is not home, no home keeps the path", () => {
  const cards = load()
  assert.equal(cards.abbreviateHome('/Users/ada', '/Users/ada/'), '~')
  assert.equal(cards.abbreviateHome('/Users/ada/x', '/Users/ada'), '~/x')
  assert.equal(cards.abbreviateHome('/Users/adam/x', '/Users/ada'), '/Users/adam/x')
  assert.equal(cards.abbreviateHome('/srv/x', ''), '/srv/x')
  assert.equal(cards.abbreviateHome('/srv/x', '/'), '/srv/x')
  assert.equal(cards.abbreviateHome('C:\\Users\\ada\\x', 'C:\\Users\\ada'), 'C:\\Users\\ada\\x')
})

test("a session card lists its own active tasks, overdue first, two of them and then how many more", () => {
  const cards = load()
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const catalog = [
    { id: 'a', kind: 'every', title: 'Queue poll', prompt: 'p', everySeconds: 7200, scheduledAt: at(5 * HOUR), sessionId: 's1', status: 'active' },
    { id: 'b', kind: 'daily', title: 'Daily review', prompt: 'p', time: '23:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: at(2 * HOUR), sessionId: 's1', status: 'active' },
    { id: 'c', kind: 'at', title: 'Overdue one', prompt: 'p', scheduledAt: at(-150_000), sessionId: 's1', status: 'active' },
    { id: 'd', kind: 'after', title: 'Ended', prompt: 'p', afterSeconds: 60, scheduledAt: at(MIN), sessionId: 's1', status: 'inactive' },
    { id: 'e', kind: 'after', title: 'Another session', prompt: 'p', afterSeconds: 60, scheduledAt: at(MIN), sessionId: 's2', status: 'active' },
  ]
  const section = cards.sessionTasks(catalog, 's1', NOW)
  assert.deepEqual(section.tasks.map((task) => task.name), ['Overdue one', 'Daily review'])
  assert.equal(section.more, 1, 'the third active task is counted, and the inactive and foreign ones are not')
  assert.equal(section.tasks[0]!.frequency, 'Once')
  assert.equal(section.tasks[0]!.relative, '(2 minutes overdue)')
  assert.equal(section.tasks[1]!.frequency, 'Daily at 23:00 (UTC+08:00 · China Standard Time)')
  assert.equal(section.tasks[1]!.relative, '(in 2 hours)')
  assert.match(section.tasks[1]!.absolute, /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}$/)
  assert.equal(section.tasks[1]!.scheduledAt, at(2 * HOUR))
  assert.deepEqual(cards.sessionTasks(catalog, 's3', NOW), { tasks: [], more: 0 }, 'a session with no task has no section')
  assert.deepEqual(cards.sessionTasks(null, 's1', NOW), { tasks: [], more: 0 }, 'an unread catalog is no task')
})

test("a task's frequency is DSH's English", () => {
  const cards = load()
  assert.equal(cards.frequencyLabel({ kind: 'after' }), 'Once')
  assert.equal(cards.frequencyLabel({ kind: 'every', everySeconds: 60 }), 'Every 1 minute')
  assert.equal(cards.frequencyLabel({ kind: 'every', everySeconds: 7200 }), 'Every 2 hours')
  assert.equal(cards.frequencyLabel({ kind: 'every', everySeconds: 90 }), 'Every 90 seconds')
  assert.equal(cards.frequencyLabel({ kind: 'every', everySeconds: 172800 }), 'Every 2 days')
  assert.equal(cards.frequencyLabel({ kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' }), 'Daily at 09:00 (UTC+00:00)')
  assert.equal(cards.frequencyLabel({ kind: 'weekly', time: '09:30:15', weekdays: [1, 3], timeZone: 'UTC' }), 'Weekly on Mon, Wed at 09:30:15 (UTC+00:00)')
  assert.equal(cards.frequencyLabel({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'UTC' }), 'Cron 0 9 * * 1-5 (UTC+00:00)')
  assert.equal(cards.clockLabel('23:00:00.000'), '23:00')
})

test("a task's next run counts up in the future and down when overdue, in the largest whole unit", () => {
  const cards = load()
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  assert.equal(cards.relativeLabel(at(0), NOW), '(Due now)')
  assert.equal(cards.relativeLabel(at(HOUR), NOW), '(in 1 hour)')
  assert.equal(cards.relativeLabel(at(90_000), NOW), '(in 2 minutes)', 'a future distance rounds up')
  assert.equal(cards.relativeLabel(at(-90_000), NOW), '(1 minute overdue)', 'an overdue one rounds down')
  assert.equal(cards.relativeLabel(at(30_000), NOW), '(in 30 seconds)')
  assert.equal(cards.absoluteLabel('not a time'), 'not a time')
})

test('the card sits 8px right of its row, level with its top, lifted above the bottom edge when it would overflow', () => {
  const cards = load()
  assert.deepEqual(cards.place({ top: 100, right: 260 }, 120, 800), { left: 268, top: 100 })
  assert.deepEqual(cards.place({ top: 740, right: 260 }, 120, 800), { left: 268, top: 672 })
})
