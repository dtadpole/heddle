import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 25: the right sidebar and its Browser tab (#86) in DSH's own Chinese
 * where DSH has the words (dsh-client-ui-sidebar-browser: 浏览器, 前往, 在系统浏览器中打开, its `error.*` refusals and
 * 页面已跳转; dsh-client-ui-sidebar-right: 收起右侧边栏).
 *
 * A Chinese page with the Browser enabled names the entry point, the sidebar, its tab list, + and ✕ in Chinese; a tab
 * opened there reads in Chinese down to its toolbar, and a refused `javascript:` address says
 * 只支持 HTTP 和 HTTPS 地址；本地文件请从工作区文件树打开。; a page that moves itself is marked with 页面已跳转. Switched to
 * English in Settings with the tab open, every one of those words, the standing notice included, reads in English, and
 * a tab opened afterwards is English from the start.
 */

const CAPABILITY = 'the right sidebar and its Browser tab in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'browser-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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
  })
}

/** A loopback page that moves itself once it has loaded, the second `load` a tab cannot read. */
async function startPages() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname
    const send = (html) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    }
    if (path === '/moves') return send(`<!doctype html><title>moves</title><script>setTimeout(() => { location.href = '/moved' }, 50)</script>`)
    if (path === '/moved') return send('<!doctype html><title>moved</title><p>moved</p>')
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) }
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

/** The sidebar's own controls, and every word of the active tab. */
const READ = `JSON.stringify((() => {
  const named = (element) => ({ name: element.getAttribute('aria-label'), tip: element.getAttribute('title') })
  const panel = document.querySelector('#rs-body .browser-tab:not([hidden])')
  const pick = (name) => panel?.querySelector('[data-browser="' + name + '"]') ?? null
  const active = document.querySelector('#rs-tabs [role="tab"][aria-selected="true"]')
  const notice = pick('notice')
  return {
    entry: named(document.getElementById('browser-open')),
    sidebar: document.getElementById('right-sidebar').getAttribute('aria-label'),
    tablist: document.getElementById('rs-tabs').getAttribute('aria-label'),
    add: named(document.getElementById('rs-new')),
    hide: named(document.getElementById('rs-close')),
    tab: active === null ? null : active.textContent,
    close: active === null ? null : named(active.parentElement.querySelector('.rs-tab-close')),
    bar: panel === null ? null : panel.querySelector('form').getAttribute('aria-label'),
    back: pick('back') === null ? null : named(pick('back')),
    forward: pick('forward') === null ? null : named(pick('forward')),
    reload: pick('reload') === null ? null : named(pick('reload')),
    external: pick('external') === null ? null : named(pick('external')),
    address: pick('address') === null ? null : { name: pick('address').getAttribute('aria-label'), placeholder: pick('address').placeholder },
    go: pick('go')?.textContent ?? null,
    start: panel?.querySelector('.browser-start')?.textContent ?? null,
    notice: notice === null || notice.hidden ? '' : notice.textContent,
  }
})())`
const read = async (browser) => JSON.parse(await browser.evaluate(READ))

/** Type into the active tab's address bar and submit it, as Enter does. */
function submit(browser, address) {
  return browser.evaluate(`(() => {
    const panel = document.querySelector('#rs-body .browser-tab:not([hidden])')
    panel.querySelector('[data-browser="address"]').value = ${JSON.stringify(address)}
    panel.querySelector('form').requestSubmit()
    return true
  })()`)
}

const CHINESE_CHROME = {
  entry: { name: '浏览器', tip: '浏览器' },
  sidebar: '右侧边栏',
  tablist: '右侧边栏标签页',
  add: { name: '新建浏览器标签页', tip: '新建浏览器标签页' },
  hide: { name: '收起右侧边栏', tip: '收起' },
}
const CHINESE_TAB = {
  close: { name: '关闭标签页', tip: '关闭标签页' },
  bar: '浏览器导航',
  back: { name: '后退', tip: '后退' },
  forward: { name: '前进', tip: '前进' },
  reload: { name: '重新加载', tip: '重新加载' },
  external: { name: '在系统浏览器中打开', tip: '在系统浏览器中打开' },
  address: { name: '地址', placeholder: '输入 HTTP(S) 地址' },
  go: '前往',
}
const ENGLISH_CHROME = {
  entry: { name: 'Browser', tip: 'Browser' },
  sidebar: 'Right sidebar',
  tablist: 'Right sidebar tabs',
  add: { name: 'New browser tab', tip: 'New browser tab' },
  hide: { name: 'Hide the right sidebar', tip: 'Hide' },
}
const ENGLISH_TAB = {
  close: { name: 'Close tab', tip: 'Close tab' },
  bar: 'Browser navigation',
  back: { name: 'Back', tip: 'Back' },
  forward: { name: 'Forward', tip: 'Forward' },
  reload: { name: 'Reload', tip: 'Reload' },
  external: { name: 'Open in system browser', tip: 'Open in system browser' },
  address: { name: 'Address', placeholder: 'Enter an HTTP(S) address' },
  go: 'Go',
}
const pickKeys = (state, model) => Object.fromEntries(Object.keys(model).map((key) => [key, state[key]]))

