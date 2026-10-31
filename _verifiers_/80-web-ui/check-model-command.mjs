import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * DSH's `/model` (A103, dsh-client-ui-model-selection): a page command, not a host run. Typed as a whole line it opens a
 * searchable list of the session's models (DSH's popupSelect), and choosing one is the model the next turn runs on. The
 * line itself never reaches the model and records no command row. Its label and description follow the interface
 * language (模型, 选择本会话使用的模型).
 */

const CAPABILITY = 'the /model command'

function scratchProfile(home, baseUrl) {
  const profile = join(home, 'model-command-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({
      default: 'gateway',
      exclude: ['scripted'],
      endpoints: [{
        name: 'gateway', kind: 'openai-chat', baseUrl, model: 'flash', stream: true,
        models: [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }, { id: 'lite', name: 'Lite' }, { id: 'max', name: 'Max' }, { id: 'mini', name: 'Mini' }],
      }],
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

const KEY_CODES = { Enter: 13 }
async function press(browser, key) {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: KEY_CODES[key], ...(key === 'Enter' ? { text: '\r' } : {}) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: KEY_CODES[key] })
}
const FIELD = 'document.querySelector("#prompt textarea")'
async function typeInto(browser, text) {
  await browser.evaluate(`(() => { const field = ${FIELD}; field.focus(); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await browser.send('Input.insertText', { text })
}
const MODEL_ROW = `(() => {
  const menu = document.getElementById('slash-menu')
  const row = menu === null || menu.hidden ? null : menu.querySelector('.hc-row[data-command="model"]')
  return row === null ? null : { label: row.querySelector('.hc-name').textContent, description: row.querySelector('.hc-desc').textContent }
})()`

async function chooseLanguage(browser, id) {
  await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
  // Settings opens once its reads are in; close it only after that, so the composer is not left behind a modal.
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

test('/model opens the model list, the choice is the next turn\'s model, and the line goes nowhere', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('model-command')
  const double = await chatDouble({ content: 'ok' })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('model-label').textContent === 'Flash'`, 20_000), 'the page is up on Flash')

    // The menu offers it in DSH's words.
    await typeInto(browser, '/mod')
    assert.ok(await browser.waitFor(`${MODEL_ROW} !== null`, 10_000), 'the slash menu offers /model')
    assert.deepEqual(await browser.evaluate(MODEL_ROW), { label: 'Model', description: 'Select the model for this conversation' })

    // The whole line opens the model list, search focused.
    await typeInto(browser, '/model')
    await press(browser, 'Enter')
    assert.ok(await browser.waitFor(`!document.getElementById('model-menu').hidden && document.querySelector('#model-menu input[role="searchbox"]') !== null`, 10_000), 'the model list opens')
    assert.equal(await browser.evaluate(`document.activeElement.getAttribute('role')`), 'searchbox', 'with its search focused, as DSH\'s popup')
    assert.equal(await browser.evaluate(`${FIELD}.value`), '', 'the line is consumed')
    await browser.evaluate(`(() => { [...document.querySelectorAll('#model-menu [role="menuitemradio"]')].find((row) => row.innerText.trim().startsWith('Pro')).click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('model-label').textContent === 'Pro'`, 5_000), 'the seat shows the choice')

    await typeInto(browser, 'hello')
    await press(browser, 'Enter')
    assert.ok(await browser.waitFor(`(async () => (await (await fetch('/api/sessions')).json()).length === 1)()`, 20_000), 'the message started a session')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const bodies = double.requests.map((request) => JSON.parse(request.body))
    assert.ok(bodies.length >= 1, 'the model was asked')
    assert.equal(bodies[0].model, 'pro', 'the next turn runs on the model chosen through /model')
    assert.ok(!JSON.stringify(bodies).includes('/model'), 'the /model line never reached the model')
    assert.equal(await browser.evaluate(`document.querySelectorAll('#log .hc-command, #log [data-kind="command"]').length`), 0, 'and drew no command row')

    // A fork names its source as its parent session but is a conversation of its own: /model is offered there too.
    const sessionsNow = await browser.evaluate(`fetch('/api/sessions').then((response) => response.json())`)
    const source = sessionsNow[0].id
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree li[data-row-key="session:${source}"]')
      const fork = [...row.querySelectorAll('.menu [role="menuitem"]')].find((item) => item.textContent.trim() === 'Fork session')
      fork.click()
      return true
    })()`)
    assert.ok(await browser.waitFor(`(async () => (await (await fetch('/api/sessions')).json()).length === 2)()`, 10_000), 'the session is forked')
    const forked = (await browser.evaluate(`fetch('/api/sessions').then((response) => response.json())`)).find((meta) => meta.id !== source)
    assert.equal(forked.parentSession, source, 'the fork names its source as its parent session')
    assert.notEqual(forked.origin, 'subagent', 'and is not a subagent\'s')
    assert.ok(await browser.waitFor(`document.querySelector('#tree li[data-row-key="session:${forked.id}"]') !== null`, 10_000), 'the fork is listed')
    await browser.evaluate(`(() => { const li = document.querySelector('#tree li[data-row-key="session:${forked.id}"]'); (li.querySelector(':scope > .row') ?? li.firstElementChild).click(); return true })()`)
    const forkHeading = typeof forked.title === 'string' && forked.title.length > 0 ? forked.title : forked.id
    assert.ok(
      await browser.waitFor(`document.getElementById('session-title').textContent === ${JSON.stringify(forkHeading)}`, 10_000).catch(() => false),
      `the fork is open (${JSON.stringify(await browser.evaluate(`document.getElementById('session-title').textContent`))} vs ${JSON.stringify(forkHeading)})`,
    )
    await typeInto(browser, '/mod')
    assert.ok(await browser.waitFor(`${MODEL_ROW} !== null`, 10_000).catch(() => false), 'the fork offers /model')

    // In Chinese, DSH's words.
    await chooseLanguage(browser, 'zh')
    await typeInto(browser, '/mod')
    assert.ok(await browser.waitFor(`${MODEL_ROW}?.label === '模型'`, 10_000).catch(() => false), `the menu offers it again, in Chinese (${JSON.stringify(await browser.evaluate(MODEL_ROW))})`)
    assert.deepEqual(await browser.evaluate(MODEL_ROW), { label: '模型', description: '选择本会话使用的模型' })
  } finally {
    browser.close()
    server.kill()
    await double.close()
    removeDir(home)
  }
})
