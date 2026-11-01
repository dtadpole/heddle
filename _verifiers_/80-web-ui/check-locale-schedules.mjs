import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 14: the automation-task pages in DSH's own Chinese
 * (dsh-client-ui-schedule). A Chinese browser's task page reads 自动化任务, with 新建, the 全部 / 已开启 / 已结束
 * filters, 搜索自动化任务, and an empty catalog's 还没有自动化任务，在会话中创建的任务会显示在这里 with 新建自动化任务.
 * A language changed in Settings while a task is open redraws the list and the task's detail in the new language, and
 * keeps the name someone has typed but not saved (developer-ten's M1).
 */

const CAPABILITY = 'the automation-task page in Chinese'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'schedules-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function scratchProfile(home, baseUrl) {
  const profile = profileIn(home)
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({ default: 'slow', endpoints: [{ name: 'slow', kind: 'openai-chat', baseUrl, model: 'm', apiKey: 'k', models: [{ id: 'm', name: 'Main' }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }, { id: 'd', name: 'Delta' }] }] }),
  )
  return profile
}

/** An OpenAI-compatible double that holds each turn for a while before it answers, so a turn is seen running. */
async function slowDouble(holdMs) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'm' }] }))
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, holdMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => { server.closeAllConnections(); server.close() } }
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

test('the automation-task page follows the interface language in DSH\'s words', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-schedules')
  const double = await slowDouble(100)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await browser.evaluate(`(() => { document.getElementById('automation-tasks').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedules-page')?.hidden === false`, 10_000), 'the task page opens')
    assert.ok(await browser.waitFor(`document.querySelector('#schedules-list')?.textContent.includes('还没有自动化任务')`, 10_000).catch(() => false),
      `the empty catalog in DSH's words (${await browser.evaluate(`document.getElementById('schedules-list').textContent`)})`)
    const words = await browser.evaluate(`({
      page: document.getElementById('schedules-page').getAttribute('aria-label'),
      heading: document.getElementById('schedules-heading').textContent,
      fresh: document.querySelector('#schedules-new span').textContent,
      filters: [...document.querySelectorAll('.sched-filter')].map((button) => button.textContent),
      group: document.querySelector('.sched-filters').getAttribute('aria-label'),
      search: document.getElementById('schedules-search').getAttribute('placeholder'),
      searchName: document.getElementById('schedules-search').getAttribute('aria-label'),
      list: document.getElementById('schedules-list').textContent,
    })`)
    assert.equal(words.page, '自动化任务')
    assert.equal(words.heading, '自动化任务')
    assert.equal(words.fresh, '新建')
    assert.deepEqual(words.filters, ['全部', '已开启', '已结束'])
    assert.equal(words.group, '任务状态')
    assert.equal(words.search, '搜索自动化任务')
    assert.equal(words.searchName, '搜索任务')
    assert.ok(words.list.includes('还没有自动化任务，在会话中创建的任务会显示在这里'), words.list)
    assert.ok(words.list.includes('新建自动化任务'), 'with DSH\'s action')
  } finally {
    browser.close()
    server.kill()
    double.close()
    removeDir(home)
  }
})

/** Daily at 23:00 in a zone where 23:00 is more than an hour away, so no delivery lands during the check. */
function quietZone(now = new Date()) {
  for (const zone of ['Asia/Shanghai', 'Europe/London', 'America/New_York']) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]))
    const minutes = Number(parts.hour) * 60 + Number(parts.minute)
    if ((23 * 60 - minutes + 1440) % 1440 > 60) return zone
  }
  return 'Asia/Shanghai'
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

const DETAIL_WORDS = `({
  rules: document.getElementById('schedule-detail-tab-rules')?.textContent,
  records: document.getElementById('schedule-detail-tab-records')?.textContent,
  tabs: document.querySelector('.sched-detail-tabs')?.getAttribute('aria-label'),
  name: document.getElementById('schedule-detail-name')?.value,
  nameLabel: document.getElementById('schedule-detail-name')?.getAttribute('aria-label'),
  save: document.getElementById('schedule-save')?.textContent,
  saveShown: document.getElementById('schedule-save-bar')?.hidden === false,
  list: document.getElementById('schedules-list')?.textContent,
})`

test('a language changed with a task open redraws the list and the detail, and keeps an unsaved name', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-schedules-live')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const reminder = { prompt: 'review the day', title: 'Daily review', daily: { time: '23:00:00', time_zone: quietZone() } }
  const { config, script } = scriptedConfig({ home, steps: [{ toolCall: { name: 'schedule_create', arguments: reminder } }, { text: 'the reminder is set' }] })
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
    const opened = await api('/api/folders/session', { folder: work })
    const parsed = JSON.parse(opened.text)
    const session = parsed.session?.id ?? parsed.id
    assert.equal(typeof session, 'string', `a session was opened (${opened.text.slice(0, 200)})`)
    const turn = await api('/api/turn', { prompt: 'remind me every evening', folder: work, session })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'noted' }] }))
    const listed = JSON.parse((await api(`/api/schedule/list?session=${encodeURIComponent(session)}`)).text)
    assert.deepEqual(listed.reminders?.map((record) => record.title), ['Daily review'], 'the model\'s tool created the task')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'en'`, 20_000), 'an English browser gets the English page')
    await browser.evaluate(`(() => { document.getElementById('automation-tasks').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#schedules-list button.sched-row')?.textContent.includes('Daily review') === true`, 20_000), 'the page lists the task')
    await browser.evaluate(`document.querySelector('#schedules-list button.sched-row').click()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-drawer')?.hidden === false && document.getElementById('schedule-detail-name') !== null`, 10_000), 'the task opens')
    await browser.evaluate(`(() => {
      const name = document.getElementById('schedule-detail-name')
      name.value = 'Evening review'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedule-save-bar')?.hidden === false`, 10_000), 'an edit shows the save bar')
    const english = await browser.evaluate(DETAIL_WORDS)
    assert.deepEqual([english.rules, english.records, english.tabs, english.nameLabel, english.save, english.saveShown], ['Rules', 'Records', 'Task detail views', 'Automation task name', 'Save changes', true])
    assert.ok(english.list.includes('Next scheduled time: '), english.list)

    await chooseLanguage(browser, 'zh', 'zh-CN')
    const chinese = await browser.evaluate(DETAIL_WORDS)
    assert.deepEqual(
      { rules: chinese.rules, records: chinese.records, tabs: chinese.tabs, nameLabel: chinese.nameLabel, save: chinese.save },
      { rules: '规则', records: '任务运行记录', tabs: '任务详情视图', nameLabel: '自动化任务名称', save: '保存修改' },
      'the open detail is drawn again in Chinese',
    )
    assert.equal(chinese.name, 'Evening review', 'the unsaved name survives the redraw')
    assert.equal(chinese.saveShown, true, 'and the save bar still offers it')
    assert.ok(chinese.list.includes('下次计划时间：') && !chinese.list.includes('Next scheduled time'), `the list is drawn again in Chinese (${chinese.list})`)
    assert.equal(await browser.evaluate(`document.getElementById('schedules-heading').textContent`), '自动化任务')

    await chooseLanguage(browser, 'en', 'en')
    const back = await browser.evaluate(DETAIL_WORDS)
    assert.deepEqual([back.rules, back.save, back.name], ['Rules', 'Save changes', 'Evening review'], 'and back in English')
    const after = JSON.parse((await api(`/api/schedule/list?session=${encodeURIComponent(session)}`)).text)
    assert.deepEqual(after.reminders?.map((record) => record.title), ['Daily review'], 'a language change saves nothing')
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
