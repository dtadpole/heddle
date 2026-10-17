import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import { fixtureDir, removeDir, skipUnless } from '../../../verify-runner/lib.mjs'
import { browserAvailable } from '../../lib.mjs'

/**
 * The browser tool as a command-line tool: one session, many commands.
 *
 * The claims are about the part a page-level check cannot see. A command that attaches, acts and
 * detaches would work for one action and lose everything between actions: the console messages, the
 * network requests, the open tabs. So this verifier judges the **session**: that the first command
 * starts a browser, that later commands find the same one, that `status` tells the truth about it, and
 * that `stop` really ends it.
 *
 * **Surface:** headless. The session check drives the command line exactly as an unattended run would,
 * so it never opens a window and never depends on a seat. The window itself is judged by the surface
 * verifier's headed run.
 */

/** This verifier's folder. */
const here = fileURLToPath(new URL('.', import.meta.url))
const cli = join(here, '../../cli.mjs')
const root = fileURLToPath(new URL('../../../../', import.meta.url))

/** The page the session check drives: one button that logs and fetches. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Session</title></head>
<body>
  <h1>Session fixture</h1>
  <button id="log">Log</button>
  <p id="output">idle</p>
  <script>
    document.getElementById('log').addEventListener('click', () => {
      document.getElementById('output').textContent = 'clicked'
      console.log('session click')
      fetch('/api/echo').catch(() => {})
    })
  </script>
</body></html>`

/** Serve the fixture on an ephemeral loopback port. */
async function startFixture() {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/echo') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ echoed: true }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolvePromise) => server.close(resolvePromise)) }
}

/** Run the command line and return what it printed. */
function runCli(args, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the command line did not finish: ${args.join(' ')}\n${stderr}`))
    }, 180_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Run one tool and parse the JSON it printed. */
async function callTool(tool, args = {}, environment = {}, extraArgs = []) {
  const argsFile = join(environment.HEDDLE_BROWSER_HOME, `args-${tool}.json`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(argsFile, JSON.stringify(args))
  const result = await runCli([tool, `--file=${argsFile}`, '--json', ...extraArgs], environment)
  assert.equal(result.code, 0, `${tool} exited ${result.code}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

let work
let environment
let fixture
let fixtureUrl

before(async () => {
  if (!browserAvailable()) return
  work = fixtureDir('browser-session')
  environment = { HEDDLE_BROWSER_HOME: work, HEDDLE_BROWSER_HEADLESS: '1' }
  fixture = await startFixture()
  fixtureUrl = fixture.url
})

after(async () => {
  try {
    if (environment !== undefined) await runCli(['stop'], environment)
  } catch {
    // A session that is already gone is the state this wants anyway.
  }
  if (fixture !== undefined) await fixture.close()
  if (work !== undefined) {
    /**
     * Chrome writes its profile while it exits, so one `rm` loses the race (ENOTEMPTY). The retry is
     * the same one the tool makes when it removes a profile: a directory it cannot delete is a run
     * that leaves state behind for the next one.
     */
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        removeDir(work)
        break
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
  }
})

test('start opens a browser and status reports it', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const started = await runCli(['start', '--headless'], environment)
  assert.equal(started.code, 0, started.stderr)
  const state = JSON.parse(started.stdout)
  assert.equal(state.running, true)
  assert.ok(Number.isFinite(state.pid), 'a process id is reported')
  assert.ok(existsSync(join(work, 'session.json')), 'the session is recorded')
  const status = await runCli(['status'], environment)
  const reported = JSON.parse(status.stdout)
  assert.equal(reported.running, true, 'status agrees that a browser is running')
})

test('a later command finds the same session, and its state is shared', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const opened = await callTool('new_page', { url: fixtureUrl }, environment)
  assert.equal(opened.title, 'Session')
  const listed = await callTool('list_pages', {}, environment)
  assert.ok(listed.pages.some((page) => page.pageId === opened.pageId), 'a separate command sees the page the first one opened')
  assert.equal(listed.pages.find((page) => page.pageId === opened.pageId)?.title, 'Session')
})

