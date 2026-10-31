import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: what the Settings dialog writes in its rows, which slice 2 left in English
 * (the server facts, each endpoint's facts, and the empty and failure lines).
 *
 * Choosing 中文 with the dialog open redraws those rows in Chinese at once (developer-ten's N2 on slice 2), and
 * choosing English redraws them back. The machine file declares one endpoint with a key and one without, so both
 * credential words show.
 */

const CAPABILITY = 'the Settings rows in Chinese'

function scratchProfile(home) {
  const profile = join(home, 'settings-rows-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({
      default: 'keyed',
      endpoints: [
        { name: 'keyed', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k', contextWindow: 128000 },
        { name: 'open', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
      ],
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

const ROWS = `({
  terms: [...document.querySelectorAll('#settings-server dt')].map((term) => term.textContent),
  endpoints: [...document.querySelectorAll('#settings-models .settings-endpoint')]
    .filter((item) => ['keyed', 'open'].includes(item.querySelector('.name')?.textContent))
    .map((item) => item.textContent),
})`

test('the Settings rows follow the interface language, redrawn while the dialog is open', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-settings')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is up')
    await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
    assert.ok(
      await browser.waitFor(`[...document.querySelectorAll('#settings-models .settings-endpoint .name')].filter((name) => ['keyed', 'open'].includes(name.textContent)).length === 2`, 10_000),
      'both endpoints of the machine file are listed',
    )
    const english = await browser.evaluate(ROWS)
    assert.deepEqual(english.terms, ['Sandbox', 'Working directory'])
    assert.ok(english.endpoints.some((text) => text.includes('128000 tokens') && text.includes('credential set')), english.endpoints.join(' | '))
    assert.ok(english.endpoints.some((text) => text.includes('no credential')), english.endpoints.join(' | '))

    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'zh'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(
      await browser.waitFor(`[...document.querySelectorAll('#settings-server dt')].map((term) => term.textContent).join() === '沙箱,工作目录'`, 5_000),
      'the server facts are redrawn in Chinese while the dialog stays open',
    )
    const chinese = await browser.evaluate(ROWS)
    assert.ok(chinese.endpoints.some((text) => text.includes('128000 个 token') && text.includes('已设置凭据')), chinese.endpoints.join(' | '))
    assert.ok(chinese.endpoints.some((text) => text.includes('未设置凭据')), chinese.endpoints.join(' | '))
    assert.equal(await browser.evaluate(`document.getElementById('settings-dialog').open`), true, 'the dialog stayed open')

    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'en'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(
      await browser.waitFor(`[...document.querySelectorAll('#settings-server dt')].map((term) => term.textContent).join() === 'Sandbox,Working directory'`, 5_000),
      'and back in English',
    )
    assert.deepEqual(await browser.evaluate(ROWS), english, 'word for word')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
