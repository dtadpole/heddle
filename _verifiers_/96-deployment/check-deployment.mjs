import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The deployment the owner actually uses — not the tree the checks run in.
 *
 * Every other verifier judges a checkout on an ephemeral port. This one judges the live service: which
 * checkout its process runs, and whether the page the owner's URL answers with is this checkout's built page.
 * It exists because a green branch once sat beside a page that served another worktree's build, and the owner
 * saw the old UI twice while every suite passed.
 *
 * A machine with no live service reports unjudged rather than passing: an unobservable deployment is not a
 * verified one.
 */

const SERVICE_PORT = 3082
const OWNER_URL = 'http://127.0.0.1:8082/'

/** The process the owner's page ultimately talks to, or null when no live service exists here. */
function liveService() {
  try {
    const listening = execFileSync('lsof', ['-nP', `-iTCP:${SERVICE_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    const pid = (listening.split('\n')[1] ?? '').trim().split(/\s+/)[1]
    if (pid === undefined || pid === '') return null
    const command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim()
    return { pid, command }
  } catch {
    return null
  }
}

test('the live service behind the owner\'s port runs the main checkout\'s build', async (context) => {
  const live = liveService()
  if (!skipUnless(context, live !== null, 'a live heddle service on this machine')) return
  const expected = join(repoRoot, 'dist', 'cli.js')
  assert.ok(
    live.command.includes(expected),
    `the service runs this checkout's cli (${expected}); it runs: ${live.command}`,
  )
})

test('the page the owner sees is this checkout\'s built page, byte for byte', async (context) => {
  const live = liveService()
  if (!skipUnless(context, live !== null, 'a live heddle service on this machine')) return
  const built = readFileSync(join(repoRoot, 'dist', 'server', 'page.html'), 'utf8')
  const response = await fetch(OWNER_URL, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
  assert.equal(response.status, 200, `the owner's URL answers with a page (${response.status})`)
  const served = await response.text()
  /**
   * The server reads its page file per request, so byte identity is the sharpest available statement that
   * this is the main checkout's build and not a lookalike from another worktree or an older `dist`.
   */
  assert.equal(served.length, built.length, `the served page is this build's length (${served.length} vs ${built.length})`)
  assert.equal(served, built, 'the served page is this checkout\'s built page, byte for byte')
})
