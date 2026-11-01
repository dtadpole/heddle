import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 15: how a task's timing reads, in DSH's own words
 * (dsh-client-ui-schedule's `frequency.*`, `unit.*`, `relative.*`, `cron.*` copy and its `statesYear` rule).
 *
 * Four tasks the model creates - daily, every two hours, weekly on Monday and Wednesday, and a Monday-to-Friday cron
 * rule - are read in English, and then again after the language is changed to Chinese in Settings, with the page left
 * open: the transcript's task cards, the header clock, the sidebar mark, the popover's rows, the Automation tasks
 * page's rows (每天 23:00（UTC…）, 2小时一次, 每周一、三, 周一至周五, 下次计划时间：10月31日 23:00 (2小时后)), and a
 * task's detail (the 一 … 日 weekday pills named 星期一 …, the 小时 interval unit, and a local validation sentence).
 */

const CAPABILITY = 'task timing in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'frequency-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

/** A zone where 23:00 is more than an hour away, so no delivery lands during the check. */
function quietZone(now = new Date()) {
  for (const zone of ['Asia/Shanghai', 'Europe/London', 'America/New_York']) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]))
    const minutes = Number(parts.hour) * 60 + Number(parts.minute)
    if ((23 * 60 - minutes + 1440) % 1440 > 60) return zone
  }
  return 'Asia/Shanghai'
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', ...args]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL'), output: () => output })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

