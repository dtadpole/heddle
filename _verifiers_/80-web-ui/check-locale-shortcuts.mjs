import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 23: the Keyboard shortcuts reference in DSH's own Chinese where DSH has
 * the words (dsh-client-ui-shortcuts' title, search, application / input, unbound, record, reset-title and reset-saved;
 * the commands' names from the packages that own them: 新建会话, 搜索会话, 添加工作区, 重命名会话, 分叉会话, 归档会话, 打开设置).
 *
 * A Chinese page's reference is 快捷键 with 应用操作 and 消息输入; a search by a command's English name still finds it;
 * recording a chord says 正在为「重命名会话」录制快捷键，按 Esc 取消。, refuses a bare key with 快捷键须以 ⌘ 开头。 (Ctrl elsewhere)
 * and 换一个试试, and Escape says 已取消录制。; Restore all defaults asks 恢复全部默认快捷键？. Switched to English in Settings
 * with the reference open, its rows read in English, and so does the recorder.
 */

const CAPABILITY = 'the keyboard shortcuts reference in the page language'
const CTRL = 2
const META = 4

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'shortcuts-profile')
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


async function press(browser, onMac, { code, key, keyCode, modifiers }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const READ = `JSON.stringify({
  title: document.getElementById('shortcut-reference-title').textContent,
  close: document.querySelector('#shortcut-reference [data-ws-close]').getAttribute('aria-label'),
  search: document.getElementById('shortcut-reference-search').getAttribute('aria-label'),
  placeholder: document.getElementById('shortcut-reference-search').placeholder,
  groups: [...document.querySelectorAll('#shortcut-reference-list .group')].map((node) => node.textContent),
  commands: [...document.querySelectorAll('#shortcut-reference-list .shortcut-row[data-action] .label')].map((node) => node.textContent),
  fixed: [...document.querySelectorAll('#shortcut-reference-list .shortcut-row[data-fixed] .label')].map((node) => node.textContent),
  restoreAll: document.querySelector('#shortcut-restore-all [data-i18n]').textContent,
  status: document.getElementById('shortcut-reference-status').textContent,
  recording: document.querySelector('#shortcut-reference-list kbd[data-recording]')?.textContent ?? null,
})`
const read = async (browser) => JSON.parse(await browser.evaluate(READ))
const search = (browser, text) => browser.evaluate(`(() => { const field = document.getElementById('shortcut-reference-search'); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

/** Record on Rename session: start, refuse a bare key, then cancel with Escape; each step's words. */
async function recorder(browser, onMac) {
  await search(browser, '')
  await browser.evaluate(`(() => { document.querySelector('#shortcut-reference-list .shortcut-row[data-action="rename"]').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.querySelector('#shortcut-reference-list kbd[data-recording]') !== null`, 5_000), 'the row records')
  const started = await read(browser)
  await press(browser, onMac, { code: 'KeyE', key: 'e', keyCode: 69, modifiers: 0 })
  assert.ok(await browser.waitFor(`document.querySelector('#shortcut-reference-list kbd[data-error]') !== null`, 5_000), 'a bare key is refused')
  const refused = await read(browser)
  await press(browser, onMac, { code: 'Escape', key: 'Escape', keyCode: 27, modifiers: 0 })
  assert.ok(await browser.waitFor(`document.querySelector('#shortcut-reference-list kbd[data-recording]') === null && document.getElementById('shortcut-reference').open`, 5_000), 'Escape ends the recording and keeps the reference')
  const cancelled = await read(browser)
  return { started, refused, cancelled }
}

test('the keyboard shortcuts reference reads in the page language, and follows a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-shortcuts')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'hello' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    await api('/api/workspaces', { path: work })
    const opened = (await api('/api/folders/session', { folder: work })).body
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    const onMac = await browser.evaluate(`/darwin|mac|iphone|ipad/i.test(navigator.platform || '')`)
    await browser.evaluate(`(() => { document.activeElement?.blur?.(); return true })()`)
    await press(browser, onMac, { code: 'Slash', key: '/', keyCode: 191, modifiers: onMac ? META : CTRL })
    assert.ok(await browser.waitFor(`document.getElementById('shortcut-reference').open === true`, 5_000), 'Mod+/ opens the reference')

    const chinese = await read(browser)
    assert.equal(chinese.title, '快捷键')
    assert.equal(chinese.close, '关闭')
    assert.equal(chinese.search, '搜索快捷键')
    assert.equal(chinese.placeholder, '按操作或按键搜索')
    assert.deepEqual(chinese.groups, ['应用操作', '消息输入'])
    assert.deepEqual(chinese.commands, ['快捷键', '新建会话', '展开／收起侧边栏', '搜索会话', '添加工作区', '重命名会话', '分叉会话', '归档会话', '打开设置'])
    assert.deepEqual(chinese.fixed, ['发送消息', '换行', '停止生成'])
    assert.equal(chinese.restoreAll, '恢复全部默认')
    await search(browser, 'Fork session')
    assert.deepEqual((await read(browser)).commands, ['分叉会话'], "a command's English name still finds it")
    const zh = await recorder(browser, onMac)
    assert.equal(zh.started.status, '正在为「重命名会话」录制快捷键，按 Esc 取消。')
    assert.equal(zh.started.recording, '按下快捷键…')
    assert.equal(zh.refused.status, onMac ? '快捷键须以 ⌘ 开头。' : '快捷键须以 Ctrl 开头。')
    assert.equal(zh.refused.recording, '换一个试试')
    assert.equal(zh.cancelled.status, '已取消录制。')
    await browser.evaluate(`(() => { document.getElementById('shortcut-restore-all').click(); return true })()`)
    const confirm = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#shortcut-restore-confirm > *')].map((node) => node.textContent))`))
    assert.deepEqual(confirm, ['恢复全部默认快捷键？', '取消', '恢复'])
    await browser.evaluate(`(() => { document.getElementById('shortcut-restore-cancel').click(); return true })()`)

    // The reference stays open while the language changes in Settings.
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.getElementById('shortcut-reference').open === true && document.querySelector('#shortcut-reference-list .group')?.textContent === 'Commands'`, 10_000), 'the open reference redraws in English')
    const english = await read(browser)
    assert.equal(english.title, 'Keyboard shortcuts')
    assert.equal(english.close, 'Close')
    assert.equal(english.search, 'Search shortcuts')
    assert.equal(english.placeholder, 'Search by action or key')
    assert.deepEqual(english.groups, ['Commands', 'Message input'])
    assert.deepEqual(english.commands, ['Keyboard shortcuts', 'New session', 'Toggle sidebar', 'Search sessions', 'Add workspace', 'Rename session', 'Fork session', 'Archive session', 'Open settings'])
    assert.deepEqual(english.fixed, ['Send message', 'Insert a new line', 'Stop the current response'])
    assert.equal(english.restoreAll, 'Restore all defaults')
    const en = await recorder(browser, onMac)
    assert.equal(en.started.status, 'Recording a shortcut for Rename session. Escape cancels.')
    assert.equal(en.started.recording, 'Press a shortcut…')
    assert.equal(en.refused.status, onMac ? 'A shortcut starts with ⌘.' : 'A shortcut starts with Ctrl.')
    assert.equal(en.refused.recording, 'Try another')
    assert.equal(en.cancelled.status, 'Recording cancelled.')
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
