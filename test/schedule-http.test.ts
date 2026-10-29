import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { handleScheduleRoute } from '../src/schedule/http.ts'
import { ScheduleService } from '../src/schedule/service.ts'

const root = mkdtempSync(join(tmpdir(), 'heddle-schedule-http-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** 2026-10-29T11:30:16Z. */
const T0 = Date.UTC(2026, 9, 29, 11, 30, 16)
let counter = 0

async function serve(service: ScheduleService | undefined): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    void handleScheduleRoute(service, url, request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404)
        response.end('not a reminder route\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

async function setup() {
  counter += 1
  const clock = { now: T0 }
  let ids = 0
  const service = new ScheduleService({ file: join(root, `case-${counter}`, 'schedule.json'), now: () => clock.now, newId: () => `schedule-${(ids += 1)}` })
  const { url, server } = await serve(service)
  after(() => server.close())
  return { service, clock, url }
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('a profile without the schedule plugin answers 503, and other paths are not this module', async () => {
  const { url, server } = await serve(undefined)
  try {
    const answer = await get(`${url}/api/schedule/catalog`)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: 'this profile does not load the schedule plugin' })
    assert.equal((await fetch(`${url}/api/goal`)).status, 404, 'a path outside /api/schedule/ is left to the server')
  } finally {
    server.close()
  }
})

test('list answers the session active reminders as views, and catalog every row with its session', async () => {
  const { service, url } = await setup()
  const record = await service.create('session-1', { prompt: 'Review', title: 'Daily review', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } })
  await service.create('session-2', { prompt: 'Other', title: 'Other', after_seconds: 60 })

  const listed = await get(`${url}/api/schedule/list?session=session-1`)
  assert.equal(listed.status, 200)
  assert.equal(listed.body['sessionId'], 'session-1')
  const reminders = listed.body['reminders'] as Record<string, unknown>[]
  assert.equal(reminders.length, 1)
  assert.deepEqual(Object.keys(reminders[0] ?? {}), ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt', 'state', 'deliveryMode'], 'a view in DSH key order')
  assert.equal(reminders[0]?.['id'], record.id)
  assert.equal(reminders[0]?.['state'], 'scheduled')

  const catalog = await get(`${url}/api/schedule/catalog`)
  const tasks = catalog.body['tasks'] as { sessionId: string; status: string; id: string }[]
  assert.deepEqual(tasks.map((task) => [task.sessionId, task.status]).sort(), [['session-1', 'active'], ['session-2', 'active']])

  assert.equal((await get(`${url}/api/schedule/list`)).status, 400, 'list needs a session')
})

test('update is a compare-and-set over the complete expected record, as DSH remote update', async () => {
  const { service, url } = await setup()
  const record = await service.create('session-1', { prompt: 'Review', title: 'Daily review', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } })

  const renamed = await post(`${url}/api/schedule/update`, { sessionId: 'session-1', id: record.id, expected: record, title: 'Evening review' })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body['updated'], true)
  assert.equal((renamed.body['record'] as { title: string }).title, 'Evening review')

  const stale = await post(`${url}/api/schedule/update`, { sessionId: 'session-1', id: record.id, expected: record, title: 'Lost edit' })
  assert.deepEqual(stale.body, { id: record.id, updated: false, code: 'schedule_conflict' }, 'the old record no longer matches')

  const elsewhere = await post(`${url}/api/schedule/update`, { sessionId: 'session-2', id: record.id, expected: record, title: 'x' })
  assert.deepEqual(elsewhere.body, { id: record.id, updated: false, code: 'schedule_not_found' }, 'another session cannot reach it')

  assert.equal((await post(`${url}/api/schedule/update`, '[1, 2]')).status, 400, 'the body must be one JSON object')
})

test('a refused input answers 400 with DSH code and sentence', async () => {
  const { service, url } = await setup()
  const record = await service.create('session-1', { prompt: 'Review', title: 'Daily review', every_seconds: 600 })
  const answer = await get(`${url}/api/schedule/history?session=session-1&id=${record.id}&limit=0`)
  assert.equal(answer.status, 400)
  assert.deepEqual(answer.body, { code: 'invalid_rule', message: 'Delivery history limit must be a safe integer from 1 through 100.' })
})

test('history answers the newest records first with the retention, and delete removes the task once', async () => {
  const { service, url } = await setup()
  const record = await service.create('session-1', { prompt: 'Review', title: 'Daily review', every_seconds: 600 })
  const history = await get(`${url}/api/schedule/history?session=session-1&id=${record.id}`)
  assert.equal(history.status, 200)
  assert.deepEqual(history.body, { id: record.id, records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } })

  assert.deepEqual((await post(`${url}/api/schedule/delete`, { sessionId: 'session-1', id: record.id })).body, { id: record.id, deleted: true })
  assert.deepEqual((await post(`${url}/api/schedule/delete`, { sessionId: 'session-1', id: record.id })).body, { id: record.id, deleted: false, code: 'schedule_not_found' })
  assert.equal((await post(`${url}/api/schedule/delete`, { id: record.id })).status, 400, 'delete needs {sessionId, id}')
  assert.equal((await get(`${url}/api/schedule/nothing`)).status, 404)
})
