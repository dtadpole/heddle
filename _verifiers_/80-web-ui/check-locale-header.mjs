import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the session header (no session, the Chat and Trajectory tabs, More actions)
 * and the workspace tree's row menus, in DSH's own words where DSH has them (dsh-client-ui-workspace: 新会话, 重命名,
 * 删除工作区; dsh-client-ui-trajectory: 轨迹).
 *
 * In Chinese the empty header, the view tabs and their group, the More actions menu and a workspace row's menu are
 * Chinese at once, and English comes back word for word. The row menu is read from the tree as it is redrawn.
 */

const CAPABILITY = 'the session header and row menus in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'header-profile')
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

const HEADER = `(() => {
  const row = [...document.querySelectorAll('#tree .menu-wrap')].find((wrap) => (wrap.querySelector('button')?.getAttribute('aria-label') ?? '').includes('locale-ws'))
  return {
    title: document.getElementById('session-title').textContent,
    views: document.getElementById('views').getAttribute('aria-label'),
    tabs: [document.getElementById('tab-chat').textContent, document.getElementById('tab-trajectory').textContent],
    more: document.querySelector('#session-more .menu-wrap > button').getAttribute('aria-label'),
    moreItems: [...document.querySelectorAll('#session-more .menu [role="menuitem"]')].map((item) => item.textContent.trim()),
    row: row === undefined ? null : [...row.querySelectorAll('.menu [role="menuitem"]')].map((item) => item.textContent.trim()),
  }
})()`

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

test('the session header and the tree row menus follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-header')
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
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && ${HEADER}.row !== null`, 20_000), 'the page is up with the workspace row')
    const english = await browser.evaluate(HEADER)
    assert.deepEqual(
      { ...english, row: english.row.slice(0, 3) },
      { title: 'No session', views: 'view', tabs: ['Chat', 'Trajectory'], more: 'More actions', moreItems: ['Download session log'], row: ['New session', 'Rename', 'Delete workspace'] },
    )

    await chooseLanguage(browser, 'zh')
    assert.ok(await browser.waitFor(`${HEADER}.row !== null && ${HEADER}.row[0] === '新会话'`, 10_000), 'the tree is redrawn in Chinese')
    const chinese = await browser.evaluate(HEADER)
    assert.deepEqual(
      { ...chinese, row: chinese.row.slice(0, 3) },
      { title: '无会话', views: '视图', tabs: ['对话', '轨迹'], more: '更多操作', moreItems: ['下载会话日志'], row: ['新会话', '重命名', '删除工作区'] },
      'the header, its menu and the row menu are Chinese',
    )

    await chooseLanguage(browser, 'en')
    assert.ok(await browser.waitFor(`${HEADER}.row !== null && ${HEADER}.row[0] === 'New session'`, 10_000), 'and back in English')
    assert.deepEqual(await browser.evaluate(HEADER), english, 'word for word')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
