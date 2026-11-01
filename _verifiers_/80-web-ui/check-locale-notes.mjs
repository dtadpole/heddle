import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 28: the tree note's own sentences, in DSH's Chinese where DSH has the
 * words (dsh-client-ui-workspace's toast.createFailed: 新建会话失败：{message}).
 *
 * A Chinese page names where the next message starts, 将在“work”中开始新对话; a New session whose request the server
 * refuses says 新建会话失败：服务器拒绝了请求（500）; a session chord while the panel shows a file row says
 * 请先选择一个会话——快捷键作用于面板正在显示的那一行. Switched to English in Settings, the redrawn tree's note reads
 * a new conversation in work, and the same two failures read in English.
 */

const CAPABILITY = "the tree note's sentences in the page language"
const ALT = 1
const CTRL = 2
const META = 4

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'notes-profile')
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


async function press(browser, onMac, { code, key, keyCode, modifiers }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const NOTE = `(() => { const note = document.getElementById('tree-note'); return note.hidden ? '' : note.textContent })()`
const workspaceRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.querySelector('.label')?.textContent === 'work')`
const fileRow = `[...document.querySelectorAll('#tree li[data-kind="file"] > .row')].find((row) => row.querySelector('.label')?.textContent === 'notes.txt')`

/** Every POST to /api/sessions is refused with a bare 500, so New session fails without the server's own words. */
const REFUSE_NEW_SESSIONS = `(() => {
  const real = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'POST' && new URL(url, location.href).pathname === '/api/sessions') return Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }))
    return real(input, init)
  }
  return true
})()`

/** New session from the panel, then a session chord on the workspace row; each note as said. */
async function failures(browser, onMac) {
  await browser.evaluate(`(() => { document.getElementById('new-session').click(); return true })()`)
  assert.ok(await browser.waitFor(`${NOTE}.includes('500')`, 10_000), `New session says it failed (${await browser.evaluate(NOTE)})`)
  const refused = await browser.evaluate(NOTE)
  // A file row is what the panel shows; the chord acts on a session row only. The workspace is opened first if it is not.
  await browser.evaluate(`(() => { const row = ${workspaceRow}; if (row.closest('li').dataset.open !== 'true') row.click(); return true })()`)
  assert.ok(await browser.waitFor(`${fileRow} !== undefined`, 10_000), 'the workspace lists its file')
  await browser.evaluate(`(() => { ${fileRow}.click(); return true })()`)
  assert.ok(await browser.waitFor(`document.getElementById('tab-file') !== null`, 10_000), 'the panel shows the file')
  await browser.evaluate(`(() => { document.activeElement?.blur?.(); return true })()`)
  await press(browser, onMac, { code: 'KeyG', key: 'g', keyCode: 71, modifiers: ALT | (onMac ? META : CTRL) })
  assert.ok(await browser.waitFor(`${NOTE} !== '' && ${NOTE} !== ${JSON.stringify(refused)}`, 5_000), `the chord says something (${await browser.evaluate(NOTE)})`)
  return { refused, chord: await browser.evaluate(NOTE) }
}

test("the tree note's sentences read in the page language, and follow a change made in Settings", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-notes')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'notes.txt'), 'a file the panel can show\n')
  const { config } = scriptedConfig({ home, steps: [{ text: 'hello' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const registered = await fetch(new URL('/api/workspaces', server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: work }) })
    assert.equal(registered.status, 200, 'the workspace is registered')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    const onMac = await browser.evaluate(`/darwin|mac|iphone|ipad/i.test(navigator.platform || '')`)
    assert.ok(await browser.waitFor(`${NOTE} !== ''`, 10_000), 'the note names where the next message starts')
    assert.equal(await browser.evaluate(NOTE), '将在“work”中开始新对话')

    await browser.evaluate(REFUSE_NEW_SESSIONS)
    const chinese = await failures(browser, onMac)
    assert.equal(chinese.refused, '新建会话失败：服务器拒绝了请求（500）')
    assert.equal(chinese.chord, '请先选择一个会话——快捷键作用于面板正在显示的那一行')

    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`${NOTE} === 'a new conversation in work'`, 10_000), `the redrawn tree's note reads in English (${await browser.evaluate(NOTE)})`)
    const english = await failures(browser, onMac)
    assert.equal(english.refused, 'New session failed: the server refused it (500)')
    assert.equal(english.chord, 'select a session first — the shortcut acts on the row the panel is showing')
  } finally {
    await browser?.close()
    server.kill()
    removeDir(home)
  }
})