test('the right sidebar and its Browser tab read in the page language, and follow a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-browser')
  const { config } = scriptedConfig({ home, steps: [{ text: 'hello' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config, HEDDLE_WEB_BROWSER: '1' }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const pages = await startPages()
  let browser = null
  try {
    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    assert.ok(await browser.waitFor(`document.getElementById('browser-open').hidden === false`, 5_000), 'the enabled Browser shows its entry point')

    // The entry point and the sidebar's chrome, before any tab exists.
    assert.deepEqual(pickKeys(await read(browser), CHINESE_CHROME), CHINESE_CHROME)

    await browser.evaluate(`(() => { document.getElementById('browser-open').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('right-sidebar').hidden === false && document.querySelectorAll('#rs-tabs [role="tab"]').length === 1`, 5_000), 'the entry point opens a first tab')
    const opened = await read(browser)
    assert.deepEqual(pickKeys(opened, CHINESE_TAB), CHINESE_TAB)
    assert.equal(opened.tab, '浏览器', 'a tab with no page yet is named for its kind')
    assert.equal(opened.start, '输入 HTTP(S) 地址开始浏览')

    await submit(browser, 'javascript:alert(1)')
    assert.ok(await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="notice"]').hidden === false`, 5_000), 'a script address is refused')
    assert.equal((await read(browser)).notice, '只支持 HTTP 和 HTTPS 地址；本地文件请从工作区文件树打开。')
    await submit(browser, 'https://user:secret@example.com/')
    assert.ok(await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="notice"]').textContent === '地址不能包含用户名或密码。'`, 5_000), `an address with credentials is refused in Chinese (${(await read(browser)).notice})`)

    // A page that moves itself: the tab says it cannot read the new address.
    await submit(browser, `${pages.base}/moves`)
    assert.ok(await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="address"]')?.dataset.address === 'unknown'`, 10_000), 'the moved page is marked unknown')
    assert.equal((await read(browser)).notice, '页面已跳转；此标签页无法读取新的 URL。')

    // The language changes in Settings with the tab open; the standing notice is said again.
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="go"]')?.textContent === 'Go'`, 5_000), 'the open tab redraws in English')
    const switched = await read(browser)
    assert.deepEqual(pickKeys(switched, ENGLISH_CHROME), ENGLISH_CHROME)
    assert.deepEqual(pickKeys(switched, ENGLISH_TAB), ENGLISH_TAB)
    assert.equal(switched.notice, 'The page navigated; this tab cannot read its new URL.')
    await submit(browser, 'file:///etc/hosts')
    assert.ok(await browser.waitFor(`document.querySelector('#rs-body .browser-tab:not([hidden]) [data-browser="notice"]').textContent.startsWith('Only HTTP')`, 5_000), 'a file address is refused in English')
    assert.equal((await read(browser)).notice, 'Only HTTP and HTTPS addresses are supported; open local files from the workspace tree.')

    // A tab opened after the switch is English from the start.
    await browser.evaluate(`(() => { document.getElementById('rs-new').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelectorAll('#rs-tabs [role="tab"]').length === 2`, 5_000), '+ opens a second tab')
    const second = await read(browser)
    assert.deepEqual(pickKeys(second, ENGLISH_TAB), ENGLISH_TAB)
    assert.equal(second.tab, 'Browser')
    assert.equal(second.start, 'Enter an HTTP(S) address to start browsing')
    assert.equal(second.notice, '')
  } finally {
    await browser?.close()
    await pages.close()
    server.kill()
    removeDir(home)
  }
})
