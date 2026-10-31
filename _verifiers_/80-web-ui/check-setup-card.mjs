import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * First-run setup (#74): a fresh home, started as a new user starts it (no profile, no machine file), has only the
 * shipped offline fixture, so the empty state says how to connect a model instead of leaving the first message to fail.
 * Once the machine file declares an endpoint, Check again re-reads the list and the card goes. The card follows the
 * interface language.
 */

const CAPABILITY = 'the first-run setup card'

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

const CARD = `({
  hidden: document.getElementById('setup-card').hidden,
  drawn: getComputedStyle(document.getElementById('setup-card')).display !== 'none',
  title: document.getElementById('setup-title').textContent,
  recheck: document.getElementById('setup-recheck').textContent,
})`

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

test('a fresh install shows how to connect a model until the machine file declares one', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('setup-card')
  const heddleHome = join(home, '.heddle')
  const env = { HOME: home, HEDDLE_HOME: heddleHome, HEDDLE_CONFIG: '' }
  const server = await startServer(['--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(
      await browser.waitFor(`document.body.dataset.ready === 'true' && !document.getElementById('empty-state').hidden && !document.getElementById('setup-card').hidden`, 20_000),
      `the empty state shows the setup card\n${JSON.stringify(await browser.evaluate(`fetch('/api/endpoints').then((response) => response.text())`))}`,
    )
    assert.deepEqual(await browser.evaluate(CARD), { hidden: false, drawn: true, title: 'Connect a model', recheck: 'Check again' })

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(CARD), { hidden: false, drawn: true, title: '连接模型', recheck: '重新检查' }, 'in Chinese at once')
    await chooseLanguage(browser, 'en')

    mkdirSync(heddleHome, { recursive: true })
    writeFileSync(
      join(heddleHome, 'heddle.json'),
      JSON.stringify({ default: 'mine', exclude: ['scripted'], endpoints: [{ name: 'mine', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }] }),
    )
    await browser.evaluate(`(() => { document.getElementById('setup-recheck').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('setup-card').hidden`, 10_000), 'with a model declared, the card goes without a restart')
    assert.equal(await browser.evaluate(`getComputedStyle(document.getElementById('setup-card')).display`), 'none')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
