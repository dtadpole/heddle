import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 9: the Settings dialog's Configuration forms (A86). With 中文 chosen,
 * the section's note, each entry's Save and Reset, the placeholder for an unset field and the status lines read in
 * Chinese; English comes back with English. A credential's value is never shown in either language, and a server's own
 * reason stays verbatim.
 */

const CAPABILITY = 'web'

function scratchProfile(home) {
  const profile = join(home, 'locale-config-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

async function startServer(home, profile, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--profile', profile]), {
    cwd: home,
    env: { ...process.env, HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        resolve(match[1])
      }
    }, 50)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error(`server did not start\n${out}`))
    }, 20_000)
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  return { url, api, close: () => child.kill('SIGKILL') }
}

/** Open Settings and the tools entry, and resolve once its form is drawn. */
async function openToolsForm(browser) {
  await browser.evaluate('document.getElementById("settings-open").click()')
  await browser.waitFor('document.querySelector(\'#settings-config details[data-ns="tools"]\') !== null', 15_000)
  await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"]\').open = true')
  await browser.waitFor('document.getElementById("setting-tools-bashTimeoutMs") !== null', 10_000)
}

const setField = (browser, value) =>
  browser.evaluate(`(() => {
    const input = document.getElementById('setting-tools-bashTimeoutMs')
    input.value = ${JSON.stringify(String(value))}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)

const statusText = 'document.querySelector(\'#settings-config details[data-ns="tools"] .settings-status\')?.textContent ?? ""'

async function chooseLanguage(browser, id) {
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = '${id}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await browser.waitFor(`document.documentElement.getAttribute('lang') === '${id === 'zh' ? 'zh-CN' : 'en'}'`, 5_000)
}

const FORM = `(() => {
  const entry = document.querySelector('#settings-config details[data-ns="tools"]')
  const form = entry?.querySelector('form')
  if (!form) return null
  const input = document.getElementById('setting-tools-bashTimeoutMs')
  const reset = input?.nextElementSibling
  return {
    note: document.getElementById('settings-config-note').textContent,
    save: form.querySelector('button[type="submit"]')?.textContent ?? null,
    reset: reset !== null && reset !== undefined && reset.hidden === false ? reset.textContent : null,
    resetTitle: reset?.title ?? null,
    status: entry.querySelector('.settings-status')?.textContent ?? '',
  }
})()`

test('the Configuration forms in Settings follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const home = isolatedHome('locale-config')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ok' }] })
  const profile = scratchProfile(home)
  const server = await startServer(home, profile, config)
  const browser = await openBrowser()
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("settings-open") !== null', 20_000)
    await openToolsForm(browser)
    const english = JSON.parse(await browser.evaluate(`JSON.stringify(${FORM})`))
    assert.equal(english.note, 'Changes are written to this profile\u2019s patch.')
    assert.equal(english.save, 'Save')

    // 中文: the forms are drawn again in Chinese, since nothing in them was typed yet.
    await chooseLanguage(browser, 'zh')
    await browser.waitFor(`(${FORM})?.save === '保存'`, 10_000).catch(() => false)
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"]\').open = true')
    const chinese = JSON.parse(await browser.evaluate(`JSON.stringify(${FORM})`))
    assert.equal(chinese.note, '更改会写入此配置档案的补丁文件。', 'the section note')
    assert.equal(chinese.save, '保存', 'Save')

    // Save with nothing changed says so, in Chinese.
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"] form button[type="submit"]\').click()')
    assert.ok(await browser.waitFor(`(${FORM})?.status === '没有更改'`, 5_000).catch(() => false), `nothing changed (${JSON.stringify(await browser.evaluate(FORM))})`)

    // A saved value says how it applies, and the field the profile now sets offers 重置.
    await setField(browser, 47000)
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"] form button[type="submit"]\').click()')
    assert.ok(
      await browser.waitFor(`['已保存；已生效。', '已保存；服务器重启后生效。'].includes((${FORM})?.status)`, 10_000).catch(() => false),
      `the saved line (${JSON.stringify(await browser.evaluate(FORM))})`,
    )
    const saved = JSON.parse(await browser.evaluate(`JSON.stringify(${FORM})`))
    assert.equal(saved.reset, '重置', 'Reset')
    assert.equal(saved.resetTitle, '恢复为此配置档案之下的值')

    // And English again.
    await chooseLanguage(browser, 'en')
    assert.ok(await browser.waitFor(`(${FORM})?.save === 'Save'`, 10_000).catch(() => false), 'English comes back')
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"]\').open = true')
    assert.equal(JSON.parse(await browser.evaluate(`JSON.stringify(${FORM})`)).reset, 'Reset')
  } finally {
    browser.close()
    server.close()
    removeDir(home)
  }
})
