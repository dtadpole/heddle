import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The todo dock, judged where a model writes it and a person reads it.
 *
 * The claim is DSH's: a `todo_write` call becomes a **durable** `todo/write` snapshot, and the panel above the
 * composer shows the list **live** — appears without a reload when the first write lands, updates the counts and
 * the statuses on the next write, and disappears when the list is emptied. The anatomy is the one measured from
 * DSH's rendered TodoPanel: a "To-dos" header, zero-omitted counts joined by an en-space middot, collapsed by
 * default, expanding to a status-dotted list with accessible status labels.
 */

const CAPABILITY = 'todo'

function cookieFor(handshake) {
  return (handshake.headers.get('set-cookie') ?? '').split(';')[0]
}

async function startServer(steps) {
  const home = isolatedHome('todo-check')
  const work = fixtureDir('todo-check-work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps })
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        resolve(match[1])
      }
    }, 50)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error('server did not start\n' + out))
    }, 15_000)
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = cookieFor(handshake)
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  /**
   * The scripted endpoint reads its script **per request** and hands steps out by **round index within a turn**,
   * not by a global counter (measured: a second turn replayed round 0). A multi-turn check therefore rewrites
   * the script between turns instead of appending steps to one list.
   */
  const setScript = (steps) => writeFileSync(script, JSON.stringify({ steps }))
  return { url, work, api, script, setScript, close: () => child.kill() }
}

test('the model writes a todo list and the dock shows it live, updates it and hides it when emptied', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const plan = [
    { content: 'research the reference', status: 'in_progress' },
    { content: 'write the service', status: 'pending' },
    { content: 'build the panel', status: 'pending' },
  ]
  const done = [
    { content: 'research the reference', status: 'completed' },
    { content: 'write the service', status: 'completed' },
    { content: 'build the panel', status: 'in_progress' },
  ]
  const server = await startServer([
    { toolCall: { name: 'todo_write', arguments: { todos: plan } } },
    { text: 'plan written' },
  ])
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    await browser.gotoSession(server.url, session)
    await browser.waitFor('document.getElementById("todo-panel") !== null', 20_000)
    assert.equal(await browser.evaluate('document.getElementById("todo-panel").hidden'), true, 'no list, no dock')

    const turn = async (prompt) => {
      const response = await fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie: cookieFor(await fetch(server.url, { redirect: 'manual' })), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, folder: server.work, session }),
      })
      assert.equal(response.status, 200, `the turn ran (${response.status})`)
      await response.text()
    }

    // 1. the first write is a live edge: the dock appears without a reload, collapsed, with DSH's counts.
    await turn('plan the work')
    await browser.waitFor('document.getElementById("todo-panel").hidden === false', 20_000)
    const header = JSON.parse(await browser.evaluate(`(() => {
      const panel = document.getElementById('todo-panel')
      const header = document.getElementById('todo-header')
      const card = document.getElementById('composer-card')
      return JSON.stringify({
        ariaLabel: panel.getAttribute('aria-label'),
        title: document.getElementById('todo-title').textContent,
        progress: document.getElementById('todo-progress').textContent,
        expanded: header.getAttribute('aria-expanded'),
        listHidden: document.getElementById('todo-list').hidden,
        panelWidth: Math.round(panel.getBoundingClientRect().width),
        cardWidth: Math.round(card.getBoundingClientRect().width),
        lead: document.getElementById('todo-lead').querySelector('svg') !== null,
        chevron: document.getElementById('todo-chevron').querySelector('svg') !== null,
      })
    })()`))
    assert.equal(header.ariaLabel, 'To-dos', 'DSH labels the panel "To-dos"')
    assert.equal(header.title, 'To-dos')
    assert.equal(header.progress, '1 in progress\u2002·\u20022 pending', 'zero-omitted counts joined by an en-space middot')
    assert.equal(header.expanded, 'false', 'collapsed by default, as DSH ships it')
    assert.equal(header.listHidden, true)
    assert.ok(header.lead && header.chevron, 'the header carries the checklist glyph and the chevron')
    assert.ok(Math.abs(header.cardWidth - header.panelWidth - 32) <= 1, `the dock is DSH's 32px narrower than the input card (panel ${header.panelWidth} vs card ${header.cardWidth})`)

    // 2. expanding shows the status-dotted list with accessible labels.
    await browser.evaluate('document.getElementById("todo-header").click()')
    await browser.waitFor('document.getElementById("todo-list").hidden === false', 10_000)
    const items = JSON.parse(await browser.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#todo-list li')).map((li) => ({ status: li.dataset.status, text: li.querySelector('.todo-content').textContent, glyph: li.querySelector('.todo-glyph').getAttribute('aria-label') })))`))
    assert.deepEqual(items, [
      { status: 'in_progress', text: 'research the reference', glyph: 'In progress' },
      { status: 'pending', text: 'write the service', glyph: 'Pending' },
      { status: 'pending', text: 'build the panel', glyph: 'Pending' },
    ])

    // 3. the second write updates the same panel live: counts move, statuses move.
    server.setScript([{ toolCall: { name: 'todo_write', arguments: { todos: done } } }, { text: 'two done' }])
    await turn('continue the work')
    await browser.waitFor('document.getElementById("todo-progress").textContent.includes("2 done")', 20_000)
    await browser.waitFor('document.querySelectorAll("#todo-list li")[0]?.dataset.status === "completed"', 20_000)
    const progress = await browser.evaluate('document.getElementById("todo-progress").textContent')
    assert.equal(progress, '2 done\u2002·\u20021 in progress', 'the counts are zero-omitted and en-space joined')
    const updated = JSON.parse(await browser.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#todo-list li')).map((li) => li.dataset.status))`))
    assert.deepEqual(updated, ['completed', 'completed', 'in_progress'])

    // 4. an empty write is a written empty list: the dock hides live, and the API keeps the fact.
    server.setScript([{ toolCall: { name: 'todo_write', arguments: { todos: [] } } }, { text: 'cleared' }])
    await turn('clear the plan')
    await browser.waitFor('document.getElementById("todo-panel").hidden === true', 20_000)
    const api = await server.api('/api/todo?session=' + encodeURIComponent(session))
    assert.equal(api.status, 200)
    assert.deepEqual(api.body.todo.todos, [], 'the API keeps the durable empty list, the panel hides it')
  } finally {
    await browser.close()
    await server.close()
  }
})

