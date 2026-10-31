import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the workspace dialogs, in DSH's own words where DSH has them
 * (dsh-client-ui-directory-picker-browse: 选择工作区目录, 新建文件夹, 创建, 取消; dsh-client-ui-workspace: 添加工作区,
 * 重命名工作区, 工作区名称, 删除工作区, 正在删除工作区…, its delete description, 重命名会话, 会话名称).
 *
 * In Chinese the folder picker, the Rename workspace and Rename session dialogs and the Delete workspace dialog,
 * including its description written when it opens, are Chinese. English comes back.
 */

const CAPABILITY = 'the workspace dialogs in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'dialogs-profile')
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

const STATIC = `({
  picker: [
    document.getElementById('workspace-picker-title').textContent,
    document.getElementById('workspace-picker-path').getAttribute('aria-label'),
    document.getElementById('workspace-picker-go').textContent,
    document.querySelector('#workspace-picker .ws-meta label span').textContent,
    document.getElementById('workspace-picker-new-folder').textContent,
    document.getElementById('workspace-picker-new-create').textContent,
    document.getElementById('workspace-picker-new-name').getAttribute('placeholder'),
    document.querySelector('#workspace-picker [data-ws-close]:not(.ws-close)').textContent,
    document.getElementById('workspace-picker-add').textContent,
    document.querySelector('#workspace-picker .ws-close').getAttribute('aria-label'),
  ],
  rename: [
    document.getElementById('workspace-rename-title').textContent,
    document.getElementById('workspace-rename-input').getAttribute('aria-label'),
    document.getElementById('workspace-rename-confirm').textContent,
  ],
  session: [
    document.getElementById('session-rename-title').textContent,
    document.getElementById('session-rename-input').getAttribute('aria-label'),
    document.getElementById('session-rename-confirm').textContent,
  ],
  remove: [
    document.getElementById('workspace-delete-title').textContent,
    document.getElementById('workspace-delete-status').textContent,
    document.getElementById('workspace-delete-confirm').textContent,
  ],
})`

/** Open the Delete workspace dialog from the registered row's menu, read its description, and close it. */
async function deleteDescription(browser) {
  await browser.evaluate(`(() => {
    const wrap = [...document.querySelectorAll('#tree .menu-wrap')].find((candidate) => (candidate.querySelector('button')?.getAttribute('aria-label') ?? '').includes('locale-ws'))
    const items = [...wrap.querySelectorAll('.menu [role="menuitem"]')]
    items[items.length - 1].click()
    return true
  })()`)
  await browser.waitFor(`document.getElementById('workspace-delete').open === true`, 5_000)
  const text = await browser.evaluate(`document.getElementById('workspace-delete-desc').textContent`)
  await browser.evaluate(`(() => { document.getElementById('workspace-delete').close(); return true })()`)
  return text
}

async function chooseLanguage(browser, id) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = '${id}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('settings-dialog').close()
    return true
  })()`)
  await browser.waitFor(`document.documentElement.getAttribute('lang') === '${id === 'zh' ? 'zh-CN' : 'en'}'`, 5_000)
}

test('the workspace dialogs follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-dialogs')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const folder = join(home, 'locale-ws')
    mkdirSync(folder, { recursive: true })
    const base = new URL(server.url)
    const registered = await fetch(new URL(`/api/workspaces?token=${base.searchParams.get('token')}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    })
    assert.ok(registered.ok, `the workspace is registered (${registered.status})`)
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    const rowReady = `[...document.querySelectorAll('#tree .menu-wrap')].some((wrap) => (wrap.querySelector('button')?.getAttribute('aria-label') ?? '').includes('locale-ws'))`
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && ${rowReady}`, 20_000), 'the page is up with the workspace row')
    const english = await browser.evaluate(STATIC)
    assert.equal(english.picker[0], 'Select Workspace Directory')
    const englishDelete = await deleteDescription(browser)
    assert.equal(englishDelete, 'This removes “locale-ws” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.')

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(STATIC), {
      picker: ['选择工作区目录', '文件夹路径', '前往', '显示隐藏文件夹', '新建文件夹', '创建', '新文件夹名称', '取消', '添加工作区', '关闭'],
      rename: ['重命名工作区', '工作区名称', '重命名'],
      session: ['重命名会话', '会话名称', '重命名'],
      remove: ['删除工作区', '正在删除工作区…', '删除工作区'],
    }, 'every dialog is Chinese')
    assert.ok(await browser.waitFor(`${rowReady}`, 10_000), 'the tree is redrawn')
    assert.equal(await deleteDescription(browser), '将把“locale-ws”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。', 'the delete description is DSH\'s, word for word')

    await chooseLanguage(browser, 'en')
    assert.deepEqual(await browser.evaluate(STATIC), english, 'and English comes back')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