test('the console and the network are recorded across commands', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const snapshot = await callTool('take_snapshot', {}, environment)
  assert.match(snapshot.snapshot, /RootWebArea "Session"/)
  const button = findUid(snapshot.tree, 'button', 'Log')
  assert.ok(button !== undefined, 'the button has a uid')
  const clicked = await callTool('click', { uid: button }, environment)
  assert.equal(clicked.clicked, button)
  const consoleMessages = await callTool('list_console_messages', {}, environment)
  assert.match(consoleMessages.text, /session click/, 'the message the click logged survived the command boundary')
  const network = await callTool('list_network_requests', {}, environment)
  assert.ok(network.requests.some((request) => request.url.includes('/api/echo')), 'the request the click made is listed')
})

test('a screenshot is saved and named', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const shot = await callTool('take_screenshot', { fullPage: true }, environment)
  assert.ok(existsSync(shot.path), `the screenshot exists (${shot.path})`)
  assert.ok(shot.bytes > 1_000)
})

test('each named session has its own browser and its own tabs', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const alpha = { ...environment, HEDDLE_BROWSER_SESSION: 'alpha' }
  const beta = { ...environment, HEDDLE_BROWSER_SESSION: 'beta' }
  try {
    const opened = await callTool('new_page', { url: fixtureUrl }, alpha)
    assert.equal(opened.title, 'Session')
    const alphaPages = await callTool('list_pages', {}, alpha)
    const betaPages = await callTool('list_pages', {}, beta)
    assert.ok(alphaPages.pages.length >= 2, 'the alpha session has its blank page and the one it opened')
    assert.equal(betaPages.pages.length, 1, 'the beta session has only its own blank page')
    assert.ok(
      !betaPages.pages.some((page) => page.title === 'Session'),
      'beta does not see the page alpha opened',
    )
    const alphaStatus = JSON.parse((await runCli(['status'], alpha)).stdout)
    const betaStatus = JSON.parse((await runCli(['status'], beta)).stdout)
    assert.equal(alphaStatus.running, true)
    assert.equal(betaStatus.running, true)
    assert.notEqual(alphaStatus.pid, betaStatus.pid, 'two sessions means two browsers, not one shared one')
  } finally {
    await runCli(['stop'], alpha)
    await runCli(['stop'], beta)
  }
})

test('stop ends the session and clears its record', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const stopped = await runCli(['stop'], environment)
  assert.equal(stopped.code, 0, stopped.stderr)
  const status = await runCli(['status'], environment)
  assert.equal(JSON.parse(status.stdout).running, false, 'status says no browser is running')
  assert.ok(!existsSync(join(work, 'session.json')), 'the record is gone')
})

test('a tool call starts a session when none is running', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const started = await callTool('list_pages', {}, environment)
  assert.ok(Array.isArray(started.pages) && started.pages.length >= 1, 'a browser was started on demand')
  await runCli(['stop'], environment)
})

test('the command line lists its tools and refuses an unknown one', async (t) => {
  if (!skipUnless(t, browserAvailable(), 'no browser binary was found')) return
  const tools = await runCli(['tools'], environment)
  assert.equal(tools.code, 0)
  for (const name of ['take_snapshot', 'click', 'fill', 'list_console_messages', 'list_network_requests', 'take_screenshot']) {
    assert.match(tools.stdout, new RegExp(`\\b${name}\\b`), `the help lists ${name}`)
  }
  const unknown = await runCli(['no-such-tool'], environment)
  assert.equal(unknown.code, 2)
})

/** Find a node's uid in a snapshot tree. */
function findUid(tree, role, name) {
  if (tree.role === role && tree.name === name) return tree.uid
  for (const child of tree.children ?? []) {
    const found = findUid(child, role, name)
    if (found !== undefined) return found
  }
  return undefined
}
