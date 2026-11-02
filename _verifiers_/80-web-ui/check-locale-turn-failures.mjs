import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 30: the transcript's lines for a message that did not get through.
 *
 * A Chinese page whose turn request never gets an answer says 消息未能发送：offline, and the draft comes back; a bare 500
 * says 消息未能发送：服务器拒绝了请求（500）; a turn whose answer stream breaks after the server took the message says
 * 回答传输时连接中断（…）；消息本身已送达. Switched to English in Settings, the same failures read in English, in the bytes
 * check-composer reads.
 */

const CAPABILITY = "the transcript's failure lines in the page language"

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'turn-failures-profile')
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


/** Every POST to /api/turn answers `mode`: 'offline' rejects, a number is a bare status, 'broken' opens and then breaks. */
const turnRequests = (mode) => `(() => {
  window.__tfFetch = window.__tfFetch ?? window.fetch.bind(window)
  const mode = ${JSON.stringify(mode)}
  window.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (mode === 'real' || method !== 'POST' || new URL(url, location.href).pathname !== '/api/turn') return window.__tfFetch(input, init)
    if (mode === 'offline') return Promise.reject(new TypeError('offline'))
    if (mode === 'broken') {
      const body = new ReadableStream({ start(controller) { setTimeout(() => controller.error(new TypeError('network')), 50) } })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }))
    }
    return Promise.resolve(new Response('', { status: Number(mode) }))
  }
  return true
})()`

const DENIED = `JSON.stringify([...document.querySelectorAll('#log .turn.denied')].map((row) => row.textContent))`

/** Send `text` from the composer, and the transcript's newest failure line once a new one is drawn. */
async function send(browser, text) {
  const before = JSON.parse(await browser.evaluate(DENIED)).length
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('send').click()
    return true
  })()`)
  assert.ok(await browser.waitFor(`document.querySelectorAll('#log .turn.denied').length > ${before}`, 10_000), `a failure line is drawn for "${text}"`)
  return JSON.parse(await browser.evaluate(DENIED)).at(-1)
}

test("the transcript's failure lines read in the page language, and follow a change made in Settings", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-turn-failures')
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
    const registered = await fetch(new URL('/api/workspaces', server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: work }) })
    assert.equal(registered.status, 200, 'the workspace is registered')

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')

    await browser.evaluate(turnRequests('offline'))
    assert.equal(await send(browser, 'first'), '消息未能发送：offline')
    assert.equal(await browser.evaluate(`document.querySelector('textarea').value`), 'first', 'and the draft comes back')
    await browser.evaluate(turnRequests('500'))
    assert.equal(await send(browser, 'second'), '消息未能发送：服务器拒绝了请求（500）')
    await browser.evaluate(turnRequests('broken'))
    const dropped = await send(browser, 'third')
    assert.match(dropped, /^回答传输时连接中断（.+）；消息本身已送达$/)

    await browser.evaluate(turnRequests('real'))
    await chooseLanguage(browser, 'en', 'en')
    await browser.evaluate(turnRequests('offline'))
    assert.equal(await send(browser, 'fourth'), 'the message could not be sent: offline')
    await browser.evaluate(turnRequests('500'))
    assert.equal(await send(browser, 'fifth'), 'the message could not be sent: the server refused it (500)')
    await browser.evaluate(turnRequests('broken'))
    assert.match(await send(browser, 'sixth'), /^the connection dropped while the answer was arriving \(.+\); the message itself was delivered$/)
  } finally {
    await browser?.close()
    server.kill()
    removeDir(home)
  }
})
