import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { endChild, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A fork keeps what was set after the last turn (issue #232).
 *
 * DSH's omitted-`atSeq` cut is "the latest completed-turn prefix, including standalone events before the next turn
 * begins" (dsh-api-session-controller `latestCompletedPrefixBoundary`). heddle cut at the last `turn/completed` itself, so
 * a session switched to read-only after its last turn forked into a workspace-write branch, on both builds.
 *
 * One turn, then `/permission read-only`, then Fork session with no body: the branch's `/permission` must read
 * read-only, and its log must hold the `permission/mode` event.
 */

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
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
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      // Bounded: SIGTERM, then SIGKILL after 5 s, so a harness slow to exit fails the check by name, not by the lane's limit.
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
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text }
}

async function events(url, cookie, session) {
  const { text } = await api(url, cookie, `/api/sessions/${session}/log`)
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

test('#232: a fork made after /permission read-only is read-only too', { timeout: 90_000 }, async () => {
  const home = isolatedHome('fork-standalone')
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    const first = await api(url, cookie, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'start', folder: work, new: true }) })
    assert.equal(first.status, 200, first.text)
    const session = /session-[0-9a-f-]{36}/.exec(first.text)?.[0]
    assert.ok(session, 'the turn named its session')
    const command = async (id, line) => (await api(url, cookie, `/api/sessions/${id}/commands`, { method: 'POST', body: JSON.stringify({ line }) })).body
    const before = await command(session, '/permission')
    assert.match(String(before.text), /current preset (workspace-write|danger-full-access)/, `the session starts wider than read-only\nsaw: ${JSON.stringify(before)}`)
    const narrowed = await command(session, '/permission read-only')
    assert.equal(narrowed.kind, 'success', JSON.stringify(narrowed))
    assert.match(String((await command(session, '/permission')).text), /current preset read-only/)

    const forked = await api(url, cookie, `/api/sessions/${session}/fork`, { method: 'POST', body: '{}' })
    assert.equal(forked.status, 200, forked.text)
    const branch = forked.body.session
    assert.match(String(branch), /^session-[0-9a-f-]{36}$/, `the fork named its branch\n${forked.text}`)
    const log = await events(url, cookie, branch)
    assert.ok(log.some((event) => event.type === 'permission/mode' && event.mode === 'read-only'), `the branch's log carries the mode switch\n${log.map((event) => event.type).join(' ')}`)
    const inBranch = await command(branch, '/permission')
    assert.match(String(inBranch.text), /current preset read-only/, `the branch is read-only, as its source was when it was forked\nsaw: ${JSON.stringify(inBranch)}`)
  } catch (error) {
    error.message += `\n--- server output (tail) ---\n${server.logs().slice(-1500)}`
    throw error
  } finally {
    await server.close()
    removeDir(home)
  }
})
