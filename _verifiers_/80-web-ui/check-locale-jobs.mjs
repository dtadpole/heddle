import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 22: the session header's background-jobs control in DSH's own Chinese
 * (dsh-client-ui-jobs: count.*, status.*, duration.*, row.*, kill.*, terminal.noOutput, output.*).
 *
 * With one background job running that prints nothing, a Chinese page's trigger reads 1 个后台任务运行中; the open list's
 * row is 展开 … 的实时输出 (收起 … once expanded), its status 运行中, its duration N秒 titled 已运行 N秒, its terminal （无输出）,
 * and its stop button 停止任务 …, then 再次点击确认停止 with 确认停止, then 停止失败 when the stop is refused. Switched to
 * English in Settings, the same places read in English again.
 */

const CAPABILITY = 'the background-jobs control in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'jobs-profile')
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


const READ = `JSON.stringify({
  trigger: document.getElementById('jobs-trigger')?.getAttribute('aria-label') ?? null,
  count: document.querySelector('#jobs-trigger .jobs-count')?.textContent ?? null,
  row: document.querySelector('#jobs-menu .jobs-row')?.getAttribute('aria-label') ?? null,
  status: document.querySelector('#jobs-menu .jobs-secondary')?.title ?? null,
  duration: document.querySelector('#jobs-menu .jobs-duration')?.textContent ?? null,
  durationTitle: document.querySelector('#jobs-menu .jobs-duration')?.title ?? null,
  stop: document.querySelector('#jobs-menu .jobs-stop')?.getAttribute('aria-label') ?? null,
  stopLabel: document.querySelector('#jobs-menu .jobs-stop-label')?.textContent ?? null,
  output: document.querySelector('#jobs-menu .jobs-term-output')?.textContent ?? null,
})`
const read = async (browser) => JSON.parse(await browser.evaluate(READ))
const click = (browser, selector) => browser.evaluate(`(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true })()`)

/** Open the list if it is closed. */
async function openList(browser) {
  await browser.evaluate(`(() => { if (document.getElementById('jobs-trigger').getAttribute('aria-expanded') !== 'true') document.getElementById('jobs-trigger').click(); return true })()`)
  assert.ok(await browser.waitFor(`document.querySelector('#jobs-menu .jobs-row') !== null`, 10_000), 'the list shows the job')
}

/** Press Stop until it is armed, then press it again while the kill route is refused, and give fetch back. */
async function refusedStop(browser) {
  await browser.evaluate(`(() => {
    window.__jobsFetch = window.__jobsFetch ?? window.fetch
    window.fetch = (input, init) => String(input) === '/api/jobs/kill' ? Promise.reject(new TypeError('offline')) : window.__jobsFetch(input, init)
    return true
  })()`)
  await click(browser, '#jobs-menu .jobs-stop')
  assert.ok(await browser.waitFor(`document.querySelector('#jobs-menu .jobs-stop')?.dataset.killState === 'armed'`, 5_000), 'the first press arms Stop')
  const armed = await read(browser)
  await click(browser, '#jobs-menu .jobs-stop')
  assert.ok(await browser.waitFor(`document.querySelector('#jobs-menu .jobs-stop')?.dataset.killState === 'failed'`, 5_000), 'a refused stop says so')
  const failed = await read(browser)
  await browser.evaluate(`(() => { window.fetch = window.__jobsFetch; return true })()`)
  return { armed, failed }
}

test('the background-jobs control reads in the page language, and follows a change made in Settings', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-jobs')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 120', run_in_background: true } } }, { text: 'started it' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  let api = null
  let session = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    await api('/api/workspaces', { path: work })
    const opened = (await api('/api/folders/session', { folder: work })).body
    session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')
    const turn = await api('/api/turn', { prompt: 'start a quiet job', folder: work, session })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    const listed = (await api(`/api/jobs?session=${encodeURIComponent(session)}`)).body.jobs ?? []
    assert.ok(listed.some((job) => job.status === 'running'), `a background job runs (${JSON.stringify(listed)})`)

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    assert.ok(await browser.waitFor(`document.getElementById('jobs-trigger')?.getAttribute('aria-label') === '1 个后台任务运行中'`, 20_000), 'the trigger counts the running job in Chinese')
    await openList(browser)
    const chinese = await read(browser)
    assert.equal(chinese.count, '1 个后台任务运行中')
    assert.match(chinese.row ?? '', /^展开 .+ 的实时输出$/)
    assert.equal(chinese.status, '运行中')
    assert.match(chinese.duration ?? '', /^(\d+分)?\d+秒$/)
    assert.match(chinese.durationTitle ?? '', /^已运行 (\d+分)?\d+秒$/)
    assert.match(chinese.stop ?? '', /^停止任务 .+/)
    await click(browser, '#jobs-menu .jobs-row')
    assert.ok(await browser.waitFor(`document.querySelector('#jobs-menu .jobs-term-output') !== null`, 5_000), 'the row expands')
    const expanded = await read(browser)
    assert.match(expanded.row ?? '', /^收起 .+ 的实时输出$/)
    assert.equal(expanded.output, '（无输出）')
    const zhStop = await refusedStop(browser)
    assert.equal(zhStop.armed.stop, '再次点击确认停止')
    assert.equal(zhStop.armed.stopLabel, '确认停止')
    assert.equal(zhStop.failed.stop, '停止失败')

    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.getElementById('jobs-trigger')?.getAttribute('aria-label') === '1 background job running'`, 10_000), 'the trigger reads in English')
    await openList(browser)
    if ((await read(browser)).output === null) await click(browser, '#jobs-menu .jobs-row')
    assert.ok(await browser.waitFor(`document.querySelector('#jobs-menu .jobs-term-output') !== null`, 5_000), 'the row is expanded')
    const english = await read(browser)
    assert.equal(english.count, '1 background job running')
    assert.match(english.row ?? '', /^Hide live output of .+/)
    assert.equal(english.status, 'running')
    assert.match(english.duration ?? '', /^(\d+m )?\d+s$/)
    assert.match(english.durationTitle ?? '', /^Running for (\d+m )?\d+s$/)
    assert.equal(english.output, '(no output)')
    const enStop = await refusedStop(browser)
    assert.equal(enStop.armed.stop, 'Click again to confirm')
    assert.equal(enStop.armed.stopLabel, 'Confirm stop')
    assert.equal(enStop.failed.stop, 'Stop failed')
  } finally {
    browser?.close()
    if (api !== null && session !== null) {
      try {
        for (const job of (await api(`/api/jobs?session=${encodeURIComponent(session)}`)).body.jobs ?? []) {
          if (job.status === 'running') await api('/api/jobs/kill', { session, job: job.id })
        }
      } catch {
        // A server already gone has nothing to stop.
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    server.kill()
    removeDir(home)
  }
})
