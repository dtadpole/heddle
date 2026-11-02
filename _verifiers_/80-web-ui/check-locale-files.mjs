import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 26: the workspace tree's folder levels and the file tab, in DSH's own
 * Chinese where DSH has the words (dsh-client-ui-sidebar-files: 读取失败：{message}, 这个目录不在了。可能已被移动或删除。,
 * 空目录, its type label 文件).
 *
 * A Chinese page opens an empty folder to 空目录, a folder the server may not read to 读取失败：<the server's message>, a
 * workspace whose folder is gone to 这个目录不在了。可能已被移动或删除。, and a level whose read fails without a code to the
 * note 无法读取“<name>”：文件树返回了 500; a file row's tab is 文件. Switched to English in Settings, the redrawn tree says
 * nothing inside, Read failed: …, That directory is gone. …, could not read <name>: the tree answered 500, and the tab is
 * File.
 */

const CAPABILITY = 'the workspace tree\'s folder levels in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'files-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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

const folderRow = (label) => `[...document.querySelectorAll('#tree li[data-kind="folder"] > .row')].find((row) => row.querySelector('.label')?.textContent === ${JSON.stringify(label)})`
const fileRow = (label) => `[...document.querySelectorAll('#tree li[data-kind="file"] > .row')].find((row) => row.querySelector('.label')?.textContent === ${JSON.stringify(label)})`
const workspaceRow = (path) => `[...document.querySelectorAll('#tree li[data-kind="workspace"] > .row')].find((row) => row.dataset.path === ${JSON.stringify(path)})`
/** The one line under an open level, or null. */
const lineUnder = (row) => `((${row})?.closest('li').querySelector(':scope > ul[role=group] > .empty')?.textContent ?? null)`
const NOTE = `(() => { const note = document.getElementById('tree-note'); return note.hidden ? '' : note.textContent })()`

test('the workspace tree\'s folder levels and the file tab read in the page language, and follow a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  /** `chmod 000` does not stop the superuser, so the unreadable folder cannot be judged as root. */
  if (!skipUnless(context, typeof process.getuid !== 'function' || process.getuid() !== 0, 'a user that file modes apply to')) return
  const home = isolatedHome('locale-files')
  const work = fixtureDir('locale-files-work')
  const lost = fixtureDir('locale-files-lost')
  const locked = join(work, 'locked')
  mkdirSync(join(work, 'hollow'), { recursive: true })
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'held.txt'), 'a file the server cannot list\n')
  mkdirSync(join(work, 'open'), { recursive: true })
  writeFileSync(join(work, 'open', 'kept.txt'), 'readable\n')
  mkdirSync(join(work, 'stubbed'), { recursive: true })
  writeFileSync(join(work, 'stubbed', 'inside.txt'), 'read through a failing fetch\n')
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
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    const added = await api('/api/workspaces', { path: work })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const gone = await api('/api/workspaces', { path: lost })
    assert.equal(gone.status, 200, `registered the second workspace (${JSON.stringify(gone.body)})`)
    const lostPath = gone.body.record.path
    removeDir(lost)
    const made = await api('/api/sessions', { branch: work, title: 'tree words' })
    assert.equal(made.status, 200, `created a session (${JSON.stringify(made.body)})`)
    chmodSync(locked, 0o000)

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, made.body.session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    // A first visit opens the first workspace only; the one holding the folders is opened here when it is not.
    assert.ok(await browser.waitFor(`${workspaceRow(added.body.record.path)} !== undefined`, 10_000), 'the workspace is listed')
    await browser.evaluate(`(() => { const row = ${workspaceRow(added.body.record.path)}; if (row.closest('li').dataset.open !== 'true') row.click(); return true })()`)
    assert.ok(await browser.waitFor(`${folderRow('hollow')} !== undefined && ${folderRow('locked')} !== undefined && ${folderRow('stubbed')} !== undefined`, 10_000), 'the workspace lists its folders')
    // A level whose read fails without a code: the stubbed folder's read answers 500, every other read goes through.
    await browser.evaluate(`(() => {
      const real = window.fetch.bind(window)
      const failing = 'path=' + encodeURIComponent(${JSON.stringify(join(added.body.record.path, 'stubbed'))})
      window.fetch = (input, init) => String(input instanceof Request ? input.url : input).includes(failing) ? Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })) : real(input, init)
      return true
    })()`)

    const openFolder = async (label) => {
      await browser.evaluate(`(() => { ${folderRow(label)}.click(); return true })()`)
      assert.ok(await browser.waitFor(`${lineUnder(folderRow(label))} !== null || (${folderRow(label)})?.closest('li').querySelector(':scope > ul[role=group] > li') != null`, 10_000), `${label} opens`)
    }
    await openFolder('hollow')
    assert.equal(await browser.evaluate(lineUnder(folderRow('hollow'))), '空目录')
    await openFolder('locked')
    assert.equal(await browser.evaluate(lineUnder(folderRow('locked'))), '读取失败：cannot list "locked": permission denied')
    await openFolder('stubbed')
    assert.ok(await browser.waitFor(`${NOTE} === '无法读取“stubbed”：文件树返回了 500'`, 5_000), `a read that fails without a code leaves its note (${await browser.evaluate(NOTE)})`)

    // The workspace whose folder is gone, opened.
    assert.ok(await browser.waitFor(`${workspaceRow(lostPath)} !== undefined`, 10_000), 'the workspace whose folder is gone is still listed')
    await browser.evaluate(`(() => { const row = ${workspaceRow(lostPath)}; if (row.closest('li').dataset.open !== 'true') row.click(); return true })()`)
    assert.ok(await browser.waitFor(`${lineUnder(workspaceRow(lostPath))} !== null`, 10_000), 'the gone workspace opens to one line')
    assert.equal(await browser.evaluate(lineUnder(workspaceRow(lostPath))), '这个目录不在了。可能已被移动或删除。')

    // A file row's own tab.
    await openFolder('open')
    assert.ok(await browser.waitFor(`${fileRow('kept.txt')} !== undefined`, 10_000), 'the readable folder lists its file')
    await browser.evaluate(`(() => { ${fileRow('kept.txt')}.click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('tab-file') !== null`, 10_000), 'the file row offers its own tab')
    assert.equal(await browser.evaluate(`document.getElementById('tab-file').textContent`), '文件')

    // English through Settings: the tree is drawn again with its open levels, and the tab is said again.
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`${lineUnder(folderRow('hollow'))} === 'nothing inside'`, 10_000), `the empty folder redraws in English (${await browser.evaluate(lineUnder(folderRow('hollow')))})`)
    assert.ok(await browser.waitFor(`${lineUnder(folderRow('locked'))} === 'Read failed: cannot list "locked": permission denied'`, 10_000), `the unreadable folder redraws in English (${await browser.evaluate(lineUnder(folderRow('locked')))})`)
    assert.ok(await browser.waitFor(`${lineUnder(workspaceRow(lostPath))} === 'That directory is gone. It may have been moved or deleted.'`, 10_000), `the gone workspace redraws in English (${await browser.evaluate(lineUnder(workspaceRow(lostPath)))})`)
    assert.ok(await browser.waitFor(`${NOTE} === 'could not read stubbed: the tree answered 500'`, 10_000), `the failing level's note is said again in English (${await browser.evaluate(NOTE)})`)
    assert.equal(await browser.evaluate(`document.getElementById('tab-file')?.textContent ?? null`), 'File')
  } finally {
    await browser?.close()
    server.kill()
    try {
      chmodSync(locked, 0o755)
    } catch {
      // already gone, or never made
    }
    for (const dir of [home, work, lost]) removeDir(dir)
  }
})
