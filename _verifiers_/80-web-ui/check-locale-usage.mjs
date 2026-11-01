import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, heddleCommand, isolatedHome, repoRoot, removeDir, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 27: a completed turn's own token-usage row in DSH's own Chinese where
 * DSH has the words (dsh-client-ui-chat's message.turnUsage.*: 用量, 未缓存输入, 缓存读取, 缓存写入, 输出).
 *
 * After one turn whose provider reported 1000 prompt tokens (800 of them cached) and 50 output tokens, a Chinese page's
 * row reads 用量 · 1,050 closed and opens to 未缓存输入 200, 缓存读取 800 and 输出 50. Switched to English in Settings with
 * the row open, it reads Tokens · 1,050 with Input 200, Cache read 800 and Output 50, the bytes the row had before.
 */

const CAPABILITY = "a turn's token-usage row in the page language"

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'usage-profile')
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


const ROW = `JSON.stringify((() => {
  const rows = [...document.querySelectorAll('#log .turn.assistant .turn-usage')]
  const row = rows.at(-1)
  if (row === undefined) return null
  return {
    rows: rows.length,
    open: row.open,
    summary: row.querySelector('summary').textContent,
    buckets: [...row.querySelectorAll('[data-bucket]')].map((node) => [node.dataset.bucket, node.textContent]),
  }
})())`

test("a turn's token-usage row reads in the page language, and follows a change made in Settings", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-usage')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const double = await chatDouble({ content: 'the answer', reasoning: 'thinking', holdOpenMs: 50, usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } })
  const config = writeJson(join(home, 'heddle.json'), { default: 'held', endpoints: [{ name: 'held', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'held-model', stream: true }] })
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
    assert.ok(await browser.waitFor(`document.querySelector('#log .turn.assistant .turn-usage') !== null`, 20_000), 'the completed turn has its usage row')

    const chinese = JSON.parse(await browser.evaluate(ROW))
    assert.equal(chinese.rows, 1)
    assert.equal(chinese.summary, '用量 · 1,050', 'closed, it reads the turn\u2019s total')
    assert.deepEqual(chinese.buckets, [['inputTokens', '未缓存输入 200'], ['cacheReadTokens', '缓存读取 800'], ['outputTokens', '输出 50']])

    // Open, the row follows the language changed in Settings.
    await browser.evaluate(`(() => { document.querySelector('#log .turn-usage summary').click(); return true })()`)
    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.querySelector('#log .turn-usage summary')?.textContent === 'Tokens · 1,050'`, 10_000), 'the row reads in English')
    const english = JSON.parse(await browser.evaluate(ROW))
    assert.equal(english.open, true, 'and stays open')
    assert.deepEqual(english.buckets, [['inputTokens', 'Input 200'], ['cacheReadTokens', 'Cache read 800'], ['outputTokens', 'Output 50']])
  } finally {
    browser?.close()
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
