import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Schedules and reminders, judged as DSH's `dsh-tool-schedule` and `dsh-schedule` behave.
 *
 * Three claims, each through the build under test (the TypeScript dist, or the binary `HEDDLE_BIN` names):
 *
 * 1. **A reminder the model creates is delivered into its own session when it is due**, as DSH's exact
 *    `[SCHEDULE REMINDER]` message with source kind `schedule`, and a turn runs on it.
 * 2. **The four tools answer with DSH's results**: the canonical reminder view, the active list, an update in
 *    place that keeps the id, `{id, deleted}`, and DSH's refusal codes and sentences.
 * 3. **After downtime a recurring reminder delivers only its latest missed occurrence**: one batch message,
 *    and the next target is the first occurrence after the delivery.
 *
 * It is gated on the Web command alone, never on the schedule capability, so a build without reminders
 * fails here rather than skipping: the failure this exists to catch is a reminder that is accepted and then
 * never arrives, or arrives twice.
 *
 * Every model step comes from the offline scripted endpoint. The script is re-read on every model request,
 * so the check rewrites it between turns: a later turn can name the real reminder id, and the turn a
 * delivered reminder starts answers with plain text instead of creating another reminder.
 */
const CAPABILITY = 'the Web UI'

async function startServer(label, options = {}) {
  const home = options.home ?? isolatedHome(`schedules-${label}`)
  const work = options.work ?? fixtureDir(`schedules-${label}-work`)
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  const script = join(home, 'script.json')
  if (options.home === undefined) scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) resolvePromise(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
    setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return {
    home,
    work,
    url,
    script,
    cookie,
    output: () => output,
    kill: () => child.kill('SIGKILL'),
    close: () => {
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function openSession(server, folder) {
  mkdirSync(folder, { recursive: true })
  await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
  const opened = await api(server, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder }) })
  return opened.body.session?.id ?? opened.body.id
}

const steps = (server, list) => writeFileSync(server.script, JSON.stringify({ steps: list }))

async function turn(server, session, folder, list) {
  steps(server, list)
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'schedule probe', folder, session }),
  })
  assert.equal(response.status, 200, `the turn ran (${response.status})`)
  await response.text()
}

const events = (server, session) => readTranscript(join(server.home, 'sessions', session))
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')
const toolTexts = (server, session, since) =>
  events(server, session)
    .slice(since)
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map(textOf)
const reminders = (server, session) => events(server, session).filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'schedule')

async function waitFor(read, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
}

/** The tool answer as JSON; a refusal that is not JSON fails the comparison with its own text in view. */
function json(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { unparsed: text }
  }
}

test('a reminder the model creates is delivered into its own session when it is due', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('deliver')
  try {
    const folder = join(server.work, 'deliver')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'check the build', title: 'Build check', after_seconds: 2 } } },
      { text: 'reminder set' },
    ])
    // The turn the reminder starts must not create another one.
    steps(server, [{ text: 'the build is green' }])
    const created = json(toolTexts(server, session, mark)[0] ?? '')
    assert.match(String(created.id), /^schedule-[0-9a-f-]{36}$/, `schedule_create answers a view with a schedule id\nsaw: ${JSON.stringify(created)}`)
    assert.deepEqual(Object.keys(created), ['id', 'kind', 'title', 'prompt', 'afterSeconds', 'scheduledAt', 'state', 'deliveryMode'], 'the view keeps DSH key order')
    assert.equal(created.kind, 'after')
    assert.equal(created.afterSeconds, 2)
    assert.equal(created.state, 'scheduled')
    assert.equal(created.deliveryMode, 'host')
    assert.match(created.scheduledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'scheduledAt is canonical UTC')

    const delivered = await waitFor(() => reminders(server, session)[0], 15_000, 'the reminder in the session log')
    assert.equal(
      textOf(delivered),
      `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: ${JSON.stringify(created.id)}\noccurrence_at: ${created.scheduledAt}\nreminder_prompt_json: ${JSON.stringify('check the build')}`,
      'the delivered message is DSH one-shot template, word for word',
    )
    // Each read builds new objects, so the reminder is found by position in every read, never by identity.
    const afterReminder = () => {
      const all = events(server, session)
      return all.slice(all.findIndex((event) => event.type === 'message' && event.message?.source?.kind === 'schedule'))
    }
    await waitFor(() => afterReminder().some((event) => event.type === 'turn/completed'), 15_000, 'the turn the reminder started')
    assert.ok(
      afterReminder().some((event) => JSON.stringify(event).includes('the build is green')),
      'the model answered the reminder in that turn',
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
    assert.equal(reminders(server, session).length, 1, 'a one-shot reminder is delivered once')
  } finally {
    server.close()
  }
})

