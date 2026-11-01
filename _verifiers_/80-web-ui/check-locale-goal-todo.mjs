import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, repoRoot, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (#80), slice 3, section 18: the goal dock, the to-do dock and the to-do card in DSH's own
 * Chinese (dsh-client-ui-goal's phase.* and action.*, dsh-client-ui-conversation's todo.*).
 *
 * A paused goal reads 已暂停的目标 with 恢复目标 / 完成目标 / 编辑目标 / 清除目标; a todo_write call is 更新任务清单 with
 * 1/3 已完成 and 新增 3, its items 已完成 / 进行中 / 待处理; the dock counts 1 已完成 · 1 进行中 · 1 待处理. Switched to
 * English in Settings, all three read in English again.
 */

const CAPABILITY = 'the goal and to-do docks in the page language'

/** A profile holding the project's tree with absolute module names, so the language write stays inside `home`. */
function profileIn(home) {
  const profile = join(home, 'goal-todo-profile')
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

const ROW = `document.querySelector('#log details.turn.tool[data-tool-name="todo_write"]')`
const WORDS = `JSON.stringify({
  phase: document.getElementById('goal-phase').textContent,
  rounds: document.getElementById('goal-rounds').textContent,
  actions: [...document.querySelectorAll('#goal-actions button')].map((button) => button.getAttribute('aria-label')),
  title: ${ROW}?.querySelector(':scope > summary .title')?.textContent ?? null,
  suffix: ${ROW}?.querySelector(':scope > summary .todo-call-suffix')?.textContent ?? null,
  line: ${ROW}?.querySelector(':scope > summary')?.textContent ?? null,
  statuses: [...(${ROW}?.querySelectorAll('.todo-call-status') ?? [])].map((node) => node.textContent.trim()),
  progress: document.getElementById('todo-progress')?.textContent ?? null,
  glyphs: [...document.querySelectorAll('#todo-list .todo-glyph')].map((glyph) => glyph.getAttribute('aria-label')),
})`

test('the goal dock, the to-do dock and the to-do card read in the page language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('locale-goal-todo')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const plan = [
    { content: 'research the reference', status: 'completed' },
    { content: 'write the service', status: 'in_progress' },
    { content: 'build the panel', status: 'pending' },
  ]
  const { config, script } = scriptedConfig({ home, steps: [{ toolCall: { name: 'todo_write', arguments: { todos: plan } } }, { text: 'plan written' }] })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', profileIn(home), '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  let browser = null
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, `the handshake set a cookie (status ${handshake.status})`)
    const api = async (path, body) => {
      const response = await fetch(new URL(path, server.url), { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    await api('/api/workspaces', { path: work })
    const opened = (await api('/api/folders/session', { folder: work })).body
    const session = opened.session?.id ?? opened.id
    assert.equal(typeof session, 'string', 'a session was opened')
    const turn = await api('/api/turn', { prompt: 'plan the work', folder: work, session })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'noted' }] }))
    // A goal created at rest is armed; it is paused at once, so the dock is drawn from a goal with no round in flight.
    const created = await api('/api/goal', { session, action: 'create', objective: 'ship the docs', max_goal_rounds: 5 })
    assert.equal(created.status, 200, `the goal was created (${JSON.stringify(created.body)})`)
    const paused = await api('/api/goal', { session, action: 'pause', goal_id: created.body.goal.id, revision: created.body.goal.revision })
    assert.equal(paused.body?.goal?.phase, 'paused', `the goal is paused (${JSON.stringify(paused.body)})`)

    browser = await openBrowser({ width: 1280, height: 900 })
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    await browser.gotoSession(server.url, session)
    assert.ok(await browser.waitFor(`document.body.dataset.ready === 'true' && document.documentElement.getAttribute('lang') === 'zh-CN'`, 20_000), 'a Chinese browser gets the Chinese page')
    assert.ok(await browser.waitFor(`document.getElementById('goal-bar')?.dataset.phase === 'paused' && ${ROW}?.dataset.todoCard === 'dsh' && document.getElementById('todo-panel')?.hidden === false`, 20_000), 'the goal dock, the to-do card and the to-do dock are drawn')

    const chinese = JSON.parse(await browser.evaluate(WORDS))
    assert.equal(chinese.phase, '已暂停的目标')
    assert.match(chinese.rounds, /^第 \d+\/5 轮$/, chinese.rounds)
    assert.deepEqual(chinese.actions, ['恢复目标', '完成目标', '编辑目标', '清除目标'])
    assert.equal(chinese.title, '更新任务清单')
    assert.equal(chinese.suffix, '新增 3')
    assert.ok((chinese.line ?? '').includes('1/3 已完成'), chinese.line)
    assert.deepEqual(chinese.statuses, ['已完成', '进行中', '待处理'])
    assert.equal(chinese.progress, '1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
    assert.deepEqual(chinese.glyphs, ['已完成', '进行中', '待处理'])

    await chooseLanguage(browser, 'en', 'en')
    assert.ok(await browser.waitFor(`document.getElementById('goal-phase').textContent === 'Paused Goal'`, 10_000), 'the goal dock reads in English')
    const english = JSON.parse(await browser.evaluate(WORDS))
    assert.match(english.rounds, /^round \d+\/5$/, english.rounds)
    assert.deepEqual(english.actions, ['Resume goal', 'Complete goal', 'Edit goal', 'Clear goal'])
    assert.equal(english.title, 'Update to-do list')
    assert.equal(english.suffix, '3 added')
    assert.ok((english.line ?? '').includes('1/3 completed'), english.line)
    assert.deepEqual(english.statuses, ['Completed', 'In progress', 'Pending'])
    assert.equal(english.progress, '1 done\u2002·\u20021 in progress\u2002·\u20021 pending')
  } finally {
    browser?.close()
    server.kill()
    removeDir(home)
  }
})
