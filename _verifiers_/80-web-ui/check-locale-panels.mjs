import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 12: the panels' leftover words. In a Chinese browser the model
 * pane's search offers 清除搜索 for a typed query, and a message queued behind a running turn carries DSH's queue
 * actions — 插话发送, 编辑排队消息 and 删除排队消息 — with the edit field and its 保存排队消息 and 取消编辑.
 */

const CAPABILITY = 'the panels in Chinese'

function scratchProfile(home, baseUrl) {
  const profile = join(home, 'panels-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  writeFileSync(
    join(home, 'heddle.json'),
    JSON.stringify({ default: 'slow', endpoints: [{ name: 'slow', kind: 'openai-chat', baseUrl, model: 'm', apiKey: 'k', models: [{ id: 'm', name: 'Main' }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }, { id: 'd', name: 'Delta' }] }] }),
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

test('the panels\' leftover words follow the interface language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-panels')
  const double = await slowDouble(5_000)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')

    // The model pane's search: a typed query offers its clear button.
    await browser.evaluate(`(() => { document.getElementById('model-trigger').click(); return true })()`)
    await browser.waitFor(`!document.getElementById('model-menu').hidden && document.querySelector('#model-menu .model-cell') !== null`, 5_000)
    await browser.evaluate(`(() => { document.querySelector('#model-menu .model-cell').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#model-menu input[role="searchbox"]') !== null`, 5_000).catch(() => false), 'the model pane offers its search')
    await browser.evaluate(`(() => {
      const field = document.querySelector('#model-menu input[role="searchbox"]')
      field.value = 'al'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#model-menu .model-search-clear') !== null`, 5_000).catch(() => false), 'a typed query offers a clear button')
    assert.equal(await browser.evaluate(`document.querySelector('#model-menu .model-search-clear').getAttribute('aria-label')`), '清除搜索')
    await browser.evaluate(`(() => { document.getElementById('model-menu').hidden = true; return true })()`)

    // A message queued behind a running turn.
    const send = (text) => browser.evaluate(`(() => {
      const field = document.querySelector('#prompt textarea')
      field.value = ${JSON.stringify(text)}
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
      return true
    })()`)
    await send('first')
    assert.ok(await browser.waitFor(`!document.getElementById('stop').hidden`, 10_000), 'a turn is running')
    await send('second')
    const QUEUE = `[...document.querySelectorAll('#queue button[aria-label], .queue button[aria-label], [data-queue] button[aria-label]')].map((button) => button.getAttribute('aria-label'))`
    assert.ok(await browser.waitFor(`${QUEUE}.includes('编辑排队消息')`, 5_000).catch(() => false), `the queued message's actions (${JSON.stringify(await browser.evaluate(QUEUE))})`)
    const actions = await browser.evaluate(QUEUE)
    assert.ok(actions.includes('插话发送') && actions.includes('删除排队消息'), `DSH's queue actions: ${actions.join(' | ')}`)
    await browser.evaluate(`(() => { [...document.querySelectorAll('button[aria-label="编辑排队消息"]')][0].click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('textarea[aria-label="编辑排队消息"]') !== null`, 5_000).catch(() => false), 'the edit field is named in Chinese')
    const editing = await browser.evaluate(QUEUE)
    assert.ok(editing.includes('保存排队消息') && editing.includes('取消编辑'), `the edit's actions: ${editing.join(' | ')}`)
  } finally {
    browser.close()
    server.kill()
    double.close()
    removeDir(home)
  }
})
