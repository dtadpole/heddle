import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3: the composer and the empty conversation, in DSH's own words
 * (dsh-client-ui-conversation's `placeholder.*` and `input.*`).
 *
 * In Chinese the draft's placeholder, the add-files button and the pending-attachments row are Chinese. So are the
 * submit button's accessible name and title, which say Send while idle and Queue while a turn runs, and Stop while a
 * turn runs. So is the empty conversation's invitation. Switching back to English restores each one. A slow chat
 * double keeps a turn running long enough to read the running words.
 */

const CAPABILITY = 'the composer in Chinese'

function scratchProfile(home, baseUrl) {
  const profile = join(home, 'composer-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({ default: 'slow', endpoints: [{ name: 'slow', kind: 'openai-chat', baseUrl, model: 'm', apiKey: 'k' }] }),
  )
  return profile
}

/** An OpenAI-compatible double that holds each turn for a while before it answers, so a turn is seen running. */
async function slowDouble(holdMs) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'm' }] }))
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, holdMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => { server.closeAllConnections(); server.close() } }
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

const WORDS = `({
  placeholder: document.querySelector('#prompt textarea').getAttribute('placeholder'),
  attach: document.getElementById('attach').getAttribute('aria-label'),
  attachTitle: document.getElementById('attach').title,
  pending: document.getElementById('attach-cards').getAttribute('aria-label'),
  send: document.getElementById('send').getAttribute('aria-label'),
  sendTitle: document.getElementById('send').title,
  stop: document.getElementById('stop').getAttribute('aria-label'),
  empty: document.querySelector('#empty-state h3').textContent,
})`

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

test('the composer and the empty conversation follow the interface language, idle and while a turn runs', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-composer')
  const double = await slowDouble(4_000)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000), 'the page is up')
    const english = await browser.evaluate(WORDS)
    assert.equal(english.placeholder, 'Message or run a task, / commands, @ files or sessions')
    assert.equal(english.send, 'Send message')

    await chooseLanguage(browser, 'zh')
    assert.deepEqual(await browser.evaluate(WORDS), {
      placeholder: '发消息或创建任务, / 调用指令, @ 文件或对话',
      attach: '添加文件或调用指令',
      attachTitle: '添加文件或插入工作区路径',
      pending: '待发送附件',
      send: '发送消息',
      sendTitle: '发送消息 — Enter · Shift+Enter 换行',
      stop: '停止生成',
      empty: '开始对话',
    }, 'the idle composer and the invitation are in Chinese')

    await browser.evaluate(`(() => {
      const field = document.querySelector('#prompt textarea')
      field.value = 'hello'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
      return true
    })()`)
    assert.ok(await browser.waitFor(`!document.getElementById('stop').hidden`, 10_000), 'a turn is running')
    const running = await browser.evaluate(`({ send: document.getElementById('send').getAttribute('aria-label'), stop: document.getElementById('stop').getAttribute('aria-label') })`)
    assert.deepEqual(running, { send: '排队发送', stop: '停止生成' }, 'while a turn runs, Enter queues and Stop is offered, in Chinese')

    await chooseLanguage(browser, 'en')
    const back = await browser.evaluate(`({ send: document.getElementById('send').getAttribute('aria-label'), placeholder: document.querySelector('#prompt textarea').getAttribute('placeholder') })`)
    assert.deepEqual(back, { send: 'Queue message', placeholder: 'Message or run a task, / commands, @ files or sessions' }, 'and English comes back at once')
    assert.ok(await browser.waitFor(`document.getElementById('stop').hidden`, 15_000), 'the turn finishes')
  } finally {
    browser.close()
    server.kill()
    double.close()
    removeDir(home)
  }
})
