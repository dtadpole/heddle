import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 19: the rest of the Trajectory area after section 17.
 *
 * On a Chinese page a user record's row counts 图片 ×1 · 文件 ×1 (DSH's layout.imageCount / layout.fileAttachments), its
 * inspector's thumbnail is named 打开 pixel.png, a tool call still waiting for its answer reads 无输出 (DSH's
 * record.noOutput), the overview's ticks name their kinds in Chinese (用户, 助手, 工具 …), a collapsed turn reads
 * 「N 条记录 — 点击展开」, and a ledger read that fails says 无法读取轨迹：…. Switched to English in Settings, the same
 * places read in English again: 1 image · 1 file, open pixel.png, no output, turn 1 · user, N records — click to expand,
 * and could not read the ledger: ….
 */

const CAPABILITY = 'the rest of the Trajectory area in the page language'

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const ASK = { toolCall: { name: 'ask_user_question', arguments: { questions: [{ id: 'note', question: 'Anything else?' }] } } }

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'trajectory-tail-profile')
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


const WORDS = `JSON.stringify({
  counts: document.querySelector('#tr-table tbody .tr-attach-count')?.textContent ?? null,
  noOutput: document.querySelector('#tr-table tbody .tr-result.tr-no-output')?.textContent ?? null,
  thumb: document.querySelector('#tr-details .tr-attach-thumb')?.getAttribute('aria-label') ?? null,
  tips: [...document.querySelectorAll('#timeline .tr-tick')].map((tick) => tick.dataset.tipLabel ?? ''),
})`
const COLLAPSED = `[...document.querySelectorAll('#tr-table tbody tr[data-turn-start="true"] .tr-content > .tr-text')].map((node) => node.textContent)`

/** Make the next ledger reads fail as an unreachable server's do, enter the view again, and give fetch back. */
async function failedRead(browser) {
  await browser.evaluate(`(() => {
    window.__trFetch = window.__trFetch ?? window.fetch
    window.fetch = (input, init) => String(input).includes('view=ledger') ? Promise.reject(new TypeError('offline')) : window.__trFetch(input, init)
    document.getElementById('tab-chat').click()
    document.getElementById('tab-trajectory').click()
    return true
  })()`)
  const appeared = await browser.waitFor(`/offline$/.test(document.querySelector('#ledger .turn.denied')?.textContent ?? '')`, 10_000)
  const text = await browser.evaluate(`document.querySelector('#ledger .turn.denied')?.textContent ?? null`)
  await browser.evaluate(`(() => { window.fetch = window.__trFetch; return true })()`)
  assert.ok(appeared, `the failed read is noted (${text})`)
  return text
}

test('the rest of the Trajectory area reads in the page language, and follows a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-trajectory-tail')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'one\n')
  const { config, script } = scriptedConfig({ home, steps: [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'the folder holds one file' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  const waiting = new AbortController()
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const origin = new URL(server.url).origin
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, text: await response.text() }
    }
    const upload = async (name, body) => {
      const answer = await fetch(new URL(`/api/uploads?name=${encodeURIComponent(name)}`, server.url), { method: 'POST', headers: { cookie, origin }, body })
      assert.equal(answer.status, 200, `the upload of ${name} was stored (${answer.status})`)
      return String((await answer.json()).path ?? '')
    }
    await api('/api/workspaces', { path: work })
    const opened = JSON.parse((await api('/api/folders/session', { folder: work })).text)
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')
    const attachments = [await upload('pixel.png', PIXEL), await upload('notes.txt', 'a few notes\n')]
    const turn = await api('/api/turn', { prompt: 'what is in here', folder: work, session, attachments })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)

    // A second turn asks the person a question and waits for the answer, so its call has no result yet.
    writeFileSync(script, JSON.stringify({ steps: [ASK, { text: 'thanks' }] }))
    void fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'ask me one thing', folder: work, session }),
      signal: waiting.signal,
    }).then((response) => response.text()).catch(() => {})
    let pending = false
    for (let attempt = 0; attempt < 60 && !pending; attempt += 1) {
      const view = JSON.parse((await api(`/api/sessions/${encodeURIComponent(session)}?view=ledger`)).text)
      pending = (view.rows ?? []).some((row) => row.kind === 'tool' && row.record?.name === 'ask_user_question' && String(row.record?.result ?? '') === '')
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(pending, 'the ledger holds the question call with no result yet')

    browser = await openBrowser({ width: 1440, height: 1000 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    await browser.evaluate(`(() => { document.getElementById('tab-trajectory').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#tr-table tbody .tr-attach-count') !== null && document.querySelector('#tr-table tbody .tr-result.tr-no-output') !== null && document.querySelectorAll('#timeline .tr-tick').length > 0`, 20_000), 'the table drew the user row, the waiting call, and the overview')
    await browser.evaluate(`(() => { document.querySelector('#tr-table tbody .tr-attach-count').closest('tr').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#tr-details .tr-attach-thumb') !== null`, 10_000), 'the inspector lists the image')

    const chinese = JSON.parse(await browser.evaluate(WORDS))
    assert.equal(chinese.counts, '图片 ×1 · 文件 ×1')
    assert.equal(chinese.noOutput, '无输出')
    assert.equal(chinese.thumb, '打开 pixel.png')
    assert.ok(chinese.tips.some((tip) => /^第 1 轮 · .*用户/.test(tip)), `a tick names its kinds in Chinese (${JSON.stringify(chinese.tips)})`)
    assert.ok(chinese.tips.every((tip) => !/\b(user|assistant|reasoning|tool|context|system|compaction)\b/.test(tip)), `no English kind is left (${JSON.stringify(chinese.tips)})`)
    assert.match(await failedRead(browser), /^无法读取轨迹：offline$/)
    await browser.evaluate(`(() => { document.getElementById('tr-turns').click(); return true })()`)
    assert.ok(await browser.waitFor(`${COLLAPSED}.length > 0 && ${COLLAPSED}.every((text) => text.startsWith('▸'))`, 5_000), 'the turns collapse')
    const collapsed = JSON.parse(await browser.evaluate(`JSON.stringify(${COLLAPSED})`))
    assert.ok(collapsed.every((text) => /^▸ \d+ 条记录 — 点击展开$/.test(text)), JSON.stringify(collapsed))

    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`${COLLAPSED}.length > 0 && ${COLLAPSED}.every((text) => text.endsWith('records — click to expand'))`, 10_000), 'a collapsed turn reads in English')
    const collapsedEnglish = JSON.parse(await browser.evaluate(`JSON.stringify(${COLLAPSED})`))
    assert.ok(collapsedEnglish.every((text) => /^▸ \d+ records — click to expand$/.test(text)), JSON.stringify(collapsedEnglish))
    await browser.evaluate(`(() => { document.getElementById('tr-turns').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.querySelector('#tr-table tbody .tr-attach-count') !== null && document.querySelector('#tr-table tbody .tr-result.tr-no-output') !== null`, 5_000), 'the turns expand')
    const english = JSON.parse(await browser.evaluate(WORDS))
    assert.equal(english.counts, '1 image · 1 file')
    assert.equal(english.noOutput, 'no output')
    assert.equal(english.thumb, 'open pixel.png')
    assert.ok(english.tips.some((tip) => /^turn 1 · .*\buser\b/.test(tip)), `a tick names its kinds in English (${JSON.stringify(english.tips)})`)
    assert.ok(english.tips.every((tip) => !/[用助工思]/.test(tip)), `no Chinese kind is left (${JSON.stringify(english.tips)})`)
    assert.match(await failedRead(browser), /^could not read the ledger: offline$/)
  } finally {
    waiting.abort()
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