test('the four tools answer with DSH results and refusals', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('tools')
  try {
    const folder = join(server.work, 'tools')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'review the day', title: 'Daily review', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } } } },
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'x', title: 'two selectors', after_seconds: 60, every_seconds: 60 } } },
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'x', title: 'too often', every_seconds: 30 } } },
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'x', title: 'bad zone', daily: { time: '09:00:00', time_zone: 'Mars/Olympus' } } } },
      { toolCall: { name: 'schedule_list', arguments: {} } },
      { text: 'listed' },
    ])
    let answers = toolTexts(server, session, mark).map(json)
    const daily = answers[0]
    assert.deepEqual(Object.keys(daily), ['id', 'kind', 'title', 'prompt', 'time', 'timeZone', 'scheduledAt', 'state', 'deliveryMode'], `a daily view in DSH key order\nsaw: ${JSON.stringify(daily)}`)
    assert.equal(daily.time, '23:00:00.000')
    assert.equal(daily.timeZone, 'Asia/Shanghai')
    assert.match(daily.scheduledAt, /T15:00:00\.000Z$/, '23:00 in Shanghai is 15:00 UTC')
    assert.deepEqual(answers[1], { code: 'invalid_selector', message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.' })
    assert.deepEqual(answers[2], { code: 'frequency_too_high', message: 'every_seconds must be at least 60.' })
    assert.deepEqual(answers[3], { code: 'invalid_time_zone', message: 'time_zone must be UTC or a valid IANA Area/Location name.' })
    assert.deepEqual(answers[4], [daily], 'schedule_list answers the one active reminder')

    mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'schedule_update', arguments: { id: daily.id, title: 'Evening review' } } },
      { toolCall: { name: 'schedule_delete', arguments: { id: daily.id } } },
      { toolCall: { name: 'schedule_delete', arguments: { id: daily.id } } },
      { toolCall: { name: 'schedule_update', arguments: { id: daily.id, title: 'gone' } } },
      { text: 'done' },
    ])
    answers = toolTexts(server, session, mark).map(json)
    assert.deepEqual(answers[0], { ...daily, title: 'Evening review' }, 'an update in place keeps the id and the timing')
    assert.deepEqual(answers[1], { id: daily.id, deleted: true })
    assert.deepEqual(answers[2], { id: daily.id, deleted: false, code: 'schedule_not_found' })
    assert.deepEqual(answers[3], { id: daily.id, updated: false, code: 'schedule_not_found' })
  } finally {
    server.close()
  }
})

test('after downtime a recurring reminder delivers only its latest missed occurrence', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const first = await startServer('missed')
  const folder = join(first.work, 'missed')
  let second
  try {
    const session = await openSession(first, folder)
    const mark = events(first, session).length
    await turn(first, session, folder, [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'poll the queue', title: 'Queue poll', every_seconds: 60 } } },
      { text: 'polling set' },
    ])
    steps(first, [{ text: 'polled' }])
    const created = json(toolTexts(first, session, mark)[0] ?? '')
    assert.equal(created.kind, 'every', `an every_seconds reminder\nsaw: ${JSON.stringify(created)}`)
    first.kill()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))

    // Downtime, simulated: the stored target moves 150 s into the past, so three occurrences were missed
    // (-150 s, -90 s and -30 s). DSH delivers the latest of them, once, and drops the other two.
    const file = join(first.home, 'schedule.json')
    const unit = JSON.parse(readFileSync(file, 'utf8'))
    const row = unit.tables.tasks[created.id]
    assert.ok(row, `the reminder is stored in ${file} under its id`)
    const missedFrom = Date.now() - 150_000
    row.record.scheduledAt = new Date(missedFrom).toISOString()
    writeFileSync(file, JSON.stringify(unit))

    second = await startServer('missed', { home: first.home, work: first.work })
    const batch = await waitFor(() => reminders(second, session)[0], 15_000, 'the missed reminder after the restart')
    const text = textOf(batch)
    assert.match(text, /^\[SCHEDULE REMINDER BATCH\]\nThis is a scheduled message from the user\nreminders_json: /, 'a recurring reminder is delivered as DSH batch message')
    const entries = JSON.parse(text.slice(text.indexOf('reminders_json: ') + 'reminders_json: '.length))
    assert.equal(entries.length, 1, 'one entry for the one reminder')
    assert.equal(entries[0].schedule_id, created.id)
    assert.equal(entries[0].reminder_prompt, 'poll the queue')
    assert.equal(entries[0].occurrence_at, new Date(missedFrom + 120_000).toISOString(), 'the latest missed occurrence, not the first')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
    assert.equal(reminders(second, session).length, 1, 'the two earlier missed occurrences are dropped')
    const after = JSON.parse(readFileSync(file, 'utf8')).tables.tasks[created.id]
    assert.equal(after.status, 'active')
    assert.equal(after.record.scheduledAt, new Date(missedFrom + 180_000).toISOString(), 'the next target is the first occurrence after the delivered one')
  } finally {
    second?.kill()
    first.close()
  }
})

