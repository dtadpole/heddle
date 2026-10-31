import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Font sizes and font lists from Settings (issue #81, slice 1), as DSH's dsh-client-ui-theme rows offer them.
 *
 * The text stepper moves the conversation's text, here the composer draft, by whole pixels within 10-22 from 14. The
 * code stepper and the font lists sit behind More font settings. A change applies at once and is stored in the
 * `ui-theme` row. The server serves the stored values on `<html>` on every request, so the next page has them with no
 * restart, and a reload keeps them. A stepper stops at its bound. The rows follow the interface language (#80).
 */

const CAPABILITY = 'font settings in the Web UI'

function scratchProfile(home) {
  const profile = join(home, 'theme-profile')
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

const DRAFT_SIZE = `getComputedStyle(document.querySelector('#prompt textarea')).fontSize`
/** A code block drawn the way an answer draws one, measured, then removed. */
const CODE_SIZE = `(() => {
  const probe = document.createElement('div')
  probe.className = 'turn assistant markdown'
  probe.innerHTML = '<pre><code>x</code></pre>'
  document.body.append(probe)
  const size = getComputedStyle(probe.querySelector('code')).fontSize
  probe.remove()
  return size
})()`
const ROW_VALUE = (field) => `document.querySelector('#settings-dialog [data-font-size="${field}"] output').textContent`
const STEP = (field, step) => `(() => { document.querySelector('#settings-dialog [data-font-size="${field}"] [data-step="${step}"]').click(); return true })()`
const SERVED = `fetch('/').then((response) => response.text()).then((html) => (/<html [^>]*style="([^"]*)"/.exec(html) || [])[1] ?? '')`
const STORED = `fetch('/api/settings/ui-theme').then((response) => response.json()).then((entry) => entry.value ?? {})`

async function openSettings(browser) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000), 'Settings opens')
}

test('font sizes and font lists change at once, are stored, are served on the next page, and survive a reload', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('theme-fonts')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.querySelector('#prompt textarea') !== null`, 20_000), 'the page is up')
    assert.match(await browser.evaluate(SERVED), /--heddle-content-font-size:14px;--heddle-code-font-size:11px;/, 'DSH\'s defaults are served')
    assert.equal(await browser.evaluate(DRAFT_SIZE), '14px', 'the draft is 14px')
    assert.equal(await browser.evaluate(CODE_SIZE), '12.5px', 'a code block is the page\'s 12.5px at the 11px default')

    await openSettings(browser)
    assert.equal(await browser.evaluate(ROW_VALUE('fontSize')), '14 px')
    await browser.evaluate(STEP('fontSize', 1))
    await browser.evaluate(STEP('fontSize', 1))
    assert.equal(await browser.evaluate(ROW_VALUE('fontSize')), '16 px', 'two steps up')
    assert.equal(await browser.evaluate(DRAFT_SIZE), '16px', 'the draft follows at once')
    assert.ok(await browser.waitFor(`${STORED}.then((value) => value.fontSize === 16)`, 5_000), 'the size is stored in the ui-theme row')
    assert.match(await browser.evaluate(SERVED), /--heddle-content-font-size:16px;/, 'and served on the next page without a restart')

    assert.equal(await browser.evaluate(`document.getElementById('settings-fonts').hidden`), true, 'More font settings starts closed')
    await browser.evaluate(`(() => { document.getElementById('settings-more-fonts').click(); return true })()`)
    await browser.evaluate(STEP('codeFontSize', 1))
    assert.equal(await browser.evaluate(ROW_VALUE('codeFontSize')), '12 px')
    assert.equal(await browser.evaluate(CODE_SIZE), '13.5px', 'a code block grows by the same pixel')
    await browser.evaluate(`(() => {
      const input = document.getElementById('settings-text-font')
      input.focus()
      input.value = "'Inter' , system-ui"
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    assert.equal(await browser.evaluate(`document.documentElement.style.getPropertyValue('--heddle-font-family-text')`), '"Inter", system-ui', 'the list is normalized and applied')
    assert.ok(await browser.waitFor(`${STORED}.then((value) => value.codeFontSize === 12 && value.textFontFamily === '"Inter", system-ui')`, 5_000), 'both are stored')

    await browser.goto(new URL('/', server.url).href)
    assert.ok(await browser.waitFor(`document.querySelector('#prompt textarea') !== null`, 20_000), 'the page reloads')
    assert.equal(await browser.evaluate(DRAFT_SIZE), '16px', 'a reload keeps the text size')
    assert.equal(await browser.evaluate(CODE_SIZE), '13.5px', 'and the code size')
    assert.match(await browser.evaluate(`getComputedStyle(document.body).fontFamily`), /^"?Inter"?, system-ui/, 'and the text font comes first')

    await openSettings(browser)
    for (let step = 0; step < 8; step += 1) await browser.evaluate(STEP('fontSize', 1))
    assert.equal(await browser.evaluate(ROW_VALUE('fontSize')), '22 px', 'the stepper stops at 22')
    assert.equal(await browser.evaluate(`document.querySelector('#settings-dialog [data-font-size="fontSize"] [data-step="1"]').disabled`), true)
    assert.ok(await browser.waitFor(`${STORED}.then((value) => value.fontSize === 22)`, 5_000), 'the last step is the stored one')

    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'zh'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === 'zh-CN'`, 5_000), 'the page is Chinese')
    assert.deepEqual(
      await browser.evaluate(`[
        document.querySelector('[data-i18n="theme.fontSize.text.title"]').textContent,
        document.getElementById('settings-more-fonts').textContent,
        document.querySelector('#settings-dialog [data-font-size="fontSize"] [data-step="-1"]').getAttribute('aria-label'),
      ]`),
      ['字号大小', '更多字体设置', '减小字号'],
      'the font rows are in Chinese',
    )
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
