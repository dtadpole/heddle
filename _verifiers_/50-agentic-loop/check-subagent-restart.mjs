import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  endChild,
  fixtureDir,
  heddleCommand,
  httpConfig,
  isTitleRequest,
  isolatedHome,
  readTranscript,
  refuseTitleRequest,
  removeDir,
  repoRoot,
  sessionsUnder,
  skipUnless,
  transcriptFile,
} from '../../_tools_/verify-runner/lib.mjs'

/**
 * A background child cut by a server restart still reports to its parent (issue #170).
 *
 * A parent's turn delegates; the child's turn is waiting on its model when the server is killed (SIGKILL, the way a
 * crash or a deploy cuts it). Before the fix the child's log was closed at the next start but the parent heard
 * nothing, so its model believed the child was still working. The claims:
 *
 * - at the next start the parent gets one settlement notice from that child, `Background subagent <id> was
 *   interrupted before it finished.`, and answers it in a turn, as it answers a finished child's notice;
 * - the child's own log now ends with the closers **written** (read from the file, so the read-time closers a view
 *   adds do not count): the turn's `ended` reason and `turn/completed` with `reason.kind: 'interrupted'`;
 * - the server says so at start (`reported 1 interrupted subagent(s) to their parent(s)`);
 * - a further restart reports nothing again: the notice is delivered once.
 *
 * DSH does not replay a settlement notice after a restart (its activation registry is process-local,
 * `_context_/dsh-mechanisms/dsh-jobs.md` section 6.3); heddle goes past it here on the "nothing silent" rule.
 *
 * Driven through `heddle web` with a local OpenAI-shaped double rather than the scripted endpoint, because the child's
 * model call has to **stay open** until the kill, and a script answers at once.
 */

const CAPABILITY = 'a turn with tools, served by the Web UI'

const PARENT_PROMPT = 'parent prompt: delegate the slow task'
const CHILD_PROMPT = 'slow child task'
const NOTICE_ANSWER = 'parent read the interrupted notice'
const BOOT_LINE = /reported 1 interrupted subagent\(s\) to their parent\(s\)/

/** The text of an OpenAI message's content, a string or a list of parts. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
  return ''
}

/**
 * The model double. It reads each request's messages and answers as the journey needs: the parent's first round
 * delegates, its second ends the turn, a turn that carries a settlement notice is answered, and the child's request is
 * **held open** and never answered, so the child is mid-turn when the server is killed.
 */
async function modelDouble() {
  const seen = { child: 0, notice: 0 }
  const held = new Set()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      let messages = []
      try {
        messages = JSON.parse(body).messages ?? []
      } catch {
        messages = []
      }
      const users = messages.filter((message) => message.role === 'user').map((message) => contentText(message.content))
      const answer = (delta, finish) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
      }
      if (users.some((text) => text.includes('Background subagent'))) {
        seen.notice += 1
        return answer({ role: 'assistant', content: NOTICE_ANSWER }, 'stop')
      }
      if (users[0]?.includes(CHILD_PROMPT)) {
        // The child's model call: held until the server that made it is killed.
        seen.child += 1
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': the double holds this call open\n\n')
        held.add(response)
        response.on('close', () => held.delete(response))
        return
      }
      if (messages.at(-1)?.role === 'tool') return answer({ role: 'assistant', content: 'parent started the child' }, 'stop')
      return answer(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-delegate', type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ prompt: CHILD_PROMPT }) } }],
        },
        'tool_calls',
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}/ds`,
    seen,
    close: () =>
      new Promise((resolve) => {
        for (const response of held) response.destroy()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  return {
    url,
    logs: () => output,
    /** A crash, not a shutdown: nothing of the server's own stop path runs. */
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await endChild(child)
    },
  }
}

async function cookieFor(url) {
  const response = await fetch(url, { redirect: 'manual' })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: { raw: text } }
  }
}

async function waitFor(read, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A log read while a server may be writing it: an unreadable moment is "not yet", never a verdict. */
function eventsOf(root, id) {
  try {
    return readTranscript(join(root, id))
  } catch {
    return undefined
  }
}

function metaOf(root, id) {
  try {
    return JSON.parse(readFileSync(join(dirname(transcriptFile(join(root, id))), `${id}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

