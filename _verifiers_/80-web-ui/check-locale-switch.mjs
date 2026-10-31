import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language switches from Settings and stays switched (issue #80, slice 2), as DSH's Language row does.
 *
 * The page opens in the language the server serves as `<html lang>`. Choosing 中文 in Settings → General shows the
 * Settings dialog in Chinese at once and writes `locale.preference`, here the `locale` row's `preference`, through
 * the settings API. The server reads the stored choice on every request, so the next page is served as `zh-CN` with
 * no restart, and a reload opens in Chinese. Choosing English switches back. The run's own home holds the default
 * profile, created from the shipped template, so the write lands in a scratch patch.
 */

const CAPABILITY = 'the interface language switch in the Web UI'

function startServer(home) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]), {
        cwd: home,
        env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') },
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

/** What the Settings dialog says, read in one go: its title, headings, the Language row and the close button's name. */
const SETTINGS_READ = `(() => {
  const dialog = document.getElementById('settings-dialog')
  return {
    lang: document.documentElement.getAttribute('lang'),
    title: document.getElementById('settings-title').textContent,
    close: document.getElementById('settings-close').getAttribute('aria-label'),
    headings: [...dialog.querySelectorAll('#settings-body h3')].map((heading) => heading.textContent),
    language: dialog.querySelector('label[for="settings-language"]').textContent,
    options: [...document.getElementById('settings-language').options].map((option) => option.value + '|' + option.textContent),
    selected: document.getElementById('settings-language').value,
    note: document.getElementById('settings-language-note').hidden ? null : document.getElementById('settings-language-note').textContent,
  }
})()`

async function openSettings(browser) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000), 'Settings opens')
}

async function choose(browser, id) {
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = ${JSON.stringify(id)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
}

/** The `<html lang>` the server serves now, asked with this page's cookie and no reload. */
const SERVED_LANG = `fetch('/').then((response) => response.text()).then((html) => (/<html lang="([^"]*)"/.exec(html) || [])[1])`

test('choosing 中文 in Settings shows the dialog in Chinese at once, and the server and a reload keep it', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-switch')
  const server = await startServer(home)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    // An English browser, so the page opens in English whatever the machine's own language is.
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('settings-open') !== null`, 20_000), 'the page is up')

    await openSettings(browser)
    const english = await browser.evaluate(SETTINGS_READ)
    assert.deepEqual(
      english,
      {
        lang: 'en',
        title: 'Settings',
        close: 'Close',
        headings: ['General', 'Server', 'Models', 'Workspaces'],
        language: 'Language',
        options: ['en|English', 'zh|中文'],
        selected: 'en',
        note: null,
      },
      'an English browser opens in English, with each language listed by its own name',
    )

    await choose(browser, 'zh')
    assert.ok(await browser.waitFor(`document.getElementById('settings-title').textContent === '设置'`, 5_000), 'the dialog switches at once')
    const chinese = await browser.evaluate(SETTINGS_READ)
    assert.deepEqual(
      { ...chinese, note: undefined },
      {
        lang: 'zh-CN',
        title: '设置',
        close: '关闭',
        headings: ['通用设置', '服务器', '模型', '工作区'],
        language: '语言',
        options: ['en|English', 'zh|中文'],
        selected: 'zh',
        note: undefined,
      },
      'the dialog, its close button and <html lang> are Chinese; the language names are not translated',
    )
    assert.ok(
      await browser.waitFor(`(async () => (await (await fetch('/api/settings/locale')).json()).value?.preference === 'zh')()`, 5_000),
      `the choice is stored as the locale row's preference (${JSON.stringify(await browser.evaluate(`fetch('/api/settings/locale').then((response) => response.text())`))})`,
    )
    assert.equal(await browser.evaluate(`document.getElementById('settings-language-note').hidden`), true, 'and nothing says it was not saved')
    assert.equal(await browser.evaluate(SERVED_LANG), 'zh-CN', 'the server serves the next page in Chinese without a restart, to an English browser')

    await browser.goto(new URL('/', server.url).href)
    assert.ok(await browser.waitFor(`document.getElementById('settings-open') !== null`, 20_000), 'the page reloads')
    assert.equal(await browser.evaluate(`document.documentElement.getAttribute('lang')`), 'zh-CN', 'a reload opens in Chinese')
    await openSettings(browser)
    assert.equal(await browser.evaluate(`document.getElementById('settings-title').textContent`), '设置')
    assert.equal(await browser.evaluate(`document.getElementById('settings-language').value`), 'zh', 'with 中文 selected')

    await choose(browser, 'en')
    assert.ok(await browser.waitFor(`document.getElementById('settings-title').textContent === 'Settings'`, 5_000), 'English comes back at once')
    assert.equal(await browser.evaluate(`document.documentElement.getAttribute('lang')`), 'en')
    assert.ok(await browser.waitFor(`(async () => (await (await fetch('/')).text()).includes('<html lang="en"'))()`, 5_000), 'and the server serves English again')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
