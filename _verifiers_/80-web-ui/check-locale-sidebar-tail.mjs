import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 21: the sidebar's View options menu, the tree's notes, New session's
 * note with nowhere to start, and the hero's workspace chip, in DSH's own Chinese where DSH has the words
 * (dsh-client-ui-workspace's groupBy.*, orderBy.* and viewOptions.*, dsh-client-ui-conversation's hero.chooseWorkspace).
 *
 * A Chinese page's View options lists 按工作区树 / 按工作区 / 单列表, 手动排序 / 最近更新 and 隐藏已归档 / 全部对话（显示已归档）/
 * 仅显示已归档 under 工作区; the hero chip and its menu are named 选择工作区; and the tree's notes are Chinese when the
 * server serves no workspace plugin, predates the tree, or cannot be read, as is New session's note when no workspace is
 * known. Switched to English in Settings, the same places read in English again.
 */

const CAPABILITY = 'the sidebar leftovers in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'sidebar-tail-profile')
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


const MENU = `JSON.stringify({
  name: document.querySelector('#view-options button')?.getAttribute('aria-label') ?? null,
  heading: document.querySelector('#view-options .menu .menu-heading')?.textContent ?? null,
  items: [...document.querySelectorAll('#view-options .menu button')].map((item) => item.textContent.trim()),
  chip: document.getElementById('hero-workspace-chip')?.getAttribute('aria-label') ?? null,
  chipMenu: document.getElementById('hero-workspace-menu')?.getAttribute('aria-label') ?? null,
})`

/**
 * Answer the page's next workspace reads as `mode` says ('503', '404', 'offline' or 'none', an empty list), draw the tree
 * again through View options as a person would, and give fetch back once the note is drawn.
 */
async function treeNote(browser, mode, after = '') {
  await browser.evaluate(`(() => {
    window.__sbFetch = window.__sbFetch ?? window.fetch
    const answer = ${JSON.stringify(mode)}
    window.fetch = (input, init) => {
      if (String(input) !== '/api/workspaces') return window.__sbFetch(input, init)
      if (answer === 'offline') return Promise.reject(new TypeError('offline'))
      if (answer === 'none') return Promise.resolve(new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      return Promise.resolve(new Response('{}', { status: Number(answer), headers: { 'content-type': 'application/json' } }))
    }
    document.getElementById('tree-note').textContent = ''
    document.querySelector('#view-options button').click()
    const hide = [...document.querySelectorAll('#view-options .menu button')][5]
    hide.click()
    return true
  })()`)
  if (after !== '') {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await browser.evaluate(after)
  }
  const drawn = await browser.waitFor(`document.getElementById('tree-note').textContent !== ''`, 10_000)
  await settle()
  const text = await browser.evaluate(`document.getElementById('tree-note').textContent`)
  // Fetch back, and the tree drawn again from the server before the next read, so no draw in flight crosses it.
  await browser.evaluate(`(() => { window.fetch = window.__sbFetch; document.querySelector('#view-options button').click(); [...document.querySelectorAll('#view-options .menu button')][5].click(); return true })()`)
  await settle()
  assert.ok(await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 10_000), 'the tree is drawn again')
  await settle()
  assert.ok(drawn, `a note was drawn for ${mode}`)
  return text
}

/** Let a tree draw that is in flight finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 600))

test('the sidebar leftovers read in the page language, and follow a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-sidebar-tail')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'hello' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, text: await response.text() }
    }
    await api('/api/workspaces', { path: work })
    const opened = JSON.parse((await api('/api/folders/session', { folder: work })).text)
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    assert.ok(await browser.waitFor(`document.querySelector('#view-options button') !== null && document.querySelectorAll('#tree .row').length > 0`, 20_000), 'the tree and its View options are drawn')

    await browser.evaluate(`(() => { document.querySelector('#view-options button').click(); return true })()`)
    const chinese = JSON.parse(await browser.evaluate(MENU))
    await browser.evaluate(`(() => { document.querySelector('#view-options button').click(); return true })()`)
    assert.ok(chinese.name?.includes('视图选项'), chinese.name)
    assert.equal(chinese.heading, '工作区')
    assert.deepEqual(chinese.items, ['按工作区树', '按工作区', '单列表', '手动排序', '最近更新', '隐藏已归档', '全部对话（显示已归档）', '仅显示已归档'])
    assert.equal(chinese.chip, '选择工作区')
    assert.equal(chinese.chipMenu, '选择工作区')
    assert.equal(await treeNote(browser, '503'), '当前配置未加载工作区插件')
    assert.equal(await treeNote(browser, '404'), '此服务器早于工作区树，会话以单列列出')
    assert.equal(await treeNote(browser, 'offline'), '无法读取工作区：offline')
    const NEW_SESSION = `(() => { document.getElementById('new-session').click(); return true })()`
    assert.equal(await treeNote(browser, 'none', NEW_SESSION), '请先注册一个工作区——点“工作区”旁的 +')

    await chooseLanguage(browser, 'en', 'en')
    await browser.evaluate(`(() => { document.querySelector('#view-options button').click(); return true })()`)
    const english = JSON.parse(await browser.evaluate(MENU))
    await browser.evaluate(`(() => { document.querySelector('#view-options button').click(); return true })()`)
    assert.ok(english.name?.includes('view options'), english.name)
    assert.equal(english.heading, 'WorkSpace')
    assert.deepEqual(english.items, ['Workspace Tree', 'Workspace', 'In one list', 'Manual', 'Last updated', 'Hide archived', 'All conversations (show archived)', 'Archived only'])
    assert.equal(english.chip, 'Choose workspace')
    assert.equal(english.chipMenu, 'Choose workspace')
    assert.equal(await treeNote(browser, '503'), 'this profile does not load the workspace plugin')
    assert.equal(await treeNote(browser, '404'), 'this server predates the workspace tree, so sessions are listed in one column')
    assert.equal(await treeNote(browser, 'offline'), 'could not read the workspaces: offline')
    assert.equal(await treeNote(browser, 'none', NEW_SESSION), 'register a workspace first — the + beside Workspaces')
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
