import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 14: the automation-task pages in DSH's own Chinese
 * (dsh-client-ui-schedule). A Chinese browser's task page reads 自动化任务, with 新建, the 全部 / 已开启 / 已结束
 * filters, 搜索自动化任务, and an empty catalog's 还没有自动化任务，在会话中创建的任务会显示在这里 with 新建自动化任务.
 */

const CAPABILITY = 'the automation-task page in Chinese'

function scratchProfile(home, baseUrl) {
  const profile = join(home, 'schedules-profile')
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

test('the automation-task page follows the interface language in DSH\'s words', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-schedules')
  const double = await slowDouble(100)
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
  const server = await startServer(['--profile', scratchProfile(home, double.baseUrl), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await browser.evaluate(`(() => { document.getElementById('automation-tasks').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('schedules-page')?.hidden === false`, 10_000), 'the task page opens')
    assert.ok(await browser.waitFor(`document.querySelector('#schedules-list')?.textContent.includes('还没有自动化任务')`, 10_000).catch(() => false),
      `the empty catalog in DSH's words (${await browser.evaluate(`document.getElementById('schedules-list').textContent`)})`)
    const words = await browser.evaluate(`({
      page: document.getElementById('schedules-page').getAttribute('aria-label'),
      heading: document.getElementById('schedules-heading').textContent,
      fresh: document.querySelector('#schedules-new span').textContent,
      filters: [...document.querySelectorAll('.sched-filter')].map((button) => button.textContent),
      group: document.querySelector('.sched-filters').getAttribute('aria-label'),
      search: document.getElementById('schedules-search').getAttribute('placeholder'),
      searchName: document.getElementById('schedules-search').getAttribute('aria-label'),
      list: document.getElementById('schedules-list').textContent,
    })`)
    assert.equal(words.page, '自动化任务')
    assert.equal(words.heading, '自动化任务')
    assert.equal(words.fresh, '新建')
    assert.deepEqual(words.filters, ['全部', '已开启', '已结束'])
    assert.equal(words.group, '任务状态')
    assert.equal(words.search, '搜索自动化任务')
    assert.equal(words.searchName, '搜索任务')
    assert.ok(words.list.includes('还没有自动化任务，在会话中创建的任务会显示在这里'), words.list)
    assert.ok(words.list.includes('新建自动化任务'), 'with DSH\'s action')
  } finally {
    browser.close()
    server.kill()
    double.close()
    removeDir(home)
  }
})
