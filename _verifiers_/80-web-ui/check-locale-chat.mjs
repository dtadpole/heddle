import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 11: the conversation's own words. In a Chinese browser a running turn
 * says 编织中 and then 已编织 {duration} ···; a finished answer offers 复制此回答 and 在新对话中分支, the person's message
 * 复制; and the + menu's computer-side item is 文件, titled 从这台电脑添加文件 (DSH's input.file).
 */

const CAPABILITY = 'the conversation in Chinese'

function scratchProfile(home, baseUrl) {
  const profile = join(home, 'chat-profile')
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

test('the conversation\'s own words follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-chat')
  const double = await slowDouble(2_500)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')

    // The + menu's computer-side item.
    await browser.evaluate(`(() => { document.getElementById('attach').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#attach-menu .attach-add-file') !== null`, 5_000).catch(() => false), 'the + menu opens')
    const file = await browser.evaluate(`(() => { const item = document.querySelector('#attach-menu .attach-add-file'); return { text: item.textContent, title: item.title } })()`)
    assert.deepEqual(file, { text: '文件', title: '从这台电脑添加文件' }, 'DSH\'s 文件')
    await browser.evaluate(`(() => { document.getElementById('attach').click(); return true })()`)

    // A running turn says how long it has been weaving.
    await browser.evaluate(`(() => {
      const field = document.querySelector('#prompt textarea')
      field.value = 'hello'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
      return true
    })()`)
    assert.ok(
      await browser.waitFor(`/^已编织 .+ ···$/.test(document.querySelector('.chat-running .label')?.textContent ?? '')`, 10_000).catch(() => false),
      `the running row in Chinese (${JSON.stringify(await browser.evaluate(`document.querySelector('.chat-running')?.textContent ?? null`))})`,
    )
    assert.ok(await browser.waitFor(`document.getElementById('stop').hidden`, 15_000), 'the turn finishes')

    // The finished turn's actions.
    assert.ok(await browser.waitFor(`document.querySelector('#log [data-action="branch"]') !== null`, 10_000).catch(() => false), 'the answer offers Branch')
    const actions = await browser.evaluate(`(() => {
      const names = [...document.querySelectorAll('#log button.action')].map((button) => button.getAttribute('aria-label'))
      return { names, branch: document.querySelector('#log [data-action="branch"]').getAttribute('aria-label') }
    })()`)
    assert.equal(actions.branch, '在新对话中分支')
    assert.ok(actions.names.includes('复制此回答'), `the answer's copy (${actions.names.join(' | ')})`)
    assert.ok(actions.names.includes('复制'), `the message's copy (${actions.names.join(' | ')})`)
  } finally {
    browser.close()
    server.kill()
    double.close()
    removeDir(home)
  }
})
