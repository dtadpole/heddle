import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 10: the words the shared blocks draw for the tree. SessionArchive's
 * notice and confirmation, SessionIdCopy's item, the tree's empty states and the pin marker keep DSH's English for their
 * own tests; the page hands them its language. With 中文 chosen: the pinned marker is 已置顶, the row menu's last item is
 * 复制 Session ID, and archiving from the row says 会话已归档，可 with 撤销 — DSH's own zh strings. Archiving a session
 * whose turn is still running asks first, and that dialog (title, work list, Cancel, the action) is Chinese throughout.
 */

const CAPABILITY = 'the tree in the interface language'

function scratchProfile(home) {
  const profile = join(home, 'rows-profile')
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

const STATE = `(() => {
  const row = [...document.querySelectorAll('#tree li[data-row-key^="session:"]')].find((li) => li.textContent.includes('Locale row'))
  const pin = row?.querySelector('[data-pinned], .pin-slot, [role="img"][aria-label]')
  const menuItems = row === undefined ? [] : [...row.querySelectorAll('.menu [role="menuitem"]')].map((item) => item.textContent.trim())
  const notice = document.getElementById('archive-notice')
  return {
    pinned: row?.dataset.pinned === 'true' ? ([...row.querySelectorAll('[role="img"]')].map((mark) => mark.getAttribute('aria-label')).find((name) => name !== null && name.length > 0) ?? null) : null,
    lastItem: menuItems.at(-1) ?? null,
    notice: notice.hidden ? null : { text: notice.textContent, buttons: [...notice.querySelectorAll('button')].map((button) => button.textContent) },
    empty: [...document.querySelectorAll('#tree .tree-empty-text, #tree .tree-empty-action')].map((element) => element.textContent),
  }
})()`

test('the tree\'s shared words follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-blocks')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle') }
  const server = await startServer(['--profile', scratchProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    const folder = join(home, 'locale-ws')
    mkdirSync(folder, { recursive: true })
    const base = new URL(server.url)
    const api = (path, body) =>
      fetch(new URL(`${path}?token=${base.searchParams.get('token')}`, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok((await api('/api/workspaces', { path: folder })).ok, 'the workspace is registered')
    const started = await api('/api/sessions', { branch: folder })
    const id = (await started.json()).session
    assert.ok((await api(`/api/sessions/${encodeURIComponent(id)}/title`, { title: 'Locale row' })).ok, 'the session is titled')
    assert.ok((await api(`/api/sessions/${encodeURIComponent(id)}/flags`, { pinned: true })).ok, 'and pinned')
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && (${STATE}).pinned !== null`, 20_000).catch(() => false), `the pinned row is drawn (${JSON.stringify(await browser.evaluate(STATE))})`)
    const english = await browser.evaluate(STATE)
    assert.equal(english.pinned, 'Pinned')
    assert.equal(english.lastItem, 'Copy Session ID')

    await chooseLanguage(browser, 'zh')
    assert.ok(await browser.waitFor(`(${STATE}).pinned === '已置顶'`, 10_000).catch(() => false), `the pin marker in Chinese (${JSON.stringify(await browser.evaluate(STATE))})`)
    assert.equal((await browser.evaluate(STATE)).lastItem, '复制 Session ID', 'the row menu\'s last item')

    // Unpin, then archive from the row's own control: the notice is DSH's zh sentence with its undo.
    await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree li[data-row-key^="session:"]')].find((li) => li.textContent.includes('Locale row')); row.querySelector('button.pin-action').click(); return true })()`)
    assert.ok(await browser.waitFor(`(${STATE}).pinned === null`, 10_000).catch(() => false), 'unpinned')
    await browser.evaluate(`(() => { const row = [...document.querySelectorAll('#tree li[data-row-key^="session:"]')].find((li) => li.textContent.includes('Locale row')); [...row.querySelectorAll('.session-actions button')].find((button) => button.getAttribute('aria-label') === '归档会话' || button.getAttribute('aria-label') === 'Archive session').click(); return true })()`)
    assert.ok(await browser.waitFor(`(${STATE}).notice !== null`, 10_000).catch(() => false), 'the archive notice shows')
    const notice = (await browser.evaluate(STATE)).notice
    assert.ok(notice.text.startsWith('会话已归档，可'), `DSH's zh notice: ${notice.text}`)
    assert.equal(notice.buttons[0], '撤销', 'with its undo')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})

test('the stop-and-archive question is asked in the interface language, title, work and buttons alike', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-blocks-archive')
  const work = fixtureDir('locale-blocks-archive-work')
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  writeFileSync(script, `${JSON.stringify({ steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 40', timeoutMs: 60000 } } }, { text: 'slept' }] }, null, 2)}\n`)
  const server = await startServer(['--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work], { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config })
  const browser = await openBrowser({ width: 1280, height: 900 })
  let long
  try {
    const base = new URL(server.url)
    const token = base.searchParams.get('token')
    // The tree lists a session under its registered workspace.
    const registered = await fetch(new URL(`/api/workspaces?token=${token}`, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: work }) })
    assert.ok(registered.ok, `the work folder is registered (${registered.status})`)
    long = fetch(new URL(`/api/turn?token=${token}`, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a long job', folder: work }) })
      .then((response) => response.text())
      .catch(() => '')
    let running
    for (let attempt = 0; attempt < 100 && running === undefined; attempt += 1) {
      const sessions = await (await fetch(new URL(`/api/sessions?token=${token}`, base))).json()
      running = sessions.find((entry) => entry.running === true)?.id
      if (running === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    assert.ok(running, 'the long turn is running')
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === 'zh-CN' && document.querySelector('#tree li[data-row-key="session:${running}"]') !== null`, 20_000), 'a Chinese browser gets the Chinese page, with the running row')
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree li[data-row-key="session:${running}"]')
      ;[...row.querySelectorAll('.menu [role="menuitem"]')].find((item) => item.textContent.trim() === '归档会话').click()
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.getElementById('session-archive').open`, 10_000), 'archiving a running session asks first')
    const dialog = await browser.evaluate(`({
      title: document.getElementById('session-archive-title').textContent,
      list: document.getElementById('session-archive-activity').getAttribute('aria-label'),
      work: [...document.querySelectorAll('#session-archive-activity li')].map((entry) => entry.textContent),
      cancel: [...document.querySelectorAll('#session-archive [data-ws-close]')].map((button) => (button.classList.contains('ws-close') ? button.getAttribute('aria-label') : button.textContent.trim())),
      action: document.getElementById('session-archive-confirm').textContent,
      pending: document.getElementById('session-archive-status').textContent,
      desc: document.getElementById('session-archive-desc').textContent,
    })`)
    assert.equal(dialog.title, '停止并归档此会话？', "DSH's question")
    assert.equal(dialog.list, '将被停止的工作')
    assert.deepEqual(dialog.work, ['进行中的回合', '1 个后台任务：sleep 40'], 'the work, in DSH\'s words and order')
    assert.deepEqual(dialog.cancel, ['关闭', '取消'], 'the close and Cancel buttons')
    assert.equal(dialog.action, '停止并归档')
    assert.equal(dialog.pending, '正在停止并归档…')
    assert.match(dialog.desc, /^“.*”仍有正在进行的工作。归档会先停止这些工作/, 'and the description')
    await browser.evaluate(`[...document.querySelectorAll('#session-archive [data-ws-close]')].find((button) => button.textContent.trim() === '取消').click()`)
    assert.equal(await browser.evaluate(`document.getElementById('session-archive').open`), false, 'Cancel closes it')
  } finally {
    browser.close()
    server.kill()
    await Promise.race([long, new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))])
    removeDir(home)
    removeDir(work)
  }
})
