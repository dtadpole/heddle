import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, heddleCommand, isolatedHome, repoRoot, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 20: the session-statistics dock under the composer and its three panels
 * in DSH's own Chinese (dsh-client-ui-chat's stats.* and message.turnUsage.*, dsh-client-ui-conversation's context.*).
 *
 * After one turn whose provider reported 1000 prompt tokens (800 of them cached) and 50 output tokens against a 2000-token
 * window, a Chinese page's dock reads 1 轮 1 步 and 缓存命中 80%; the time panel is 会话统计 with rows such as 模型用时 and
 * 输出速度（TPS）, the usage panel Token 用量 with 缓存命中 / 未缓存输入 / 缓存读取 / 输出, and the context panel says
 * 上下文已用 and is named 上下文用量. Switched to English in Settings with the context panel open, the panel and the dock
 * read in English, and so do the other two panels.
 */

const CAPABILITY = 'the session-statistics dock in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'stats-profile')
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


const DOCK = `JSON.stringify({
  turns: document.querySelector('[data-stat="turns"]')?.textContent ?? null,
  steps: document.querySelector('[data-stat="steps"]')?.textContent ?? null,
  cache: document.querySelector('[data-stat="cache"]')?.textContent ?? null,
})`
const PANEL = `JSON.stringify({
  open: document.getElementById('stat-popover').hidden === false,
  label: document.getElementById('stat-popover').getAttribute('aria-label'),
  title: document.querySelector('#stat-popover .stat-panel-title')?.textContent ?? null,
  sub: document.querySelector('#stat-popover .stat-panel-sub')?.textContent ?? null,
  terms: [...document.querySelectorAll('#stat-popover dt')].map((term) => term.textContent),
})`

/** Open one of the dock's panels by its pill, as a click does, and read it. */
async function openPanel(browser, kind) {
  await browser.evaluate(`(() => {
    const popover = document.getElementById('stat-popover')
    if (popover.hidden === false) document.querySelector('[data-stat-pill][aria-expanded="true"]')?.click()
    document.querySelector('[data-stat-pill="${kind}"]').click()
    return true
  })()`)
  assert.ok(await browser.waitFor(`document.getElementById('stat-popover').hidden === false && document.querySelector('[data-stat-pill="${kind}"]').getAttribute('aria-expanded') === 'true'`, 5_000), `the ${kind} panel opens`)
  return JSON.parse(await browser.evaluate(PANEL))
}

test('the session-statistics dock and its panels read in the page language, and follow a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-stats')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const double = await chatDouble({ content: 'the answer', reasoning: 'thinking', holdOpenMs: 50, usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } })
  const config = writeJson(join(home, 'heddle.json'), { default: 'held', endpoints: [{ name: 'held', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'held-model', stream: true, contextWindow: 2000 }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  let server = null
  let browser = null
  try {
    server = await startServer(['--profile', profileIn(home), '--endpoint', 'held', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const origin = new URL(server.url).origin
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, text: await response.text() }
    }
    await api('/api/workspaces', { path: work })
    const opened = JSON.parse((await api('/api/folders/session', { folder: work })).text)
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')
    const turn = await api('/api/turn', { prompt: 'report the cost', folder: work, session })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    assert.ok(await browser.waitFor(`document.getElementById('composer-status')?.hidden === false && document.querySelector('[data-stat="cache"]')?.textContent !== ''`, 20_000), 'the dock is drawn with its figures')

    const dock = JSON.parse(await browser.evaluate(DOCK))
    const time = await openPanel(browser, 'time')
    const usage = await openPanel(browser, 'usage')
    const contextPanel = await openPanel(browser, 'context')
    console.log('PROBE', JSON.stringify({ dock, time, usage, contextPanel }))
    assert.deepEqual(dock, { turns: '1 轮', steps: '1 步', cache: '缓存命中 80%' })
    assert.equal(time.title, '会话统计')
    assert.equal(time.label, '会话统计')
    assert.ok(time.terms.length > 0 && time.terms.every((term) => ['模型用时', '工具调用用时', '首 token 平均（TTFT）', '输出速度（TPS）'].includes(term)), JSON.stringify(time.terms))
    assert.equal(usage.title, 'Token 用量')
    assert.equal(usage.label, 'Token 用量')
    assert.deepEqual(usage.terms, ['缓存命中', '未缓存输入', '缓存读取', '输出'])
    assert.equal(contextPanel.label, '上下文用量')
    assert.equal(contextPanel.sub, '上下文已用')
    assert.ok(contextPanel.terms.every((term) => ['系统提示词', '工具定义', '对话消息'].includes(term)), JSON.stringify(contextPanel.terms))

    // The context panel stays open while the language changes in Settings.
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.querySelector('[data-stat="turns"]')?.textContent === '1 turns'`, 10_000), 'the dock reads in English')
    const contextEnglish = JSON.parse(await browser.evaluate(PANEL))
    assert.equal(contextEnglish.open, true, 'the context panel is still open')
    assert.equal(contextEnglish.label, 'Context usage')
    assert.equal(contextEnglish.sub, 'of context used')
    assert.ok(contextEnglish.terms.every((term) => ['System prompt', 'Tool definitions', 'Messages'].includes(term)), JSON.stringify(contextEnglish.terms))
    assert.deepEqual(JSON.parse(await browser.evaluate(DOCK)), { turns: '1 turns', steps: '1 steps', cache: 'Cache hit 80%' })
    const timeEnglish = await openPanel(browser, 'time')
    assert.equal(timeEnglish.title, 'Session statistics')
    assert.equal(timeEnglish.label, 'Session statistics')
    assert.ok(timeEnglish.terms.length > 0 && timeEnglish.terms.every((term) => ['LLM time', 'Tool time', 'Avg time to first token (TTFT)', 'Tokens per second (TPS)'].includes(term)), JSON.stringify(timeEnglish.terms))
    const usageEnglish = await openPanel(browser, 'usage')
    assert.equal(usageEnglish.title, 'Token usage')
    assert.equal(usageEnglish.label, 'Token usage')
    assert.deepEqual(usageEnglish.terms, ['Cache hit', 'Uncached input', 'Cached input', 'Output'])
  } finally {
    browser?.close()
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
