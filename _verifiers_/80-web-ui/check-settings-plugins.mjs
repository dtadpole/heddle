import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Settings → Built-in plugins (inventory A90, slice 2): the read-only plugin list DSH's Settings keeps
 * (dsh-client-ui-settings-plugin-inventory), drawn from GET /api/plugin-inventory.
 *
 * The profile is the shipped tree with `goal-tool` disabled and `todo-tool` given a configuration its schema refuses,
 * as the 05 inventory check builds it. Every row has a card. Only a disabled or failed row carries a tag. A row whose
 * entry id differs from its title shows the id in a chip. A card opens to its module name and status. Search narrows
 * the list. Nothing manages a plugin. The section follows the interface language (#80).
 */

const CAPABILITY = 'the plugin list in Settings'

function scratchProfile(home) {
  const profile = join(home, 'plugins-profile')
  mkdirSync(profile, { recursive: true })
  symlinkSync(join(repoRoot, 'src'), join(profile, 'src'))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8')
  const ids = [...tree.matchAll(/^\s+- id: (\S+)$/gm)].map((match) => match[1])
  writeFileSync(
    join(profile, 'heddle.patch.yml'),
    `${tree}
- patch:
    - id: goal-tool
      disabled: true
    - id: todo-tool
      config:
        allowParallelInProgress: "yes"
    - id: session
      config:
        root: ${join(home, 'sessions')}
`,
  )
  return { profile, ids }
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

const CARD = (id) => `document.querySelector('#settings-plugins [data-entry-id="${id}"]')`
const CARD_TEXT = (id, part) => `${CARD(id)}?.querySelector('${part}')?.textContent ?? null`

test('Settings lists every built-in plugin read-only, tags only what differs, opens a card to its module and status, and follows the language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('settings-plugins')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const { profile, ids } = scratchProfile(home)
  const server = await startServer(['--profile', profile, '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('settings-open') !== null`, 20_000), 'the page is up')
    await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
    assert.ok(
      await browser.waitFor(`document.querySelectorAll('#settings-plugins .settings-plugin').length === ${ids.length}`, 10_000),
      `every row of the tree has a card (${ids.length})`,
    )
    assert.equal(await browser.evaluate(`document.querySelector('#settings-plugins-section h3').textContent`), 'Built-in plugins')

    assert.equal(await browser.evaluate(CARD_TEXT('session', '.title')), 'plugins/session', 'the title is the module name, shortened')
    assert.equal(await browser.evaluate(CARD_TEXT('session', '.tag')), null, 'a plainly enabled row carries no tag')
    assert.equal(await browser.evaluate(CARD_TEXT('session', '.chip')), null, 'nor a chip when the id repeats the title')
    assert.equal(await browser.evaluate(CARD_TEXT('goal-tool', '.tag')), 'Disabled')
    assert.equal(await browser.evaluate(CARD_TEXT('todo-tool', '.tag')), 'Failed')
    assert.equal(await browser.evaluate(CARD_TEXT('context', '.chip')), 'context', 'an id that differs from the title shows in a chip')

    assert.equal(await browser.evaluate(`${CARD('todo-tool')}.querySelector('dl').hidden`), true, 'a card starts closed')
    await browser.evaluate(`(() => { ${CARD('todo-tool')}.querySelector('button').click(); return true })()`)
    assert.deepEqual(
      await browser.evaluate(`[...${CARD('todo-tool')}.querySelectorAll('dd')].map((cell) => cell.textContent)`),
      ['./src/plugins/todo-tool.ts', 'Failed to start'],
      'an opened card names its module and its status',
    )
    assert.equal(
      await browser.evaluate(`document.querySelectorAll('#settings-plugins-section input[type="checkbox"], #settings-plugins-section [role="switch"]').length`),
      0,
      'nothing in the section manages a plugin',
    )

    await browser.evaluate(`(() => {
      const search = document.getElementById('settings-plugins-search')
      search.value = 'todo'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const shown = await browser.evaluate(`[...document.querySelectorAll('#settings-plugins .settings-plugin')].map((card) => card.dataset.entryId)`)
    assert.ok(shown.length > 0 && shown.every((id) => id.includes('todo')), `search narrows the list (${shown.join(', ')})`)
    await browser.evaluate(`(() => {
      const search = document.getElementById('settings-plugins-search')
      search.value = 'no-such-plugin'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    assert.equal(await browser.evaluate(`document.getElementById('settings-plugins-status').textContent`), 'No matching plugins.')
    await browser.evaluate(`(() => {
      const search = document.getElementById('settings-plugins-search')
      search.value = ''
      search.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'zh'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === 'zh-CN'`, 5_000), 'the page is Chinese')
    assert.deepEqual(
      await browser.evaluate(`[
        document.querySelector('#settings-plugins-section h3').textContent,
        document.getElementById('settings-plugins-search').getAttribute('placeholder'),
        ${CARD_TEXT('goal-tool', '.tag')},
        ${CARD_TEXT('todo-tool', '.tag')},
      ]`),
      ['内置插件', '搜索插件', '已停用', '启动失败'],
      'the section is in Chinese',
    )
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
