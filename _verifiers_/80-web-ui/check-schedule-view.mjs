import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The reminder views, judged where a model creates a reminder and a person manages it.
 *
 * The claim is DSH's (`dsh-client-ui-schedule`): a settled `schedule_create` call becomes a **card in the turn's tail**
 * that names the task and its frequency and opens its details; the session header gets a **reminder clock** that, with
 * one reminder, opens that reminder directly; the session's sidebar row gets a **clock mark**; and the **Automation
 * tasks** page lists the task, edits it (a rename that the service keeps), shows its delivery records and deletes it.
 *
 * Every UI action is followed by a read of the service (`/api/schedule/…` from Node, with the page's cookie), not only
 * of the DOM: a view that repaints without the write reaching the store is the failure this exists to catch. The check
 * is gated on the Web command and on a browser, **never** on the schedule capability, so a page or a server without the
 * reminder views fails it rather than skipping it.
 */

const CAPABILITY = 'the Web UI'

/**
 * Daily at 23:00 in a zone where 23:00 is more than an hour away, so a real delivery cannot land during the check and
 * turn the empty Records tab into a record. The three zones are eight or more hours apart; one always qualifies.
 */
function quietZone(now = new Date()) {
  for (const zone of ['Asia/Shanghai', 'Europe/London', 'America/New_York']) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]))
    const minutes = Number(parts.hour) * 60 + Number(parts.minute)
    if ((23 * 60 - minutes + 1440) % 1440 > 60) return zone
  }
  return 'Asia/Shanghai'
}

const REMINDER = { prompt: 'review the day', title: 'Daily review', daily: { time: '23:00:00', time_zone: quietZone() } }