/** Choose a language in the Settings dialog and close it, as a person does. */
async function chooseLanguage(browser, id, lang) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true && document.getElementById('settings-language') !== null`, 10_000), 'Settings opens with its Language row')
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = ${JSON.stringify(id)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('settings-dialog').close()
    return true
  })()`)
  assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === ${JSON.stringify(lang)}`, 5_000), `the page turns ${lang}`)
}

const TITLES = ['Daily review', 'Queue poll', 'Weekly sync', 'Workday check']

/** Each task's card in the transcript, by title: its frequency and its overlay's accessible name. */
const CARDS = `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.schedule-card')].map((card) => [
  card.querySelector('.schedule-card-title')?.textContent,
  { frequency: card.querySelector('.schedule-card-frequency')?.textContent, overlay: card.querySelector('.schedule-card-open')?.getAttribute('aria-label') },
])))`

/** Each Automation tasks row, by title: the whole row's text. */
const ROWS = `JSON.stringify(Object.fromEntries([...document.querySelectorAll('#schedules-list button.sched-row')].map((row) => [row.querySelector('.sched-row-title')?.textContent, row.textContent])))`

test('task timing reads in the page language, and follows a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-frequency')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const zone = quietZone()
  /** One turn per task, each a `schedule_create` call and a reply, so each turn's tail carries its own card. */
  const creations = [
    ['Daily review', { daily: { time: '23:00:00', time_zone: zone } }],
    ['Queue poll', { every_seconds: 7200 }],
    ['Weekly sync', { weekly: { time: '23:00:00', time_zone: zone, weekdays: [1, 3] } }],
    ['Workday check', { cron: { expression: '0 23 * * 1-5', time_zone: zone } }],
  ]
  const steps = ([title, timing]) => [{ toolCall: { name: 'schedule_create', arguments: { prompt: `${title} prompt`, title, ...timing } } }, { text: `${title} is set` }]
  const { config, script } = scriptedConfig({ home, steps: steps(creations[0]) })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, text: await response.text() }
    }
    await api('/api/workspaces', { path: work })
    const opened = JSON.parse((await api('/api/folders/session', { folder: work })).text)
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')
    for (const creation of creations) {
      writeFileSync(script, JSON.stringify({ steps: steps(creation) }))
      const turn = await api('/api/turn', { prompt: `set up ${creation[0]}`, folder: work, session })
      assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    }
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'noted' }] }))
    const listed = JSON.parse((await api(`/api/schedule/list?session=${encodeURIComponent(session)}`)).text)
    assert.deepEqual(listed.reminders?.map((record) => record.title).sort(), [...TITLES].sort(), `the model's tools created four tasks (${JSON.stringify(listed).slice(0, 300)})`)

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    // A reader zone none of the tasks use, so every rule names its zone.
    await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Honolulu' })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'en'`, 20_000), 'an English browser gets the English page')
    const sessionRow = `document.querySelector('li[data-session-id=${JSON.stringify(session)}]')`
    assert.ok(await browser.waitFor(`${sessionRow} !== null`, 20_000), 'the session is listed')
    if ((await browser.evaluate(`${sessionRow}.getAttribute('aria-selected')`)) !== 'true') await browser.evaluate(`(${sessionRow}.querySelector('.row') || ${sessionRow}).click()`)
    const cardsShown = await browser.waitFor(`document.querySelectorAll('.schedule-card .schedule-card-open').length === 4`, 20_000).catch(() => false)
    assert.ok(cardsShown, `the transcript shows the four task cards (${await browser.evaluate(`JSON.stringify({ cards: document.querySelectorAll('.schedule-card').length, open: document.querySelectorAll('.schedule-card-open').length, tools: [...document.querySelectorAll('.tool')].map((row) => [row.dataset.toolName, row.dataset.state]) })`)})`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-reminders')?.getAttribute('aria-label') === '4 reminders'`, 20_000), 'the header clock counts them')

    // English first: the formatter's English is unchanged.
    const english = JSON.parse(await browser.evaluate(CARDS))
    assert.match(english['Daily review'].frequency, /^Daily at 23:00 \(UTC[+-]\d{2}:\d{2}/)
    assert.equal(english['Queue poll'].frequency, 'Every 2 hours')
    assert.match(english['Weekly sync'].frequency, /^Weekly on Mon, Wed at 23:00 \(UTC/)
    assert.match(english['Workday check'].frequency, /^Monday to Friday at 23:00 \(UTC/)
    assert.equal(english['Daily review'].overlay, 'Open task details: Daily review')
    assert.equal(await browser.evaluate(`${sessionRow}.querySelector('.schedule-mark .sched-visually-hidden')?.textContent ?? null`), '4 scheduled tasks')

    // The language changes in Settings with the session open.
    await chooseLanguage(browser, 'zh', 'zh-CN')
    const chinese = JSON.parse(await browser.evaluate(CARDS))
    assert.match(chinese['Daily review'].frequency, /^每天 23:00（UTC[+-]\d{2}:\d{2} · .*时间）$/, `a daily rule in DSH's Chinese, its zone named in Chinese (${chinese['Daily review'].frequency})`)
    assert.equal(chinese['Queue poll'].frequency, '2小时一次')
    assert.match(chinese['Weekly sync'].frequency, /^每周一、三 23:00（UTC/, chinese['Weekly sync'].frequency)
    assert.match(chinese['Workday check'].frequency, /^周一至周五 23:00（UTC/, chinese['Workday check'].frequency)
    assert.equal(chinese['Daily review'].overlay, '打开任务详情：Daily review')
    assert.equal(await browser.evaluate(`document.getElementById('schedule-reminders').getAttribute('aria-label')`), '4 个提醒')
    assert.equal(await browser.evaluate(`${sessionRow}.querySelector('.schedule-mark .sched-visually-hidden')?.textContent ?? null`), '4 个自动化任务')

    // The header's popover: each row's frequency, next run and accessible names.
    await browser.evaluate(`(() => { document.getElementById('schedule-reminders').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelectorAll('#schedule-catalog-menu li.sched-task').length === 4`, 10_000), 'the popover lists the four tasks')
    const popover = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#schedule-catalog-menu li.sched-task')].map((li) => ({
      open: li.querySelector('.sched-open')?.getAttribute('aria-label'),
      remove: li.querySelector('.sched-delete')?.getAttribute('aria-label'),
      meta: li.querySelector('.sched-meta')?.textContent,
      next: li.querySelector('.sched-next')?.textContent,
    })))`))
    const pollRow = popover.find((row) => row.open === '打开提醒详情：Queue poll')
    assert.ok(pollRow, `the rows are named in Chinese (${JSON.stringify(popover.map((row) => row.open))})`)
    assert.equal(pollRow.remove, '删除提醒：Queue poll')
    assert.equal(pollRow.meta, '2小时一次')
    assert.match(pollRow.next, /^下次运行 \d{1,2}月\d{1,2}日 \d{2}:\d{2}\((?:2小时|1\d{2}分钟)后\)$/, `the next run in DSH's Chinese, no year (${pollRow.next})`)
    await browser.evaluate(`(() => { document.getElementById('schedule-reminders').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-catalog-menu') === null`, 5_000), 'the popover closes')

    // The Automation tasks page's rows.
    await browser.evaluate(`(() => { document.getElementById('automation-tasks').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelectorAll('#schedules-list button.sched-row').length === 4`, 20_000), 'the page lists the four tasks')
    const rows = JSON.parse(await browser.evaluate(ROWS))
    assert.match(rows['Queue poll'], /2小时一次/, rows['Queue poll'])
    assert.match(rows['Queue poll'], /下次计划时间：\d{1,2}月\d{1,2}日 \d{2}:\d{2}/, rows['Queue poll'])
    assert.match(rows['Queue poll'], /(?:2小时|1\d{2}分钟)后/, rows['Queue poll'])
    assert.match(rows['Weekly sync'], /每周一、三 23:00（UTC/, rows['Weekly sync'])
    assert.doesNotMatch(Object.values(rows).join(' '), /Every|Weekly on|Daily at|Monday to Friday|Next scheduled|\bin \d/, 'no English timing is left on the page')

    // A weekly task's detail: DSH's weekday pills.
    await browser.evaluate(`[...document.querySelectorAll('#schedules-list button.sched-row')].find((row) => row.textContent.includes('Weekly sync')).click()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-detail-name')?.value === 'Weekly sync' && document.querySelectorAll('#schedule-weekdays .sched-pill').length === 7`, 10_000), 'the weekly task opens with its weekday pills')
    const pills = JSON.parse(await browser.evaluate(`JSON.stringify({
      group: document.getElementById('schedule-weekdays').getAttribute('aria-label'),
      text: [...document.querySelectorAll('#schedule-weekdays .sched-pill')].map((pill) => pill.textContent),
      names: [...document.querySelectorAll('#schedule-weekdays .sched-pill')].map((pill) => pill.getAttribute('aria-label')),
      pressed: [...document.querySelectorAll('#schedule-weekdays .sched-pill[aria-pressed=true]')].map((pill) => pill.dataset.weekday),
    })`))
    assert.deepEqual(pills, { group: '星期', text: ['一', '二', '三', '四', '五', '六', '日'], names: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'], pressed: ['1', '3'] })

    // The every-two-hours task: its unit word, and a local validation sentence.
    await browser.evaluate(`[...document.querySelectorAll('#schedules-list button.sched-row')].find((row) => row.textContent.includes('Queue poll')).click()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-detail-name')?.value === 'Queue poll' && document.querySelector('.sched-interval-unit') !== null`, 10_000), 'the interval task opens')
    assert.equal(await browser.evaluate(`document.querySelector('.sched-interval-unit').textContent`), '小时')
    await browser.evaluate(`(() => {
      const name = document.getElementById('schedule-detail-name')
      name.value = ''
      name.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-save-failure')?.hidden === false`, 5_000), 'an empty name is refused before Save')
    assert.equal(await browser.evaluate(`document.getElementById('schedule-save-failure').textContent`), '请输入不超过 120 个字符的任务名称')

    // And back to English, live: the detail's unit and the rows follow.
    await chooseLanguage(browser, 'en', 'en')
    assert.equal(await browser.evaluate(`document.querySelector('.sched-interval-unit').textContent`), 'hours')
    assert.equal(await browser.evaluate(`document.getElementById('schedule-save-failure').textContent`), 'Enter a task name of at most 120 characters.')
    assert.match(JSON.parse(await browser.evaluate(ROWS))['Queue poll'], /Every 2 hours/)
    const after = JSON.parse((await api(`/api/schedule/list?session=${encodeURIComponent(session)}`)).text)
    assert.deepEqual(after.reminders?.map((record) => record.title).sort(), [...TITLES].sort(), 'reading and switching saved nothing')
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
