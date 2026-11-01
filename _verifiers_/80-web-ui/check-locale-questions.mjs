import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 13: the question card in Chinese. A Chinese browser's card shows
 * the model's own header and question verbatim, and the page's words in DSH's: 1 / 2 for the pager, 上一题 / 下一题,
 * 选项, 输入其他答案, 跳过 and 提交.
 */

const CAPABILITY = 'the question card in Chinese'

const BATCH = {
  questions: [
    { id: 'color', header: 'Pick', question: 'Which colour?', options: [{ label: 'Blue (Recommended)', description: 'calm' }, { label: 'Red', description: 'loud' }] },
    { id: 'note', question: 'Anything else?' },
  ],
}
const ask = { toolCall: { name: 'ask_user_question', arguments: BATCH } }

/** The project's own plugin profile with the question service switched to timed mode and a short wait. */
function timedPatch(dir, seconds) {
  const source = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8')
  const patched = source.replace(/(- id: questions\n\s+name: [^\n]+\n\s+inject: [^\n]+\n\s+config:\n\s+mode: )legacy(\n\s+timeout: )\d+/, `$1timed$2${seconds}`)
  assert.notEqual(patched, source, 'the profile has a questions row to switch to timed mode')
  const path = join(dir, 'timed.patch.yml')
  writeFileSync(path, patched)
  return path
}

/** Start a scripted server; `home` may be given to restart over the same store. */
function startServer(label, steps, options = {}) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = options.home ?? isolatedHome(`questions-${label}`)
      const work = fixtureDir(`questions-${label}-work`)
      const { config } = scriptedConfig({ home, steps })
      const child = spawn(
        ...heddleCommand([
          'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'),
          ...(options.patch !== undefined ? ['--patch', options.patch] : []),
          '--endpoint', 'scripted', '--session-root', join(home, 'sessions'),
        ]),
        { cwd: work, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            url: match[1],
            home,
            output: () => output,
            stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill('SIGKILL') }),
            close: async () => {
              child.kill('SIGKILL')
              if (options.keepHome !== true) removeDir(home)
              removeDir(work)
            },
          })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) { settled = true; reject(new Error(`the server exited ${code} before printing a URL\n${output}`)) }
      })
      setTimeout(() => {
        if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`the server printed no URL within 15s\n${output}`)) }
      }, 15_000).unref()
    })()
  })
}

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

async function sendMessage(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('#prompt textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    return true
  })()`)
}

const cardState = (browser) =>
  browser.evaluate(`(() => {
    const card = document.getElementById('question-card')
    return JSON.stringify({
      hidden: card.hidden, state: card.dataset.state, readOnly: card.dataset.readOnly,
      title: document.getElementById('question-title').textContent,
      text: document.getElementById('question-text').textContent,
      position: document.getElementById('question-position').textContent,
      badge: document.getElementById('question-badge').hidden ? '' : document.getElementById('question-badge').textContent,
      options: [...document.querySelectorAll('#question-options .q-option')].map((b) => ({ label: b.dataset.label, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled })),
      countdown: document.getElementById('question-countdown').hidden ? '' : document.getElementById('question-countdown').textContent,
      skipped: !document.getElementById('question-skipped').hidden,
      submit: !document.getElementById('question-submit').hidden,
    })
  })()`).then(JSON.parse)
const click = (browser, selector) => browser.evaluate(`(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true })()`)
const typeAnswer = (browser, text) =>
  browser.evaluate(`(() => { const f = document.getElementById('question-custom'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const logText = (browser) => browser.evaluate('document.getElementById("log").innerText')

/** The session the page opened, and the stored record of its question's tool call. */
async function onlySession(server) {
  const body = await (await request(server, '/api/sessions')).json()
  const sessions = Array.isArray(body) ? body : body.sessions ?? []
  return sessions[0]?.id
}
async function toolResult(server, session) {
  const record = await (await request(server, `/api/sessions/${session}`)).json()
  const tool = (record.turns ?? []).find((turn) => (turn.kind ?? turn.type) === 'tool' && /ask_user_question/.test(JSON.stringify(turn)))
  return tool === undefined ? undefined : JSON.parse(tool.result ?? 'null')
}
async function userTexts(server, session) {
  const record = await (await request(server, `/api/sessions/${session}`)).json()
  return (record.turns ?? []).filter((turn) => (turn.kind ?? turn.type) === 'user').map((turn) => turn.text ?? '')
}

test('the question card speaks the interface language around the model\'s own words', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('locale', [ask, { text: 'thanks for answering' }])
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await sendMessage(browser, 'ask me something')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000), 'the question card appears')
    const first = await cardState(browser)
    assert.equal(first.title, 'Pick', 'the model\'s header stays verbatim')
    assert.equal(first.text, 'Which colour?', 'and its question')
    assert.equal(first.position, '1 / 2', 'the pager in the page language')
    const words = await browser.evaluate(`({
      prev: document.getElementById('question-prev').getAttribute('aria-label'),
      next: document.getElementById('question-next').getAttribute('aria-label'),
      choices: document.getElementById('question-options').getAttribute('aria-label'),
      placeholder: document.getElementById('question-custom').getAttribute('placeholder'),
      custom: document.getElementById('question-custom').getAttribute('aria-label'),
      skip: document.getElementById('question-skip').textContent,
      submit: document.getElementById('question-submit').textContent,
    })`)
    assert.deepEqual(words, { prev: '上一题', next: '下一题', choices: '选项', placeholder: '输入其他答案', custom: '你的答案', skip: '跳过', submit: '提交' })
    await click(browser, '#question-options .q-option[data-label="Red"]')
    assert.equal((await cardState(browser)).position, '2 / 2', 'a choice moves on')
    // The second question has no header, so the card names it in the page language.
    assert.equal((await cardState(browser)).title, '问题', 'an unnamed question is 问题')
  } finally {
    await browser.close()
    await server.close()
  }
})
