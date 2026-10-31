import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import * as activity from '../src/session/activity.ts'
import { activitySessions, sessionActivity } from '../src/session/activity.ts'
import { ScheduleService } from '../src/schedule/service.ts'

/**
 * Archive and unarchive with running work, judged at the two places the rules live (R-developer-eight-13, -14).
 *
 * DSH refuses a plain archive while a session has work in flight and names that work by family — the turn in progress
 * (`dsh-agent`), running subagent descendants (`dsh-subagent`, found by lineage) — and its sidebar opens a stop-and-archive
 * dialog listing it, then shows a notice with `undo`. `src/session/activity.ts` is the server half (the `409` body); the
 * page's `session-archive` block is the other half (the wording, the refusal it recognises, the notice's actions).
 *
 * The schedule row's reminders are a family too (`dsh-schedule`), read and stopped through the row's public `list` and
 * `stopSessionTasks`, and the four families come in DSH's listener order: turn, job, subagent, schedule.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-archive-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* session-archive:begin */')
const end = page.indexOf('/* session-archive:end */')

interface Archive {
  TEXT: Record<string, string>
  confirmDescription: (title: string) => string
  activityLine: (entry: unknown) => string
  refusedActivity: (status: number, body: unknown) => unknown[] | undefined
  notice: (kind: string, archiveMode: string) => { text: string; tone: string; holdMs: number; actions: { action: string; label: string; prefix?: string }[] }
}

function archive(): Archive {
  assert.ok(begin >= 0 && end > begin, 'the page carries the session-archive block between its markers')
  return new Function(`${page.slice(begin, end)}\nreturn SessionArchive`)() as Archive
}

test('a quiet session reports no activity, and a running turn is named as DSH names it', () => {
  const metas = [{ id: 'a' }]
  assert.deepEqual(sessionActivity('a', metas, () => false), [])
  assert.deepEqual(sessionActivity('a', metas, (id) => id === 'a'), [{ kind: 'turn' }])
})

test('running subagent descendants are listed at any depth, labelled by title, and a fork is not one', () => {
  const metas = [
    { id: 'a' },
    { id: 'child', parentSession: 'a', origin: 'subagent', title: 'look things up' },
    { id: 'grandchild', parentSession: 'child', origin: 'subagent' },
    { id: 'idle-child', parentSession: 'a', origin: 'subagent' },
    { id: 'fork', parentSession: 'a', title: 'a fork' },
    { id: 'other', parentSession: 'b', origin: 'subagent' },
  ]
  const running = (id: string) => ['child', 'grandchild', 'fork', 'other'].includes(id)
  const activity = sessionActivity('a', metas, running)
  assert.deepEqual(activity, [{ kind: 'subagent', items: [{ id: 'child', label: 'look things up' }, { id: 'grandchild' }] }])
  assert.deepEqual(activitySessions('a', activity), ['a', 'child', 'grandchild'], 'a stop reaches the session and each running child')
})

test('a lineage that loops is walked once', () => {
  const metas = [
    { id: 'a', parentSession: 'b', origin: 'subagent' },
    { id: 'b', parentSession: 'a', origin: 'subagent' },
  ]
  assert.deepEqual(sessionActivity('a', metas, () => true), [{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'b' }, { id: 'a' }] }])
})

test("the page recognises the server's refusal and lists the work in DSH's words", () => {
  const block = archive()
  assert.deepEqual(block.refusedActivity(409, { code: 'active', activity: [{ kind: 'turn' }] }), [{ kind: 'turn' }])
  assert.deepEqual(block.refusedActivity(409, { code: 'active', running: 1 }), [{ kind: 'turn' }], 'a server that predates the list still names its turn')
  assert.equal(block.refusedActivity(409, { code: 'archived' }), undefined, 'another refusal is not a stop-and-archive question')
  assert.equal(block.refusedActivity(200, {}), undefined)

  assert.equal(block.activityLine({ kind: 'turn' }), 'The turn in progress')
  assert.equal(block.activityLine({ kind: 'subagent', items: [{ id: 's-1', label: 'look things up' }] }), '1 running subagent: look things up')
  assert.equal(block.activityLine({ kind: 'subagent', items: [{ id: 's-1' }, { id: 's-2', label: 'two' }] }), '2 running subagents: s-1, two')
  assert.equal(block.activityLine({ kind: 'job', items: [{ id: 'j', label: 'build' }] }), '1 background job: build')
  assert.equal(block.activityLine({ kind: 'schedule', items: [{ id: 'r1' }, { id: 'r2' }] }), '2 scheduled reminders: r1, r2')
  assert.equal(block.activityLine({ kind: 'mystery', items: [{ id: 'x' }] }), '1 other item of work (mystery)')
  assert.equal(
    block.confirmDescription('Quarterly figures'),
    '“Quarterly figures” still has work in progress. Archiving stops it first; you can restore the session later from the “All conversations (show archived)” filter in the sidebar, and the stopped work will not resume on its own.',
  )
  assert.equal(block.TEXT.confirmTitle, 'Stop and archive this session?')
  assert.equal(block.TEXT.confirmAction, 'Stop and archive')
})