const noticesIn = (events) => events.filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'subagent-settled')
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('\n')

test('a background child cut by a server restart is reported to its parent once, as interrupted, and the parent answers', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test(execFileSync(...heddleCommand(['--help']), { encoding: 'utf8' })), CAPABILITY)) return
  const home = isolatedHome('subagent-restart')
  const work = fixtureDir('subagent-restart-work')
  const root = join(home, 'sessions')
  const double = await modelDouble()
  const config = httpConfig({ home, baseUrl: double.baseUrl })
  let server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    await api(url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const opened = await api(url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: work }) })
    const parentId = opened.body.session?.id ?? opened.body.id
    assert.ok(typeof parentId === 'string', `a session was opened\n${JSON.stringify(opened.body)}`)
    const turn = await fetch(new URL('/api/turn', url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: PARENT_PROMPT, folder: work, session: parentId }),
    })
    assert.equal(turn.status, 200, 'the parent turn ran')
    await turn.text()

    const childId = await waitFor(() => sessionsUnder(root).find((id) => id !== parentId && metaOf(root, id)?.parentSession === parentId), 15_000, 'the child session')
    await waitFor(() => (double.seen.child > 0 && eventsOf(root, childId)?.some((event) => event.type === 'model/request') ? true : undefined), 15_000, "the child's model call, held open")
    const parentBefore = eventsOf(root, parentId) ?? []
    assert.ok(parentBefore.some((event) => event.type === 'turn/completed'), 'the parent ended its own turn without waiting for the child')
    assert.equal(noticesIn(parentBefore).length, 0, 'and has no notice yet: the child is still working')

    // The crash: the child's turn is open in its log, and nothing of the server's stop path runs.
    await server.kill()
    const childCut = eventsOf(root, childId) ?? []
    assert.ok(!childCut.some((event) => event.type === 'turn/completed'), 'the kill left the child mid-turn')

    server = startServer(home, work, config)
    await server.url
    const parentAfter = await waitFor(() => {
      const events = eventsOf(root, parentId)
      if (events === undefined) return undefined
      const notice = noticesIn(events).at(-1)
      if (notice === undefined) return undefined
      const index = events.indexOf(notice)
      return events.slice(index + 1).some((event) => JSON.stringify(event).includes(NOTICE_ANSWER)) ? events : undefined
    }, 20_000, "the parent's notice that its child was interrupted, and the parent's answer to it")

    const notices = noticesIn(parentAfter)
    assert.equal(notices.length, 1, 'the parent received one settlement notice')
    assert.equal(notices[0].message.source.senderSessionId, childId, 'from its child')
    assert.equal(textOf(notices[0]).split('\n')[0], `Background subagent ${childId} was interrupted before it finished.`, 'saying the child was interrupted')
    assert.equal(notices[0].message.source.summary, `Background subagent ${childId} was interrupted before it finished.`, 'and the source carries the same summary')
    assert.match(textOf(notices[0]), /It left no closing message\./, 'the child had said nothing, and the notice says so')
    assert.ok(parentAfter.slice(parentAfter.indexOf(notices[0]) + 1).some((event) => event.type === 'model/request'), 'the parent answered the notice in a turn')
    assert.equal(double.seen.notice, 1, 'the model was asked about the notice once')
    assert.match(server.logs(), BOOT_LINE, 'the server said at start what it reported')

    const childClosed = eventsOf(root, childId) ?? []
    const childEnd = childClosed.filter((event) => event.type === 'turn/completed').at(-1)
    assert.equal(childEnd?.reason?.kind, 'interrupted', "the child's log ends with its turn closed as interrupted, written to the file")
    const answer = childClosed.filter((event) => event.type === 'assistant/completed').at(-1)
    assert.match(String(answer?.ended?.[0] ?? ''), /process exited before this turn finished/, "with the closer's reason")

    // Once: the next start finds the child closed and reports nothing.
    await server.close()
    server = startServer(home, work, config)
    await server.url
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.doesNotMatch(server.logs(), /interrupted subagent/, 'a further start reports nothing')
    assert.equal(noticesIn(eventsOf(root, parentId) ?? []).length, 1, 'and the parent still has the one notice')
    assert.equal(double.seen.notice, 1, 'and no second notice turn ran')
  } finally {
    await server.close()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})
