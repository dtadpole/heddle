import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Open configuration file (A95), DSH's settings-header action: on a page on this machine whose run has a profile patch,
 * Settings offers it, and pressing it opens the patch in the person's editor (HEDDLE_OPEN_COMMAND records it here). Its
 * words follow the interface language (打开配置文件).
 */

const CAPABILITY = 'the Open configuration file action'

function scratchProfile(home) {
  const profile = join(home, 'document-profile')
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

async function chooseLanguage(browser, id) {
  await browser.evaluate(`(() => {
    const select = document.getElementById('settings-language')
    select.value = '${id}'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await browser.waitFor(`document.documentElement.getAttribute('lang') === '${id === 'zh' ? 'zh-CN' : 'en'}'`, 5_000)
}

test('Settings offers Open configuration file on this machine, and it opens the profile patch', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('settings-document')
  const script = join(home, 'open-recorder.sh')
  const record = join(home, 'opened.txt')
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${record}"\n`)
  chmodSync(script, 0o755)
  const profile = scratchProfile(home)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json'), HEDDLE_OPEN_COMMAND: script }
  const server = await startServer(['--profile', profile, '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is up')
    assert.match(await browser.evaluate('location.hostname'), /^127\./, 'the page is on this machine')
    await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true && !document.getElementById('settings-document').hidden`, 10_000), 'Settings offers the action')
    assert.equal(await browser.evaluate(`document.getElementById('settings-document').textContent`), 'Open configuration file')

    await browser.evaluate(`(() => { document.getElementById('settings-document').click(); return true })()`)
    const until = Date.now() + 5_000
    while (Date.now() < until && !existsSync(record)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.ok(existsSync(record), 'the opener was started')
    assert.equal(readFileSync(record, 'utf8').trim(), join(profile, 'heddle.patch.yml'), 'with the profile patch')
    assert.equal(await browser.evaluate(`document.getElementById('settings-document-error').hidden`), true, 'and no error')

    await chooseLanguage(browser, 'zh')
    assert.equal(await browser.evaluate(`document.getElementById('settings-document').textContent`), '打开配置文件', 'in DSH\'s Chinese')
    assert.equal(await browser.evaluate(`document.getElementById('settings-document-error').textContent`), '无法打开配置文件')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