test('the todo panel sits above the goal dock when both exist', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  /**
   * DSH gives the todo dock `order: 0` and the goal dock `order: 10` in the same `conversation.input.dock`
   * (read from the two client plugins), so the todo list sits **above** the goal when both are present. This
   * test creates both and measures the two boxes rather than trusting the stylesheet.
   */
  const server = await startServer([
    { toolCall: { name: 'todo_write', arguments: { todos: [{ content: 'coexist', status: 'pending' }] } } },
    { text: 'list written' },
  ])
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    await browser.gotoSession(server.url, session)
    await browser.waitFor('document.getElementById("todo-panel") !== null', 20_000)
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: cookieFor(await fetch(server.url, { redirect: 'manual' })), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'write a list', folder: server.work, session }),
    })
    assert.equal(turn.status, 200)
    await turn.text()
    await browser.waitFor('document.getElementById("todo-panel").hidden === false', 20_000)

    // A goal beside the list, paused immediately so its driver does not run.
    const created = await server.api('/api/goal', { method: 'POST', body: JSON.stringify({ session, action: 'create', objective: 'a goal beside a todo list', max_goal_rounds: 500 }) })
    assert.equal(created.status, 200, 'the goal was created')
    await server.api('/api/goal', { method: 'POST', body: JSON.stringify({ session, action: 'pause', goal_id: created.body.goal.id, revision: created.body.goal.revision }) })
    await browser.waitFor('document.getElementById("goal-bar").hidden === false', 20_000)

    const boxes = JSON.parse(await browser.evaluate(`(() => {
      const todo = document.getElementById('todo-panel').getBoundingClientRect()
      const goal = document.getElementById('goal-bar').getBoundingClientRect()
      return JSON.stringify({ todoTop: Math.round(todo.top), todoBottom: Math.round(todo.bottom), goalTop: Math.round(goal.top), goalBottom: Math.round(goal.bottom) })
    })()`))
    assert.ok(boxes.todoBottom <= boxes.goalTop, `the todo panel is above the goal dock (todo bottom ${boxes.todoBottom}, goal top ${boxes.goalTop})`)
  } finally {
    await browser.close()
    await server.close()
  }
})