test('the model is told the current time before it answers, as DSH time context, at most once per ten minutes', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('clock')
  try {
    const folder = join(server.work, 'clock')
    const session = await openSession(server, folder)
    await turn(server, session, folder, [{ text: 'first answer' }])
    const readings = () => events(server, session).filter((event) => event.type === 'context/note' && event.message?.source?.kind === 'time-context')
    const [reading] = readings()
    assert.ok(reading, 'the first step of the turn carries a time-context reading')
    const text = textOf(reading)
    assert.match(
      text,
      /^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\[[A-Za-z_+\/.-]+\]\nBrowser time zone for this request: (unavailable\. Ask the user to clarify otherwise-unqualified dates and times\.|[A-Za-z_+\/.-]+\. Interpret otherwise-unqualified dates and times in this zone\.)\nElapsed since the preceding model-visible message: (unavailable|(\d+[dhm] )*\d+s)\.$/,
      `the reading is DSH three lines\nsaw: ${JSON.stringify(text)}`,
    )
    assert.equal(reading.message.role, 'user', 'the model reads it as a message')
    assert.deepEqual(reading.message.source, { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] })
    await turn(server, session, folder, [{ text: 'second answer' }])
    assert.equal(readings().length, 1, 'a second turn inside ten minutes adds no second reading')
  } finally {
    server.close()
  }
})

test('the page reads and edits reminders through DSH remote schedule namespace', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('routes')
  try {
    const folder = join(server.work, 'routes')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'review the day', title: 'Daily review', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } } } },
      { text: 'set' },
    ])
    const created = json(toolTexts(server, session, mark)[0] ?? '')
    const listed = await api(server, `/api/schedule/list?session=${encodeURIComponent(session)}`)
    assert.equal(listed.status, 200, `the list route answers\nsaw: ${JSON.stringify(listed)}`)
    assert.deepEqual(listed.body.reminders, [created], 'the page reads the view the tool answered')
    const catalog = await api(server, '/api/schedule/catalog')
    assert.deepEqual(catalog.body.tasks.map((task) => [task.id, task.sessionId, task.status]), [[created.id, session, 'active']])

    const { state, deliveryMode, ...expected } = created
    const renamed = await api(server, '/api/schedule/update', { method: 'POST', body: JSON.stringify({ sessionId: session, id: created.id, expected, title: 'Evening review' }) })
    assert.equal(renamed.body.updated, true, `an update over the current record lands\nsaw: ${JSON.stringify(renamed.body)}`)
    const stale = await api(server, '/api/schedule/update', { method: 'POST', body: JSON.stringify({ sessionId: session, id: created.id, expected, title: 'Lost edit' }) })
    assert.deepEqual(stale.body, { id: created.id, updated: false, code: 'schedule_conflict' }, 'a stale editor is refused, not merged')
    const deleted = await api(server, '/api/schedule/delete', { method: 'POST', body: JSON.stringify({ sessionId: session, id: created.id }) })
    assert.deepEqual(deleted.body, { id: created.id, deleted: true })
    assert.deepEqual((await api(server, `/api/schedule/list?session=${encodeURIComponent(session)}`)).body.reminders, [])
  } finally {
    server.close()
  }
})
