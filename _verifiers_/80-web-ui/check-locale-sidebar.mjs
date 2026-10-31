import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the navigation panel, in DSH's own words where DSH has them
 * (dsh-client-ui-sidebar's "新建会话", dsh-client-ui-workspace's 工作区 / 搜索会话 / 添加工作区, dsh-client-ui-schedule's
 * 自动化任务, Settings' 设置).
 *
 * In Chinese every visible label and accessible name in the panel is Chinese: the primary action, Automation tasks,
 * the Workspaces header, its search and add buttons, the search field, the tree, the search results and the
 * Settings entry. A reload keeps them, because the server serves the stored language, and English comes back when
 * it is chosen.
 */

const CAPABILITY = 'the navigation panel in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'sidebar-profile')
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

const PANEL = `(() => {
  const label = (id) => document.getElementById(id)
  return {
    newSession: label('new-session-label').textContent,
    newSessionTitle: label('new-session').title,
    automation: label('automation-tasks-label').textContent,
    automationName: label('automation-tasks').getAttribute('aria-label'),
    workspaces: label('workspaces-label').textContent,
    search: label('sidebar-search').getAttribute('aria-label'),
    searchTitle: label('sidebar-search').title,
    add: label('add-workspace').getAttribute('aria-label'),
    addTitle: label('add-workspace').title,
    field: label('session-search').getAttribute('placeholder'),
    fieldName: label('session-search').getAttribute('aria-label'),
    tree: label('tree').getAttribute('aria-label'),
    results: label('search-results').getAttribute('aria-label'),
    settings: label('settings-label').textContent,
    settingsName: label('settings-open').getAttribute('aria-label'),
    settingsTitle: label('settings-open').title,
  }
})()`

const CHINESE = {
  newSession: '新建会话',
  newSessionTitle: '新建会话 (⌥⌘N)',
  automation: '自动化任务',
  automationName: '自动化任务',
  workspaces: '工作区',
  search: '搜索会话',
  searchTitle: '搜索会话 (⌥⌘K)',
  add: '添加工作区',
  addTitle: '将一个文件夹注册为工作区根目录 (⌥⌘O)',
  field: '搜索会话',
  fieldName: '搜索会话名称',
  tree: '工作区文件夹',
  results: '搜索结果',
  settings: '设置',
  settingsName: '设置',
  settingsTitle: '设置 (⌥⌘,)',
}

async function chooseLanguage(browser, id) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  // Settings opens once its reads are in; close it only after that, so no modal is left over the page.
  await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000)
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = '${id}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('settings-dialog').close()
    return true
  })()`)
  await browser.waitFor(`document.documentElement.getAttribute('lang') === '${id === 'zh' ? 'zh-CN' : 'en'}'`, 5_000)
  await browser.waitFor(`document.getElementById('settings-dialog').open === false`, 5_000)
}

test('the navigation panel follows the interface language, and a reload keeps it', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-sidebar')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is up')
    const english = await browser.evaluate(PANEL)
    assert.equal(english.newSession, 'New session')
    assert.equal(english.settings, 'Settings')

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(PANEL), CHINESE, 'every label and name in the panel is Chinese at once')

    await browser.goto(new URL('/', server.url).href)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page reloads')
    assert.deepEqual(await browser.evaluate(PANEL), CHINESE, 'and a reload keeps them')

    await chooseLanguage(browser, 'en')
    assert.deepEqual(await browser.evaluate(PANEL), english, 'English comes back word for word')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