test('an archive notice offers undo, and the filter only while archived rows are hidden; an archived hit says why it will not open', () => {
  const block = archive()
  const hidden = block.notice('stoppedAndArchived', 'hide')
  assert.equal(hidden.text, 'Session stopped and archived. You can ')
  assert.deepEqual(hidden.actions.map((action) => [action.prefix ?? '', action.label]), [['', 'undo'], [' or ', 'filter archived sessions']])
  assert.equal(hidden.holdMs, 6000)
  const shown = block.notice('archived', 'show')
  assert.equal(shown.text, 'Session archived. You can ')
  assert.deepEqual(shown.actions.map((action) => action.action), ['undo'], 'with archived rows in view there is nothing to filter to')
  const refused = block.notice('archivedNotOpenable', 'hide')
  assert.equal(refused.text, 'Archived sessions cannot be opened. Unarchive it to view.')
  assert.deepEqual(refused.actions, [])
  assert.equal(block.TEXT.unarchiveSession, 'Unarchive session')
})

test("the four families come in DSH's listener order: turn, job, subagent, schedule", () => {
  /**
   * A Cordis waterfall whose listeners each answer `[own, ...rest]` lists the first registered family first, and DSH
   * registers turn (the Agent registry), job (the job registry seam), subagent (inside `inject(['agents'])`), then
   * schedule (the service with the most injections) — see `src/session/activity.ts`.
   */
  const metas = [{ id: 'a' }, { id: 'child', parentSession: 'a', origin: 'subagent', title: 'look things up' }]
  const rows = { jobs: [{ id: 'bash-0123456789abcdef', label: 'sleep 30' }], schedules: [{ id: 'schedule-1', label: 'Stand-up' }] }
  assert.deepEqual(sessionActivity('a', metas, () => true, rows), [
    { kind: 'turn' },
    { kind: 'job', items: [{ id: 'bash-0123456789abcdef', label: 'sleep 30' }] },
    { kind: 'subagent', items: [{ id: 'child', label: 'look things up' }] },
    { kind: 'schedule', items: [{ id: 'schedule-1', label: 'Stand-up' }] },
  ])
  assert.deepEqual(
    sessionActivity('a', metas, () => false, { schedules: rows.schedules }),
    [{ kind: 'schedule', items: [{ id: 'schedule-1', label: 'Stand-up' }] }],
    'an idle session with an active reminder is still active',
  )
  assert.deepEqual(sessionActivity('a', metas, () => false, { jobs: [], schedules: [] }), [], 'an empty family is not reported')
})

test("a stop reaches sessions only: a job's or a reminder's id is not a session to abort", () => {
  const named = [
    { kind: 'turn' as const },
    { kind: 'job' as const, items: [{ id: 'bash-0123456789abcdef', label: 'sleep 30' }] },
    { kind: 'subagent' as const, items: [{ id: 'child' }] },
    { kind: 'schedule' as const, items: [{ id: 'schedule-1', label: 'Stand-up' }] },
  ]
  assert.deepEqual(activitySessions('a', named), ['a', 'child'])
})

test("the schedule family is the session's active reminders, labelled by title, and the stop removes them through the row", async () => {
  const service = new ScheduleService({ file: join(scratch, 'schedule.json') })
  const standUp = await service.create('session-a', { prompt: 'say what you did', title: 'Stand-up', after_seconds: 3600 })
  const review = await service.create('session-a', { prompt: 'look back', title: 'Review', every_seconds: 3600 })
  const other = await service.create('session-b', { prompt: 'not mine', title: 'Elsewhere', after_seconds: 3600 })
  assert.deepEqual(
    await activity.scheduleActivity(service, 'session-a'),
    [
      { id: standUp.id, label: 'Stand-up' },
      { id: review.id, label: 'Review' },
    ],
    "DSH's { id: record.id, label: record.title }, in storage order, and another session's reminder is not listed",
  )
  const warnings: string[] = []
  await activity.stopSessionSchedules(service, 'session-a', (message) => warnings.push(message))
  assert.deepEqual(await activity.scheduleActivity(service, 'session-a'), [], "the stop removes every active reminder of the session (DSH's stopSessionTasks)")
  assert.deepEqual(
    (await service.list({ sessionId: 'session-b' })).map((record) => record.id),
    [other.id],
    "and leaves another session's alone",
  )
  assert.deepEqual(await activity.scheduleActivity(undefined, 'session-a'), [], 'without the schedule row there is no family')
  await activity.stopSessionSchedules(undefined, 'session-a', (message) => warnings.push(message))
  assert.equal(warnings.length, 0, 'nothing failed')
  await service.dispose()
})

test('a reminder stop that fails is reported, never thrown, as the registry logs a failing provider', async () => {
  const warnings: string[] = []
  const failing = { list: async () => [], stopSessionTasks: async () => Promise.reject(new Error('disk full')) }
  await activity.stopSessionSchedules(failing, 'session-a', (message) => warnings.push(message))
  assert.deepEqual(warnings, ["workspace: stopping session 'session-a' for archive failed: Error: disk full"])
})

test('the refusal says what blocks the archive', () => {
  const id = 'session-a'
  assert.equal(activity.refusalSentence(id, [{ kind: 'turn' }]), 'session session-a is running; pass stop: true to stop it and archive')
  assert.equal(activity.refusalSentence(id, [{ kind: 'subagent', items: [{ id: 'child' }] }]), 'session session-a is running; pass stop: true to stop it and archive')
  assert.equal(
    activity.refusalSentence(id, [{ kind: 'job', items: [{ id: 'bash-1', label: 'sleep 30' }] }, { kind: 'schedule', items: [{ id: 's', label: 'x' }] }]),
    'session session-a has running background jobs; pass stop: true to stop them and archive',
  )
  assert.equal(
    activity.refusalSentence(id, [{ kind: 'schedule', items: [{ id: 's', label: 'x' }] }]),
    'session session-a has active scheduled reminders; pass stop: true to stop them and archive',
  )
})
