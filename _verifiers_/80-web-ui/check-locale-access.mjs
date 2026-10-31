import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the access-mode chip, its menu and the Full access confirmation, in DSH's own
 * words (dsh-client-ui-permission-presets: 仅可查看 / 工作区内修改 / 完全权限, 访问模式，当前：…, 确认启用完全权限？).
 *
 * In Chinese the chip's label, accessible name and title, the menu's three modes and the confirmation's title,
 * warning, acknowledgement and buttons are Chinese. A reload keeps them, and English comes back word for word.
 */

const CAPABILITY = 'the access mode in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'access-profile')
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

const ACCESS = `({
  label: document.getElementById('access-label').textContent,
  name: document.getElementById('access').getAttribute('aria-label'),
  title: document.getElementById('access').title,
  menu: [...document.querySelectorAll('#access-menu .label')].map((label) => label.textContent),
  dialog: document.getElementById('access-dialog').getAttribute('aria-label'),
  heading: document.getElementById('access-dialog-title').textContent,
  risk: document.querySelector('#access-dialog .risk').textContent,
  ack: document.querySelector('#access-dialog .ack span').textContent,
  cancel: document.getElementById('access-cancel').textContent,
  enable: document.getElementById('access-enable').textContent,
  close: document.getElementById('access-dialog-close').getAttribute('aria-label'),
})`

const CHINESE = {
  label: '工作区内修改',
  name: '访问模式，当前：工作区内修改',
  title: '此服务器默认运行的沙箱模式（workspace-write）；打开一个会话后可更改',
  menu: ['仅可查看', '工作区内修改', '完全权限'],
  dialog: '确认启用完全权限？',
  heading: '确认启用完全权限？',
  risk: '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
  ack: '我已了解风险，并愿意继续',
  cancel: '取消',
  enable: '启用完全权限',
  close: '关闭',
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

test('the access mode, its menu and the Full access confirmation follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-access')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is up')
    const english = await browser.evaluate(ACCESS)
    assert.deepEqual([english.label, english.menu], ['Workspace Write', ['Read Only', 'Workspace Write', 'Full access']])

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(ACCESS), CHINESE, 'the chip, the menu and the confirmation are Chinese at once')

    await browser.goto(new URL('/', server.url).href)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page reloads')
    assert.deepEqual(await browser.evaluate(ACCESS), CHINESE, 'and a reload keeps them')

    await chooseLanguage(browser, 'en')
    assert.deepEqual(await browser.evaluate(ACCESS), english, 'English comes back word for word')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
