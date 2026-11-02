import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 29: the file panel's own words and the composer's insert menu, in DSH's
 * Chinese where DSH has the words (dsh-client-ui-sidebar-files' loading: 正在读取…).
 *
 * A Chinese page shows a two-line file headed "… · 2 行", a file past the preview limit with 仅显示前 …, and an HTML file
 * as 预览 — here with its sanitiser blocked, so it says 净化器未能加载，因此此文档以源码显示. A read that never gets an answer
 * says 无法读取此文件：offline, and a bare 500 服务器返回了 500. The insert menu's empty folder says 这里没有可插入的内容
 * under ↑ 上一级. Switched to English in Settings with the file open, the panel draws it again ("· 2 lines"), and the
 * same failures and the menu read in English.
 */

const CAPABILITY = "the file panel's words in the page language"

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'file-panel-profile')
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


const HEAD = `(document.getElementById('file-head')?.textContent ?? '')`
const BODY = `(document.getElementById('file-body')?.textContent ?? '')`
const fileRow = (label) => `[...document.querySelectorAll('#tree li[data-kind="file"] > .row')].find((row) => row.querySelector('.label')?.textContent === ${JSON.stringify(label)})`
const workspaceRow = `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.querySelector('.label')?.textContent === 'work')`

/** Every read of /api/file answers `mode`: 'offline' rejects, a number is a bare status, 'real' gives fetch back. */
const fileReads = (mode) => `(() => {
  window.__fpFetch = window.__fpFetch ?? window.fetch.bind(window)
  const mode = ${JSON.stringify(mode)}
  window.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (mode === 'real' || new URL(url, location.href).pathname !== '/api/file') return window.__fpFetch(input, init)
    if (mode === 'offline') return Promise.reject(new TypeError('offline'))
    return Promise.resolve(new Response('{}', { status: Number(mode), headers: { 'content-type': 'application/json' } }))
  }
  return true
})()`

async function open(browser, label, until) {
  await browser.evaluate(`(() => { ${fileRow(label)}.click(); return true })()`)
  assert.ok(await browser.waitFor(until, 10_000), `${label} is shown (${await browser.evaluate(HEAD)} | ${(await browser.evaluate(BODY)).slice(0, 120)})`)
}

/** The insert menu, down into the empty folder: its words. */
async function insertMenu(browser) {
  await browser.evaluate(`(() => { document.getElementById('attach').click(); return true })()`)
  const item = (text) => `[...document.querySelectorAll('#attach-menu button')].find((button) => button.textContent === ${JSON.stringify(text)})`
  assert.ok(await browser.waitFor(`${item('work/')} !== undefined`, 10_000), 'the menu lists the workspace')
  await browser.evaluate(`(() => { ${item('work/')}.click(); return true })()`)
  assert.ok(await browser.waitFor(`${item('hollow/')} !== undefined`, 10_000), 'and its empty folder')
  await browser.evaluate(`(() => { ${item('hollow/')}.click(); return true })()`)
  assert.ok(await browser.waitFor(`document.querySelector('#attach-menu .meta') !== null`, 10_000), 'the empty folder says so')
  const said = JSON.parse(await browser.evaluate(`JSON.stringify({ empty: document.querySelector('#attach-menu .meta').textContent, up: [...document.querySelectorAll('#attach-menu button')].find((button) => button.textContent.startsWith('↑'))?.textContent ?? null })`))
  await browser.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.getElementById('attach-menu').hidden = true; return true })()`)
  return said
}

test("the file panel's words and the insert menu read in the page language, and follow a change made in Settings", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-file-panel')
  const work = join(home, 'work')
  mkdirSync(join(work, 'hollow'), { recursive: true })
  writeFileSync(join(work, 'notes.txt'), 'one\ntwo\n')
  writeFileSync(join(work, 'big.txt'), 'x'.repeat(300 * 1024))
  writeFileSync(join(work, 'page.html'), '<!doctype html><html><body><h1>Preview</h1></body></html>')
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
    // The sanitiser never arrives, so an HTML file falls back to its source.
    await browser.send('Network.setBlockedURLs', { urls: ['*/vendor/purify.js*'] })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await browser.evaluate(`(() => { const row = ${workspaceRow}; if (row.closest('li').dataset.open !== 'true') row.click(); return true })()`)
    assert.ok(await browser.waitFor(`${fileRow('notes.txt')} !== undefined && ${fileRow('page.html')} !== undefined`, 10_000), 'the workspace lists its files')

    await open(browser, 'notes.txt', `${HEAD}.endsWith('行')`)
    assert.match(await browser.evaluate(HEAD), /  ·  2 行$/)
    await open(browser, 'big.txt', `${HEAD}.includes('仅显示前')`)
    assert.match(await browser.evaluate(HEAD), /  ·  仅显示前 \S+/)
    await open(browser, 'page.html', `${BODY}.includes('净化器')`)
    assert.match(await browser.evaluate(HEAD), /  ·  预览$/)
    assert.equal(await browser.evaluate(BODY), '净化器未能加载，因此此文档以源码显示')

    await browser.evaluate(fileReads('offline'))
    await open(browser, 'notes.txt', `${BODY}.startsWith('无法读取')`)
    assert.equal(await browser.evaluate(BODY), '无法读取此文件：offline')
    await browser.evaluate(fileReads('500'))
    await open(browser, 'big.txt', `${BODY}.startsWith('服务器')`)
    assert.equal(await browser.evaluate(BODY), '服务器返回了 500')
    await browser.evaluate(fileReads('real'))
    assert.deepEqual(await insertMenu(browser), { empty: '这里没有可插入的内容', up: '↑ 上一级' })

    // English through Settings, with a file open: the panel draws it again.
    await open(browser, 'notes.txt', `${HEAD}.endsWith('行')`)
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`${HEAD}.endsWith('  ·  2 lines')`, 10_000), `the open file's head reads in English (${await browser.evaluate(HEAD)})`)
    await open(browser, 'page.html', `${BODY}.startsWith('the sanitiser')`)
    assert.match(await browser.evaluate(HEAD), /  ·  preview$/)
    assert.equal(await browser.evaluate(BODY), 'the sanitiser did not load, so this document is shown as its source instead')
    await browser.evaluate(fileReads('offline'))
    await open(browser, 'notes.txt', `${BODY}.startsWith('could not read')`)
    assert.equal(await browser.evaluate(BODY), 'could not read this file: offline')
    await browser.evaluate(fileReads('500'))
    await open(browser, 'big.txt', `${BODY}.startsWith('the server')`)
    assert.equal(await browser.evaluate(BODY), 'the server answered 500')
    await browser.evaluate(fileReads('real'))
    assert.deepEqual(await insertMenu(browser), { empty: 'nothing to insert here', up: '↑ up' })

    // With a file open under Automation tasks, a language change leaves that page where it is (developer-ten's case).
    await open(browser, 'notes.txt', `${HEAD}.endsWith('  ·  2 lines')`)
    await browser.evaluate(`(() => { document.getElementById('automation-tasks').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('main')?.dataset.page === 'schedules'`, 10_000), 'Automation tasks opens')
    await chooseLanguage(browser, 'zh', 'zh-CN')
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(await browser.evaluate(`document.querySelector('main')?.dataset.page ?? null`), 'schedules', 'and stays open across the change')
  } finally {
    await browser?.close()
    server.kill()
    removeDir(home)
  }
})
