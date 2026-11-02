import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 31: the notes the composer's two seats leave when the server says no.
 *
 * On a Chinese page, an access-mode change the server refuses with a bare 500 says 无法更改访问模式（500）, and one whose
 * request never gets an answer says 无法更改访问模式：offline. A model choice the server refuses says
 * 无法将此会话切换到「scripted」, and 无法将此会话切换到「scripted」：offline when it fails in flight. The setup card's
 * Check again says 端点列表返回了 503 for a refused endpoint list, and 无法读取端点列表：offline for one that fails in
 * flight. Switched to English in Settings, the same six read in English, in the bytes the page wrote before.
 *
 * The seventh sentence of the section, "open a session before changing its access mode", is not reachable from the
 * page: the access chip is disabled until a session is open. It is in both tables, and the page draws it through t().
 */

const CAPABILITY = "the seats' failure notes in the page language"

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'seat-failures-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

/**
 * The scripted endpoint alone, offering a second model: the setup card shows (its rule is "only the scripted
 * endpoint"), so its Check again is the person's way to read the endpoint list again, and the model menu has a choice
 * other than the current one.
 */
function configIn(home) {
  const script = join(home, 'script.json')
  writeJson(script, { steps: [{ text: 'hello' }] })
  return writeJson(join(home, 'heddle.json'), {
    default: 'scripted',
    endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted', models: ['scripted', 'scripted-b'] }],
  })
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

/**
 * Every request to one route answers `mode`: 'offline' rejects, a number is a bare status with an empty body, 'real'
 * goes to the server. `route` is 'permission' (POST /api/sessions/<id>/permission), 'model' (POST …/model) or
 * 'endpoints' (GET /api/endpoints).
 */
const answer = (route, mode) => `(() => {
  window.__sfFetch = window.__sfFetch ?? window.fetch.bind(window)
  window.__sfModes = window.__sfModes ?? {}
  window.__sfModes[${JSON.stringify(route)}] = ${JSON.stringify(mode)}
  window.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const route =
      method === 'POST' && /^\\/api\\/sessions\\/[^/]+\\/permission$/.test(url.pathname) ? 'permission'
        : method === 'POST' && /^\\/api\\/sessions\\/[^/]+\\/model$/.test(url.pathname) ? 'model'
          : method === 'GET' && url.pathname === '/api/endpoints' ? 'endpoints'
            : null
    const mode = route === null ? 'real' : (window.__sfModes[route] ?? 'real')
    if (mode === 'real') return window.__sfFetch(input, init)
    if (mode === 'offline') return Promise.reject(new TypeError('offline'))
    return Promise.resolve(new Response('', { status: Number(mode) }))
  }
  return true
})()`

/**
 * Run `action` (an expression) and wait for the tree note to say `expected`.
 *
 * Every text the note shows is recorded, because the note is shared: a tree redraw that lands after the failure paints
 * the place note over it ("a new conversation in work"), which is the page's own rule for that note, not this
 * section's. What is judged is that the failure was said, in the page language, not that it was the last word.
 */
async function noteAfter(browser, action, label, expected) {
  await browser.evaluate(`(() => {
    const note = document.getElementById('tree-note')
    if (window.__seatNotes === undefined) {
      new MutationObserver(() => { if (note.textContent !== '') window.__seatNotes.push(note.textContent) }).observe(note, { childList: true, characterData: true, subtree: true })
    }
    window.__seatNotes = []
    return true
  })()`)
  await browser.evaluate(`(async () => { ${action}; return true })()`)
  const said = `JSON.stringify(window.__seatNotes)`
  try {
    await browser.waitFor(`window.__seatNotes.includes(${JSON.stringify(expected)})`, 10_000)
  } catch {
    assert.fail(`the note says ${JSON.stringify(expected)} for ${label}; it said ${await browser.evaluate(said)}`)
  }
  return expected
}

/** Open the access menu and pick a mode other than the current one and full access. */
const pickAccess = `(async () => {
  document.getElementById('access').click()
  for (let i = 0; i < 50 && document.getElementById('access-menu').hidden; i++) await new Promise((r) => setTimeout(r, 20))
  const item = [...document.querySelectorAll('#access-menu [role="menuitemradio"]')].find((row) => row.getAttribute('aria-checked') !== 'true' && row.dataset.mode !== 'danger-full-access')
  item.click()
})()`

/** Open the model menu, drill into its Model cell, and pick the model that is not the current one. */
const pickModel = (cell) => `(async () => {
  const until = async (test) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20)) }
  document.getElementById('model-trigger').click()
  await until(() => !document.getElementById('model-menu').hidden)
  ;[...document.querySelectorAll('#model-menu [role="menuitem"]')].find((row) => row.innerText.startsWith(${JSON.stringify(cell)})).click()
  await until(() => document.querySelector('#model-menu [role="menuitemradio"]') !== null)
  ;[...document.querySelectorAll('#model-menu [role="menuitemradio"]')].find((row) => row.getAttribute('aria-checked') !== 'true' && !row.disabled).click()
})()`

const RECHECK = `document.getElementById('setup-recheck').click()`

test("the seats' failure notes read in the page language, and follow a change made in Settings", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-seat-failures')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const config = configIn(home)
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
    assert.ok(await browser.waitFor(`document.getElementById('setup-card')?.hidden === false`, 10_000), 'the setup card shows for the scripted endpoint alone')

    // A session to change: the seats act on the open one.
    await browser.evaluate(`(() => {
      const field = document.querySelector('textarea')
      field.value = 'hello'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.getElementById('access').disabled === false && document.querySelectorAll('#log .turn').length >= 2`, 20_000), 'a session is open and answered')

    const judge = async (words) => {
      await browser.evaluate(answer('permission', '500'))
      await noteAfter(browser, pickAccess, 'a refused access change', words.accessRefused)
      await browser.evaluate(answer('permission', 'offline'))
      await noteAfter(browser, pickAccess, 'a failed access change', words.accessFailed)
      await browser.evaluate(answer('permission', 'real'))
      await browser.evaluate(answer('model', '500'))
      await noteAfter(browser, pickModel(words.modelCell), 'a refused model choice', words.switchRefused)
      await browser.evaluate(answer('model', 'offline'))
      await noteAfter(browser, pickModel(words.modelCell), 'a failed model choice', words.switchFailed)
      await browser.evaluate(answer('model', 'real'))
      await browser.evaluate(answer('endpoints', '503'))
      await noteAfter(browser, RECHECK, 'a refused endpoint list', words.endpointsAnswered)
      await browser.evaluate(answer('endpoints', 'offline'))
      await noteAfter(browser, RECHECK, 'a failed endpoint list', words.endpointsFailed)
      await browser.evaluate(answer('endpoints', 'real'))
    }

    await judge({
      modelCell: '模型',
      accessRefused: '无法更改访问模式（500）',
      accessFailed: '无法更改访问模式：offline',
      switchRefused: '无法将此会话切换到「scripted」',
      switchFailed: '无法将此会话切换到「scripted」：offline',
      endpointsAnswered: '端点列表返回了 503',
      endpointsFailed: '无法读取端点列表：offline',
    })

    await chooseLanguage(browser, 'en', 'en')
    await judge({
      modelCell: 'Model',
      accessRefused: 'could not change the access mode (500)',
      accessFailed: 'could not change the access mode: offline',
      switchRefused: 'could not switch this session onto scripted',
      switchFailed: 'could not switch this session onto scripted: offline',
      endpointsAnswered: 'the endpoint list answered 503',
      endpointsFailed: 'could not read the endpoint list: offline',
    })
  } finally {
    await browser?.close()
    server.kill()
    removeDir(home)
  }
})
