import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Plan mode, judged at the server and at the model's door (C88; DSH's dsh-plan-mode, re-read 2026-10-29).
 *
 * DSH: `/plan` puts a session in plan mode, a `plan/mode` event in its log; every request the model then receives
 * carries the plan-mode policy section; `exit_plan_mode` is in the catalog in every mode and presents a plan for review
 * (and refuses, saying so, when no review channel exists); `/plan off` leaves, and the model is told the mode changed.
 *
 * The model's side is read from what a **provider double** received, not from the log, because the log records a
 * request's message count, not its words — and "the guidance reached the model" is the claim.
 */

const CAPABILITY = 'the Web UI'

/** A Chat Completions double: records every request body and answers from a queue of replies, then plain text. */
async function providerDouble(replies) {
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = { raw }
      }
      bodies.push(body)
      const reply = replies.shift() ?? { text: 'noted' }
      const frames = []
      if (reply.toolCall !== undefined) {
        frames.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_plan_1', type: 'function', function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        frames.push({ choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] })
        frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies, close: () => server.close() }
}

async function startServer(label, replies) {
  const home = isolatedHome(`plan-${label}`)
  const work = fixtureDir(`plan-${label}-work`)
  mkdirSync(work, { recursive: true })
  const provider = await providerDouble(replies)
  const config = join(home, 'heddle.json')
  writeFileSync(
    config,
    `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`,
  )
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    work,
    url: child.url,
    provider,
    close: () => {
      child.kill()
      provider.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`heddle web exited ${code} before printing its URL:\n${output}`))
      })
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
          reject(new Error(`heddle web printed no URL within 30s:\n${output}`))
        }
      }, 30_000)
    })()
  })
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { text }
  }
  return { status: response.status, body }
}

async function openSession(server, cookie) {
  await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
  const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
  const id = opened.body.session?.id ?? opened.body.id
  assert.match(String(id), /^session-/, `a session was opened: ${JSON.stringify(opened)}`)
  return id
}

async function turn(server, cookie, session, prompt) {
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, folder: server.work, session }),
  })
  assert.equal(response.status, 200, `the turn ran (${response.status})`)
  await response.text()
}

async function sessionLog(server, cookie, id) {
  const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/log`, server.url), { headers: { cookie } })
  assert.equal(response.status, 200)
  return (await response.text())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

const runLine = (server, cookie, id, line) =>
  api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ line }) })

/** Every system text a provider body carries, joined. */
function systemText(body) {
  return (body.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n')
}

const POLICY_OPENING = 'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode'

test('/plan puts a session in plan mode, and every request the model then gets carries the plan-mode policy', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('policy', [{ text: 'a default answer' }, { text: 'a planned answer' }, { text: 'back to work' }])
  try {
    const cookie = await cookieFor(server.url)
    const listed = await api(server.url, cookie, '/api/commands')
    const plan = (listed.body.commands ?? []).find((entry) => entry.name === 'plan')
    assert.ok(plan !== undefined, `/plan is listed (listed: ${(listed.body.commands ?? []).map((entry) => entry.name).join(', ')})`)
    assert.equal(plan.description, 'Enter or leave plan mode')
    assert.equal(plan.input?.hint, '[off|message]')

    const id = await openSession(server, cookie)
    await turn(server, cookie, id, 'say hello')
    assert.equal(server.provider.bodies.length, 1)
    assert.equal(systemText(server.provider.bodies[0]).includes(POLICY_OPENING), false, 'the default mode carries no plan policy')
    assert.ok(
      (server.provider.bodies[0].tools ?? []).some((tool) => tool.function?.name === 'exit_plan_mode'),
      'exit_plan_mode is in the catalog in every mode, as in DSH',
    )

    const entered = await runLine(server, cookie, id, '/plan')
    assert.equal(entered.body.matched, true)
    assert.equal(entered.body.text, 'Plan mode on. Use /plan off to leave.')
    assert.deepEqual((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/plan`)).body, { session: id, active: true })
    let events = await sessionLog(server, cookie, id)
    assert.ok(events.some((event) => event.type === 'plan/mode' && event.active === true), 'the log records plan/mode {active: true}')

    await turn(server, cookie, id, 'plan the change')
    const planned = server.provider.bodies[1]
    assert.ok(systemText(planned).includes(POLICY_OPENING), 'the request in plan mode carries the policy section')
    assert.ok(systemText(planned).includes('Do not edit or write files'), 'with its rule against edits')
    assert.ok(
      JSON.stringify(planned.messages).includes('The user switched this session to plan mode.'),
      'and the model is told the mode changed under it',
    )

    const left = await runLine(server, cookie, id, '/plan off')
    assert.equal(left.body.text, 'Plan mode off.')
    assert.deepEqual((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/plan`)).body, { session: id, active: false })
    await turn(server, cookie, id, 'now do it')
    const after = server.provider.bodies[2]
    assert.equal(systemText(after).includes(POLICY_OPENING), false, 'after /plan off the policy is gone')
    assert.ok(JSON.stringify(after.messages).includes('The user switched this session back to the default mode.'))
    events = await sessionLog(server, cookie, id)
    assert.deepEqual(
      events.filter((event) => event.type === 'plan/mode').map((event) => event.active),
      [true, false],
    )
  } finally {
    server.close()
  }
})

test('exit_plan_mode refuses, saying why, when no review channel exists, and the session stays in plan mode', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('exit', [
    { toolCall: { name: 'exit_plan_mode', arguments: { plan: '# Ship the menu\n\n1. Registry\n2. Menu' } } },
    { text: 'I will ask you to switch modes' },
  ])
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    await runLine(server, cookie, id, '/plan')
    await turn(server, cookie, id, 'plan the menu')
    assert.equal(server.provider.bodies.length, 2, 'the tool ran and its result went back to the model')
    const toolMessage = (server.provider.bodies[1].messages ?? []).find((message) => message.role === 'tool')
    assert.ok(toolMessage !== undefined, 'the second request carries the tool result')
    assert.match(
      JSON.stringify(toolMessage),
      /no user-questions channel is available to review the plan; ask the user to switch the session mode instead/,
      "DSH's sentence for a missing review channel",
    )
    assert.deepEqual((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/plan`)).body, { session: id, active: true }, 'plan mode stays on')
  } finally {
    server.close()
  }
})