async function startServer(steps) {
  const home = isolatedHome('schedule-view')
  const work = fixtureDir('schedule-view-work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps })
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        clearTimeout(limit)
        resolve(match[1])
      }
    }, 50)
    const limit = setTimeout(() => {
      clearInterval(timer)
      child.kill('SIGKILL')
      reject(new Error('the server printed no URL within 15s\n' + out))
    }, 15_000)
    child.on('exit', (code) => {
      clearInterval(timer)
      clearTimeout(limit)
      reject(new Error(`the server exited ${code} before printing a URL\n${out}`))
    })
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const setCookie = handshake.headers.get('set-cookie')
  if (setCookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  const cookie = setCookie.split(';')[0]
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  /**
   * The scripted endpoint reads its script per request and hands steps out by round index within a turn; rewriting it
   * to plain text after the creating turn means a reminder delivered during the check cannot create another one.
   */
  const setScript = (next) => writeFileSync(script, JSON.stringify({ steps: next }))
  return {
    url,
    work,
    cookie,
    api,
    setScript,
    output: () => out,
    close: async () => {
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

test('a reminder the model creates shows as a card, a header clock and a sidebar mark, and the Automation tasks page renames and deletes it', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer([
    { toolCall: { name: 'schedule_create', arguments: REMINDER } },
    { text: 'the reminder is set' },
  ])
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    assert.equal(typeof session, 'string', `a session was opened\nsaw: ${JSON.stringify(opened).slice(0, 300)}`)
    const list = async () => {
      const answer = await server.api(`/api/schedule/list?session=${encodeURIComponent(session)}`)
      assert.equal(answer.status, 200, `the reminder list answered (${answer.status} ${JSON.stringify(answer.body).slice(0, 200)})`)
      assert.ok(Array.isArray(answer.body.reminders), `the list carries reminders\nsaw: ${JSON.stringify(answer.body).slice(0, 300)}`)
      return answer.body.reminders
    }

    // The tool runs inside a real turn: the scripted endpoint asks for `schedule_create`, the loop executes it.
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: server.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'remind me every evening', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()
    server.setScript([{ text: 'noted' }])

    const created = await list()
    assert.equal(created.length, 1, `the model's tool created one reminder\nsaw: ${JSON.stringify(created).slice(0, 400)}`)
    const id = created[0].id
    assert.equal(typeof id, 'string')
    assert.equal(created[0].title, 'Daily review')
    const reminderQuery = `session=${encodeURIComponent(session)}&id=${encodeURIComponent(id)}`

    // Open the session in the page.
    await browser.goto(server.url)
    const sessionRow = `document.querySelector('li[data-session-id=${JSON.stringify(session)}]')`
    await browser.waitFor(`${sessionRow} !== null`, 20_000)
    if ((await browser.evaluate(`${sessionRow}.getAttribute('aria-selected')`)) !== 'true') {
      await browser.evaluate(`(${sessionRow}.querySelector('.row') || ${sessionRow}).click()`)
    }

    // 1. The transcript card in the turn's tail: title, frequency, Open, and the overlay's accessible name.
    const cardSelector = `.schedule-turn-tail[data-turn-tail="schedule-created"] .schedule-card[data-schedule-id=${JSON.stringify(id)}]`
    try {
      await browser.waitFor(`document.querySelector(${JSON.stringify(cardSelector)}) !== null`, 20_000)
    } catch (error) {
      const tails = await browser.evaluate(`JSON.stringify({ tails: document.querySelectorAll('[data-turn-tail]').length, cards: [...document.querySelectorAll('.schedule-card')].map((card) => card.dataset.scheduleId), tools: [...document.querySelectorAll('.tool')].map((row) => [row.dataset.toolName, row.dataset.state]) })`)
      throw new Error(`no created-reminder card for ${id} in the turn's tail\npage: ${tails}\n${error.message}`)
    }
    const card = JSON.parse(await browser.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(cardSelector)})
      return JSON.stringify({
        title: card.querySelector('.schedule-card-title')?.textContent ?? null,
        frequency: card.querySelector('.schedule-card-frequency')?.textContent ?? null,
        buttons: [...card.querySelectorAll('button')].map((button) => button.textContent.trim()),
        overlay: card.querySelector('.schedule-card-open')?.getAttribute('aria-label') ?? null,
      })
    })()`))
    assert.equal(card.title, 'Daily review', 'the card names the task')
    assert.ok(card.frequency?.includes('Daily at 23:00'), `the card states the frequency (saw ${JSON.stringify(card.frequency)})`)
    assert.ok(card.buttons.includes('Open'), `the card carries an "Open" button (saw ${JSON.stringify(card.buttons)})`)
    assert.equal(card.overlay, 'Open task details: Daily review', 'the overlay button is named for the task')

    // Its Open button opens the task's details; the service still holds the one unchanged reminder.
    await browser.evaluate(`[...document.querySelector(${JSON.stringify(cardSelector)}).querySelectorAll('button')].find((button) => button.textContent.trim() === 'Open').click()`)
    await browser.waitFor(`document.getElementById('schedule-drawer')?.hidden === false && document.getElementById('schedule-drawer').dataset.scheduleId === ${JSON.stringify(id)}`, 10_000)
    assert.deepEqual((await list()).map((record) => [record.id, record.title]), [[id, 'Daily review']], 'opening the details writes nothing')
    await browser.evaluate(`document.getElementById('schedule-drawer-close').click()`)
    await browser.waitFor(`document.getElementById('schedule-drawer').hidden === true`, 10_000)
    assert.equal((await list()).length, 1, 'closing the details writes nothing')

    // 2. The session header's clock: one ready reminder is "1 reminder" (the page's "{count} reminder(s)" rule),
    //    and pressing it opens that reminder directly rather than a list.
    await browser.waitFor(`document.getElementById('schedule-reminders') !== null && document.getElementById('schedule-catalog-action')?.hidden === false && /^1 reminder/.test(document.getElementById('schedule-reminders').getAttribute('aria-label') ?? '')`, 20_000)
    const clockLabel = await browser.evaluate(`document.getElementById('schedule-reminders').getAttribute('aria-label')`)
    assert.ok(clockLabel === '1 reminder' || clockLabel === '1 reminder(s)', `the clock counts the one reminder (saw ${JSON.stringify(clockLabel)})`)
    await browser.evaluate(`document.getElementById('schedule-reminders').click()`)
    await browser.waitFor(`document.getElementById('schedule-drawer')?.hidden === false && document.getElementById('schedule-drawer').dataset.scheduleId === ${JSON.stringify(id)}`, 10_000)
    assert.equal(await browser.evaluate(`document.getElementById('schedule-catalog-menu') === null`), true, 'one reminder opens its task, not the popover')
    assert.equal(await browser.evaluate(`document.getElementById('schedule-detail-name')?.value ?? null`), 'Daily review', 'the opened detail is the reminder')
    assert.deepEqual((await list()).map((record) => record.id), [id], 'the clock opened the reminder the service holds')
    await browser.evaluate(`document.getElementById('schedule-drawer-close').click()`)
    await browser.waitFor(`document.getElementById('schedule-drawer').hidden === true`, 10_000)

    // 3. The sidebar mark on the session's own row.
    await browser.waitFor(`${sessionRow}?.querySelector('.schedule-mark[data-session-schedule-mark]') !== null`, 20_000)
    assert.equal((await list()).length, 1, 'the mark stands for the reminder the service holds')

    // 4. The Automation tasks page: one row, opened; the tabs; a rename the service keeps; an empty record list.
    await browser.evaluate(`document.getElementById('automation-tasks').click()`)
    await browser.waitFor(`document.getElementById('schedules-page')?.hidden === false`, 10_000)
    assert.equal(await browser.evaluate(`document.getElementById('schedules-heading').textContent.trim()`), 'Automation tasks')
    await browser.waitFor(`document.querySelectorAll('#schedules-list button.sched-row').length === 1`, 20_000)
    const row = JSON.parse(await browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#schedules-list button.sched-row')]
      return JSON.stringify(rows.map((button) => ({ id: button.dataset.scheduleId, text: button.textContent })))
    })()`))
    assert.equal(row.length, 1)
    assert.ok(row[0].text.includes('Daily review'), `the page lists the task (saw ${JSON.stringify(row[0].text)})`)
    const catalog = await server.api('/api/schedule/catalog')
    assert.equal(catalog.status, 200)
    assert.deepEqual(catalog.body.tasks.map((task) => task.id), [id], 'the page row is the catalog\'s one task')

    await browser.evaluate(`document.querySelector('#schedules-list button.sched-row').click()`)
    await browser.waitFor(`document.getElementById('schedule-drawer')?.hidden === false && document.getElementById('schedule-drawer').dataset.scheduleId === ${JSON.stringify(id)} && document.getElementById('schedule-detail-name') !== null`, 10_000)
    assert.equal(await browser.evaluate(`document.getElementById('schedule-detail-tab-rules') !== null && document.getElementById('schedule-detail-tab-records') !== null`), true, 'the detail has the Rules and Records tabs')
    assert.deepEqual((await list()).map((record) => record.title), ['Daily review'], 'opening the row writes nothing')

    await browser.evaluate(`(() => {
      const name = document.getElementById('schedule-detail-name')
      name.focus()
      name.value = 'Evening review'
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await browser.waitFor(`document.getElementById('schedule-save') instanceof HTMLButtonElement && document.getElementById('schedule-save').disabled === false && document.getElementById('schedule-save-bar')?.hidden === false`, 10_000)
    await browser.evaluate(`document.getElementById('schedule-save').click()`)
    let renamed
    for (let attempt = 0; attempt < 50; attempt += 1) {
      renamed = await list()
      if (renamed[0]?.title === 'Evening review') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.deepEqual(renamed.map((record) => [record.id, record.title]), [[id, 'Evening review']], 'the service keeps the new name')
    assert.equal(renamed[0].prompt, 'review the day', 'the rename leaves the instruction alone')
    await browser.waitFor(`document.querySelector('#schedules-list button.sched-row')?.textContent.includes('Evening review')`, 10_000)

    await browser.evaluate(`document.getElementById('schedule-detail-tab-records').click()`)
    await browser.waitFor(`document.getElementById('schedule-detail-tab-records').getAttribute('aria-selected') === 'true' && (document.getElementById('schedule-detail-panel')?.textContent ?? '').includes('No delivery record available')`, 10_000)
    const history = await server.api(`/api/schedule/history?${reminderQuery}`)
    assert.equal(history.status, 200, `the history answered (${history.status})`)
    assert.deepEqual(history.body.records, [], 'the service has no delivery record either')

    // 5. Delete: More → Delete task → Confirm deletion; the service is empty and the row goes.
    await browser.evaluate(`document.getElementById('schedule-detail-more').click()`)
    await browser.waitFor(`document.getElementById('schedule-detail-menu')?.hidden === false`, 10_000)
    await browser.evaluate(`document.getElementById('schedule-detail-delete').click()`)
    await browser.waitFor(`document.getElementById('schedule-delete')?.open === true`, 10_000)
    assert.equal((await list()).length, 1, 'asking for confirmation deletes nothing')
    await browser.evaluate(`document.getElementById('schedule-delete-confirm').click()`)
    let remaining
    for (let attempt = 0; attempt < 50; attempt += 1) {
      remaining = await list()
      if (remaining.length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.deepEqual(remaining, [], 'the service no longer holds the reminder')
    await browser.waitFor(`document.querySelectorAll('#schedules-list button.sched-row').length === 0`, 10_000)
    await browser.waitFor(`${sessionRow}?.querySelector('.schedule-mark[data-session-schedule-mark]') === null`, 10_000)
    const after = await server.api('/api/schedule/catalog')
    assert.deepEqual(after.body.tasks, [], 'the catalog is empty too')
  } finally {
    await browser.close()
    await server.close()
  }
})
