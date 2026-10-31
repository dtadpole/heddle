import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the tree rows' own controls, in DSH's own words
 * (dsh-client-ui-workspace: 在“{name}”中新建会话, 置顶会话, 归档会话) and the access menu's name.
 *
 * In Chinese a workspace row's quick New session button and its menu trigger, a session row's Pin and Archive
 * buttons and the access menu are named in Chinese. English comes back word for word.
 */

const CAPABILITY = 'the tree rows in Chinese'

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

const ROWS = `(() => {
  const workspace = [...document.querySelectorAll('#tree li')].find((row) => (row.dataset.rowKey ?? '').startsWith('node:') && row.textContent.includes('locale-ws'))
  const session = document.querySelector('#tree li[data-row-key^="session:"]')
  const names = (row) => (row === undefined || row === null ? null : [...row.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')))
  // A session row's menu trigger carries the session's label, which the tree may only learn on a later draw (its
  // definition folder), so the session row is judged by its own quick controls.
  const own = (list) => (list === null ? null : list.filter((name) => !name.startsWith('actions for ') && !name.endsWith('的操作')))
  return { workspace: names(workspace)?.filter((name) => name.includes('locale-ws')) ?? null, session: own(names(session)), access: document.getElementById('access-menu').getAttribute('aria-label') }
})()`

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

test('the tree rows\' own controls follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-rows')
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
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
    assert.ok(started.ok, `a session is started in it (${started.status} ${await started.clone().text()})`)
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && ${ROWS}.workspace !== null && ${ROWS}.session !== null`, 20_000), 'the page is up with both rows')
    const english = await browser.evaluate(ROWS)
    assert.ok(english.workspace.includes('actions for locale-ws') && english.workspace.includes('New session in locale-ws'), english.workspace.join(' | '))
    assert.ok(english.session.includes('Pin session') && english.session.includes('Archive session'), english.session.join(' | '))
    assert.equal(english.access, 'the access mode this session runs under')

    await chooseLanguage(browser, 'zh')
    assert.ok(await browser.waitFor(`${ROWS}.workspace !== null && ${ROWS}.workspace.includes('在“locale-ws”中新建会话')`, 10_000), 'the tree is redrawn in Chinese')
    const chinese = await browser.evaluate(ROWS)
    assert.ok(chinese.workspace.includes('“locale-ws”的操作'), chinese.workspace.join(' | '))
    assert.ok(chinese.session.includes('置顶会话') && chinese.session.includes('归档会话'), chinese.session.join(' | '))
    assert.equal(chinese.access, '此会话运行的访问模式')

    await chooseLanguage(browser, 'en')
    assert.ok(await browser.waitFor(`${ROWS}.workspace !== null && ${ROWS}.workspace.includes('New session in locale-ws')`, 10_000), 'and back in English')
    assert.deepEqual(await browser.evaluate(ROWS), english, 'word for word')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