const KEY_CODES = { Enter: 13 }
const FIELD = 'document.querySelector("#prompt textarea")'

async function press(browser, key) {
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: KEY_CODES[key], ...(key === 'Enter' ? { text: '\r' } : {}) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: KEY_CODES[key] })
}

async function typeInto(browser, text) {
  await browser.evaluate(`(() => { const field = ${FIELD}; field.focus(); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await browser.send('Input.insertText', { text })
}

async function chipState(browser) {
  return JSON.parse(
    await browser.evaluate(`JSON.stringify((() => {
      const chips = [...document.querySelectorAll('#prompt-tools .mode-chip')]
      const chip = chips[0]
      return {
        count: chips.length,
        label: chip?.textContent.trim() ?? null,
        title: chip?.title ?? null,
        aria: chip?.getAttribute('aria-label') ?? null,
        afterAccess: chip !== undefined && chip.previousElementSibling?.id === 'access',
        placeholder: ${FIELD}.placeholder,
      }
    })())`),
  )
}

test("the composer shows DSH's Plan chip and placeholder in plan mode, keeps them across a reload, and the chip turns it off", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('chip', [{ text: 'here is how I would plan it' }])
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    const show = async () => {
      await browser.goto(server.url)
      await browser.waitFor('typeof globalThis.showSession === "function"', 20_000)
      await browser.evaluate(`globalThis.showSession(${JSON.stringify(id)})`)
      await browser.waitFor(`${FIELD} !== null`, 10_000)
    }
    await show()
    assert.equal((await chipState(browser)).count, 0, 'no chip in the default mode')

    // Enter on the open menu picks /plan (it takes input, so the line becomes "/plan "); Enter again runs it.
    await typeInto(browser, '/plan')
    await browser.waitFor('document.getElementById("slash-menu") !== null && document.getElementById("slash-menu").hidden === false', 10_000)
    await press(browser, 'Enter')
    await browser.waitFor(`${FIELD}.value === "/plan "`, 5_000)
    await press(browser, 'Enter')
    await browser.waitFor('document.querySelector("#prompt-tools .mode-chip") !== null', 15_000)
    let chip = await chipState(browser)
    assert.deepEqual(
      { count: chip.count, label: chip.label, title: chip.title, aria: chip.aria, afterAccess: chip.afterAccess },
      { count: 1, label: 'Plan', title: 'Plan mode on — click to turn off (/plan off)', aria: 'Plan mode on, press to turn off', afterAccess: true },
    )
    assert.equal(chip.placeholder, 'describe your task to generate plan')
    assert.deepEqual((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/plan`)).body, { session: id, active: true })

    await show()
    await browser.waitFor('document.querySelector("#prompt-tools .mode-chip") !== null', 15_000)
    assert.equal((await chipState(browser)).count, 1, 'a reload shows the chip again, from the session')

    await browser.evaluate('document.querySelector("#prompt-tools .mode-chip").click()')
    await browser.waitFor('document.querySelector("#prompt-tools .mode-chip") === null', 15_000)
    chip = await chipState(browser)
    assert.equal(chip.placeholder, 'Message or run a task, / commands', 'the default placeholder is back')
    assert.deepEqual((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(id)}/plan`)).body, { session: id, active: false })

    // `/plan <words>`: plan mode on, and the words reach the model as a message, with the policy.
    await typeInto(browser, '/plan design the release checklist')
    await press(browser, 'Enter')
    await browser.waitFor('document.getElementById("log").innerText.includes("here is how I would plan it")', 20_000)
    const body = server.provider.bodies.at(-1)
    assert.ok(JSON.stringify(body.messages).includes('design the release checklist'), 'the words went to the model')
    assert.ok(systemText(body).includes(POLICY_OPENING), 'in plan mode')
    assert.equal((await chipState(browser)).count, 1)
  } finally {
    await browser.close()
    server.close()
  }
})

