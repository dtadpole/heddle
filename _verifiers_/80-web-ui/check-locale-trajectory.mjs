import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 17: the Trajectory area in DSH's own Chinese
 * (dsh-client-ui-trajectory's kind.*, turn.label, group.step, tab.*, details.*, timing.*, toolbar.* and timeline copy).
 *
 * A Chinese page's Trajectory reads 事件 / 内容 over rows tagged 用户 / 助手 / 工具 under 第 1 轮, with the toolbar's
 * 时长 / 轮次 / 调用 and 搜索; a tool row's inspector has the tabs 概述 / 参数 / 结果 / Schema / 计时 and the Summary's
 * 层级 and 状态 (已完成). Switched to English in Settings with the inspector open on its Timing tab, the table, the
 * toolbar and the inspector read in English, and the inspector stays on Timing.
 */

const CAPABILITY = 'the Trajectory area in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'trajectory-profile')
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


const WORDS = `JSON.stringify({
  heads: [...document.querySelectorAll('#tr-table thead th')].map((th) => th.textContent),
  sections: [...new Set([...document.querySelectorAll('#tr-table tbody .tr-turn-label')].map((node) => node.textContent))],
  lanes: [...document.querySelectorAll('#timeline .tr-lane-label')].map((label) => label.textContent),
  kinds: [...new Set([...document.querySelectorAll('#tr-table tbody .tr-kind')].map((tag) => tag.textContent))],
  toolbar: ['tr-duration', 'tr-turns', 'tr-calls'].map((id) => [document.getElementById(id).textContent, document.getElementById(id).title]),
  search: [document.getElementById('tr-search-input').placeholder, document.getElementById('tr-search-input').getAttribute('aria-label')],
  timeline: document.getElementById('timeline').getAttribute('aria-label'),
  status: document.getElementById('tr-status').textContent,
  resize: [document.querySelector('.tr-d-resize')?.getAttribute('aria-label'), document.querySelector('.tr-d-resize')?.title],
  tabs: [...document.querySelectorAll('#tr-details .tr-d-tab')].map((tab) => tab.textContent),
  selectedTab: document.querySelector('#tr-details .tr-d-tab[aria-selected=true]')?.textContent ?? null,
  where: document.querySelector('#tr-details .tr-d-head .tr-d-where')?.textContent ?? null,
  close: document.querySelector('#tr-details .tr-d-close')?.getAttribute('aria-label') ?? null,
  terms: [...document.querySelectorAll('#tr-details .tr-d-body dt')].map((term) => term.textContent),
  accordions: [...document.querySelectorAll('#tr-details .tr-d-body summary')].map((summary) => summary.textContent),
  values: [...document.querySelectorAll('#tr-details .tr-d-body dd')].map((value) => value.textContent),
})`

test('the Trajectory area reads in the page language, and follows a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-trajectory')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'one\n')
  const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'the folder holds one file' }] })
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
    const turn = await api('/api/turn', { prompt: 'what is in here', folder: work, session })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)

    browser = await openBrowser({ width: 1440, height: 1000 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await browser.evaluate(`(() => { document.querySelector('#views button[data-view="trajectory"]').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelectorAll('#tr-table tbody tr[data-kind="tool"]').length > 0`, 20_000), 'the table drew the tool row')
    await browser.evaluate(`(() => { document.querySelector('#tr-table tbody tr[data-kind="tool"]').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('tr-details')?.hidden === false && document.querySelectorAll('#tr-details .tr-d-tab').length > 0`, 10_000), 'the inspector opens')

    const chinese = JSON.parse(await browser.evaluate(WORDS))
    assert.deepEqual(chinese.heads, ['事件', '内容'])
    assert.deepEqual(chinese.sections, ['第 1 轮'], JSON.stringify(chinese.sections))
    assert.deepEqual(chinese.lanes, ['输入', '模型', '工具'])
    assert.ok(chinese.kinds.includes('用户') && chinese.kinds.includes('工具'), `the kind tags in DSH's Chinese (${JSON.stringify(chinese.kinds)})`)
    assert.ok(chinese.kinds.every((kind) => !/^[A-Z]+$/.test(kind)), `no English kind tag is left (${JSON.stringify(chinese.kinds)})`)
    assert.deepEqual(chinese.toolbar, [['时长', '使用实际时长'], ['轮次', '收起所有轮次'], ['调用', '收起所有调用']])
    assert.deepEqual(chinese.search, ['搜索', '搜索轨迹'])
    assert.equal(chinese.timeline, '轨迹时间线')
    assert.match(chinese.status, /^\d+ 条记录 · 1 轮/, chinese.status)
    assert.deepEqual(chinese.resize, ['调整事件详情宽度', '拖动调整大小；双击恢复默认值。'])
    assert.deepEqual(chinese.tabs, ['概述', '参数', '结果', 'Schema', '计时'])
    assert.match(chinese.where ?? '', /^第 1 轮( · 第 \d+ 步)?$/, chinese.where)
    assert.equal(chinese.close, '关闭详情')
    assert.deepEqual(chinese.accordions.slice(0, 2), ['层级', '状态'], JSON.stringify(chinese.accordions))
    assert.ok(chinese.terms.includes('轮次') && chinese.terms.includes('状态'), JSON.stringify(chinese.terms))
    assert.ok(chinese.values.includes('已完成'), JSON.stringify(chinese.values))

    // Open the Timing tab, then change the language in Settings with the inspector open.
    await browser.evaluate(`(() => { [...document.querySelectorAll('#tr-details .tr-d-tab')].find((tab) => tab.textContent === '计时').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#tr-details .tr-d-tab[aria-selected=true]')?.textContent === '计时'`, 5_000), 'the Timing tab shows')
    assert.ok(JSON.parse(await browser.evaluate(WORDS)).terms.includes('开始时间'), 'its rows are Chinese')
    await chooseLanguage(browser, 'en', 'en')
    const english = JSON.parse(await browser.evaluate(WORDS))
    assert.deepEqual(english.heads, ['Event', 'Content'])
    assert.deepEqual(english.sections, ['Turn 1'], JSON.stringify(english.sections))
    assert.deepEqual(english.lanes, ['input', 'model', 'tools'])
    assert.ok(english.kinds.includes('USER') && english.kinds.includes('TOOL'), JSON.stringify(english.kinds))
    assert.deepEqual(english.toolbar, [['Duration', 'Use actual duration'], ['Turns', 'Collapse turns'], ['Calls', 'Collapse calls']])
    assert.equal(english.timeline, 'trajectory timeline')
    assert.match(english.status, /^\d+ records · 1 turns/, english.status)
    assert.deepEqual(english.tabs, ['Summary', 'Payload', 'Result', 'Schema', 'Timing'])
    assert.equal(english.selectedTab, 'Timing', 'the inspector stays on the tab it showed')
    assert.ok(english.terms.includes('Started'), JSON.stringify(english.terms))
    assert.match(english.where ?? '', /^Turn 1( · Step \d+)?$/, english.where)
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
