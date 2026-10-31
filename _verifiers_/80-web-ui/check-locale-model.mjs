import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the model seat and its menu, in DSH's own words
 * (dsh-client-ui-model-selection: 选择模型，当前 …，推理等级 …, 模型与推理等级, 模型 / 推理等级, 搜索模型…, 没有匹配的模型。).
 * Five models, so the model pane offers its search (more than four choices, as DSH's does).
 *
 * In Chinese the seat's accessible name, the menu's name and its Model and Effort rows, the model pane's search field
 * and its empty line are Chinese. Model and level names are the configuration's own and stay as written. English
 * comes back word for word.
 */

const CAPABILITY = 'the model seat in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'model-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  const levels = { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] }
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({
      default: 'gateway',
      exclude: ['scripted'],
      endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'flash', models: [{ id: 'flash', name: 'Flash', reasoning: levels }, { id: 'pro', name: 'Pro', reasoning: levels }, { id: 'lite', name: 'Lite' }, { id: 'max', name: 'Max' }, { id: 'mini', name: 'Mini' }] }],
    }),
  )
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

const SEAT = `({
  name: document.getElementById('model-trigger').getAttribute('aria-label'),
  label: document.getElementById('model-label').textContent,
})`

async function openMenu(browser) {
  await browser.evaluate(`(() => { document.getElementById('model-trigger').click(); return true })()`)
  await browser.waitFor(`!document.getElementById('model-menu').hidden && document.querySelectorAll('#model-menu .cell-label').length > 0`, 5_000)
  const root = await browser.evaluate(`({
    menu: document.getElementById('model-menu').getAttribute('aria-label'),
    rows: [...document.querySelectorAll('#model-menu .cell-label')].map((label) => label.textContent),
  })`)
  await browser.evaluate(`(() => { document.querySelector('#model-menu .model-cell').click(); return true })()`)
  await browser.waitFor(`document.querySelector('#model-menu input[role="searchbox"]') !== null`, 5_000)
  await browser.evaluate(`(() => {
    const field = document.querySelector('#model-menu input[role="searchbox"]')
    field.value = 'zzzz'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const pane = await browser.evaluate(`({
    search: document.querySelector('#model-menu input[role="searchbox"]').getAttribute('placeholder'),
    empty: document.getElementById('model-menu').textContent.includes(${JSON.stringify('')}) ? [...document.querySelectorAll('#model-menu *')].map((node) => node.children.length === 0 ? node.textContent : '').filter((text) => text.trim().length > 0) : [],
  })`)
  await browser.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.getElementById('model-menu').hidden = true; return true })()`)
  return { ...root, ...pane }
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

test('the model seat and its menu follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-model')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('model-label').textContent === 'Flash'`, 20_000), 'the page is up on Flash')
    assert.deepEqual(await browser.evaluate(SEAT), { name: 'Select model, current Flash, reasoning effort Low', label: 'Flash' })
    const englishMenu = await openMenu(browser)
    assert.equal(englishMenu.menu, 'Model and reasoning effort')
    assert.deepEqual(englishMenu.rows, ['Model', 'Effort'])
    assert.equal(englishMenu.search, 'Search models…')
    assert.ok(englishMenu.empty.includes('No matching models.'), englishMenu.empty.join(' | '))

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(SEAT), { name: '选择模型，当前 Flash，推理等级 Low', label: 'Flash' }, 'the seat is named in Chinese at once; the model and level keep their own names')
    const chineseMenu = await openMenu(browser)
    assert.equal(chineseMenu.menu, '模型与推理等级')
    assert.deepEqual(chineseMenu.rows, ['模型', '推理等级'])
    assert.equal(chineseMenu.search, '搜索模型…')
    assert.ok(chineseMenu.empty.includes('没有匹配的模型。'), chineseMenu.empty.join(' | '))

    await chooseLanguage(browser, 'en')
    assert.deepEqual(await browser.evaluate(SEAT), { name: 'Select model, current Flash, reasoning effort Low', label: 'Flash' }, 'and back in English')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
