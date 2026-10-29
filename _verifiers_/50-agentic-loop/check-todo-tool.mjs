import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The todo tool, judged as DSH's `dsh-tool-todo` (0.2.1-rc.2) behaves under the shipped profile.
 *
 * Four claims, each through the build under test (the TypeScript dist, or the binary `HEDDLE_BIN` names) and
 * read back from the session log, never from the tool's own module:
 *
 * 1. **Two todos in progress are accepted.** `allowParallelInProgress` is a required setting with no default,
 *    and the shipped profile sets it true, as every DSH preset ships (R-developer-nine-9).
 * 2. **A bad list is refused with DSH's sentences**: an empty content (trimmed first) and a duplicate content.
 *    The code in front of the message is this project's own rendering, `error (<CODE>): <message>`
 *    (R-developer-nine-8).
 * 3. **There is no `todo_read`** (R-developer-nine-10): it is not among the tools a model request offers, and
 *    a call to it answers the registry's unknown-tool error.
 * 4. **A write answers DSH's result sentence**, `Updated todo list: <p> pending, <i> in progress, <c>
 *    completed.`, and the page's route still reads the durable list from the service.
 *
 * It is gated on the Web command alone, never on the todo capability, so a build without the tool fails here
 * rather than skipping. Every model step comes from the offline scripted endpoint, rewritten before each turn.
 */
const CAPABILITY = 'the Web UI'

const EMPTY_CONTENT = 'invalid todo: `content` must be a non-empty string'

async function startServer(label) {
  const home = isolatedHome(`todo-tool-${label}`)
  const work = fixtureDir(`todo-tool-${label}-work`)
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  const script = join(home, 'script.json')
  scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) resolvePromise(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
    setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return {
    home,
    work,
    url,
    script,
    cookie,
    output: () => output,
    close: () => {
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function openSession(server, folder) {
  mkdirSync(folder, { recursive: true })
  await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
  const opened = await api(server, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder }) })
  return opened.body.session?.id ?? opened.body.id
}

/** A person's turn: the script is written first, then the prompt is posted and the turn read to its end. */
async function turn(server, session, folder, list) {
  writeFileSync(server.script, JSON.stringify({ steps: list }))
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'plan the work', folder, session }),
  })
  assert.equal(response.status, 200, `the turn ran (${response.status})`)
  await response.text()
}

const events = (server, session) => readTranscript(join(server.home, 'sessions', session))
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')
const toolTexts = (server, session, since) =>
  events(server, session)
    .slice(since)
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map(textOf)
const requests = (server, session, since) =>
  events(server, session)
    .slice(since)
    .filter((event) => event.type === 'model/request')

const write = (todos) => ({ toolCall: { name: 'todo_write', arguments: { todos } } })

/** A refusal in this project's rendering, with DSH's sentence as the message. */
const refusal = (message) => new RegExp(`^error \\([A-Z_]+\\): ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

test('two todos in progress are accepted under the shipped profile, where allowParallelInProgress is true', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('parallel')
  try {
    const folder = join(server.work, 'parallel')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [
      write([
        { content: 'build the parser', status: 'in_progress' },
        { content: 'build the printer', status: 'in_progress' },
        { content: 'write the tests', status: 'pending' },
      ]),
      { text: 'two at once' },
    ])
    const [answer] = toolTexts(server, session, mark)
    assert.equal(answer, 'Updated todo list: 1 pending, 2 in progress, 0 completed.', `the parallel list is accepted\nsaw: ${JSON.stringify(answer)}`)
    const list = await api(server, `/api/todo?session=${encodeURIComponent(session)}`)
    assert.equal(list.body.todo?.counts?.inProgress, 2, `the durable list keeps both in progress\nsaw: ${JSON.stringify(list.body)}`)
  } finally {
    server.close()
  }
})

test('an empty content and a duplicate content are refused with DSH sentences', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('refusals')
  try {
    const folder = join(server.work, 'refusals')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [
      write([{ content: '   ', status: 'pending' }]),
      write([
        { content: 'ship it', status: 'pending' },
        { content: '  ship it ', status: 'completed' },
      ]),
      { text: 'refused twice' },
    ])
    const [empty, duplicate] = toolTexts(server, session, mark)
    assert.match(String(empty), refusal(EMPTY_CONTENT), `an empty content, trimmed first, is DSH refusal\nsaw: ${JSON.stringify(empty)}`)
    assert.match(String(duplicate), refusal('invalid todos: duplicate content "ship it"'), `a duplicate, found after trimming, is DSH refusal\nsaw: ${JSON.stringify(duplicate)}`)
    const list = await api(server, `/api/todo?session=${encodeURIComponent(session)}`)
    assert.equal(list.body.todo, null, `a refused write appends nothing\nsaw: ${JSON.stringify(list.body)}`)
  } finally {
    server.close()
  }
})

test('todo_read is not offered, and a call to it answers an unknown-tool error', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('no-read')
  try {
    const folder = join(server.work, 'no-read')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'todo_read', arguments: {} } }, { text: 'no reader' }])
    const offered = requests(server, session, mark)
    assert.ok(offered.length >= 1, 'the turn made a model request')
    for (const request of offered) {
      assert.ok(Array.isArray(request.tools) && request.tools.includes('todo_write'), `todo_write is offered\nsaw: ${JSON.stringify(request.tools)}`)
      assert.ok(!request.tools.includes('todo_read'), `todo_read is not offered\nsaw: ${JSON.stringify(request.tools)}`)
    }
    const [answer] = toolTexts(server, session, mark)
    assert.match(String(answer), /^error \(UNKNOWN_TOOL\): no tool named 'todo_read'/, `a todo_read call is an unknown tool\nsaw: ${JSON.stringify(answer)}`)
  } finally {
    server.close()
  }
})

test('a write answers DSH result sentence, and the page route reads the list', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('result')
  try {
    const folder = join(server.work, 'result')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    const todos = [
      { content: 'read the reference', status: 'completed' },
      { content: 'port the tool', status: 'in_progress' },
      { content: 'run the checks', status: 'pending' },
    ]
    await turn(server, session, folder, [write(todos), { text: 'planned' }])
    const [answer] = toolTexts(server, session, mark)
    assert.equal(answer, 'Updated todo list: 1 pending, 1 in progress, 1 completed.')
    const written = events(server, session).filter((event) => event.type === 'todo/write')
    assert.deepEqual(written.at(-1)?.todos, todos, 'the log holds the whole list, as written')
    const list = await api(server, `/api/todo?session=${encodeURIComponent(session)}`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.todo?.todos, todos, 'GET /api/todo reads the service, not a tool')
  } finally {
    server.close()
  }
})
