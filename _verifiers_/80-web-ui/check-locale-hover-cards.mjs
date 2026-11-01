import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 16: the sidebar's row hover cards in DSH's own Chinese
 * (dsh-client-ui-workspace's `time.*`, `date.ymd`, `hover.created` and `status.*`, and the schedule plugin's timing copy).
 *
 * A Chinese page's session card says how long ago in DSH's words (刚刚, or N分钟前), its task's timing as
 * 每天 HH:00（UTC+00:00 …）· 11月1日 HH:00 (N小时后), and its status 空闲; a workspace card says 创建于 2026年11月1日 HH:MM.
 * Switched to English in Settings, the next card reads in English again.
 */

const CAPABILITY = 'the row hover cards in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'hover-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the row hover cards read in the page language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-hover')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  /** A daily task six hours from now, in UTC, so it is neither due nor delivered while the check runs. */
  const hour = String((new Date().getUTCHours() + 6) % 24).padStart(2, '0')
  const { config, script } = scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'schedule_create', arguments: { prompt: 'review the week', title: 'Weekly review', daily: { time: `${hour}:00:00`, time_zone: 'UTC' } } } },
      { text: 'reminder set' },
    ],
  })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    const added = await api('/api/workspaces', { path: work })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const turn = await api('/api/turn', { prompt: 'plan the week', folder: work })
    assert.equal(turn.status, 200, `a turn ran in the workspace (${turn.status})`)
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'done' }] }))
    const workspace = (await api('/api/workspaces')).body.workspaces.find((entry) => entry.id === added.body.record.id)
    const sessionId = workspace.sessionIds[0]
    assert.equal(typeof sessionId, 'string', 'the workspace owns the turn\'s session')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    const sessionRow = `#tree li[data-kind="session"][data-session-id="${sessionId}"] > .row`
    const workspaceRow = '#tree > li[data-kind="workspace"] > .row'
    assert.ok(await browser.waitFor(`document.querySelector(${JSON.stringify(sessionRow)}) !== null && document.querySelector(${JSON.stringify(workspaceRow)}) !== null`, 15_000), 'the tree draws the session and its workspace')

    const box = async (selector) =>
      JSON.parse(await browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) }) })()`))
    const move = (x, y) => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    const visibleCard = `(() => { const card = document.querySelector('.hover-card'); return card !== null && !card.hidden ? (card.dataset.hoverCard ?? 'card') : null })()`
    const read = async () =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const card = document.querySelector('.hover-card')
          const texts = (selector) => [...card.querySelectorAll(selector)].map((node) => node.textContent)
          return JSON.stringify({ time: texts('.hover-time'), timing: texts('.hover-task-timing'), statuses: texts('.hover-status') })
        })()`),
      )
    /** Rest on a row until its card shows, after moving away so the dwell starts over. */
    const hover = async (selector, kind) => {
      await move(1100, 700)
      await browser.waitFor(`${visibleCard} === null`, 3_000).catch(() => false)
      await sleep(300)
      const row = await box(selector)
      await move(row.x, row.y)
      assert.ok(await browser.waitFor(`${visibleCard} === ${JSON.stringify(kind)}`, 5_000), `the ${kind} card shows`)
      return read()
    }

    const session = await hover(sessionRow, 'session')
    assert.match(session.time[0] ?? '', /^(刚刚|\d+分钟前)$/, `how long ago, in DSH's Chinese (${JSON.stringify(session.time)})`)
    assert.match(
      session.timing[0] ?? '',
      new RegExp(`^每天 ${hour}:00（UTC\\+00:00(?: · [^）]+)?） · \\d{1,2}月\\d{1,2}日 \\d{2}:\\d{2} \\(\\d+(小时|分钟)后\\)$`),
      `the task's timing in DSH's Chinese, no year (${JSON.stringify(session.timing)})`,
    )
    assert.deepEqual(session.statuses, ['空闲'], 'and its status')

    const created = new Date(workspace.createdAt)
    const pad = (value) => String(value).padStart(2, '0')
    const ws = await hover(workspaceRow, 'workspace')
    assert.deepEqual(ws.time, [`创建于 ${created.getFullYear()}年${created.getMonth() + 1}月${created.getDate()}日 ${pad(created.getHours())}:${pad(created.getMinutes())}`], 'the workspace card\'s creation in DSH\'s Chinese')

    // Switched to English in Settings, the next card reads in English again.
    await move(1100, 700)
    await chooseLanguage(browser, 'en', 'en')
    const english = await hover(sessionRow, 'session')
    assert.match(english.time[0] ?? '', /^(now|\d+min ago)$/, JSON.stringify(english.time))
    assert.match(english.timing[0] ?? '', new RegExp(`^Daily at ${hour}:00 \\(UTC\\+00:00(?: · [^)]+)?\\) · [A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{2}:\\d{2} \\(in \\d+ (hours?|minutes?)\\)$`), JSON.stringify(english.timing))
    assert.deepEqual(english.statuses, ['Idle'])
    const wsEnglish = await hover(workspaceRow, 'workspace')
    assert.deepEqual(wsEnglish.time, [`Created ${created.getFullYear()}-${created.getMonth() + 1}-${created.getDate()} ${pad(created.getHours())}:${pad(created.getMinutes())}`])
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
