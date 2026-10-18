import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The deployment the owner actually uses — not the tree the checks run in.
 *
 * Every other verifier judges a checkout on an ephemeral port. This one judges the live service: **which
 * checkout its process runs**, whether the page the owner's URL answers with is that checkout's built page, and
 * whether that checkout contains only committed `main`. It exists because a green branch once sat beside a page
 * that served another worktree's build, and the owner saw the old UI twice while every suite passed.
 *
 * The deployment checkout is read from the installed agent rather than from this repository, so the check judges
 * the same fact from any working checkout:
 *
 * - the agent's `ProgramArguments` names the checkout its `dist/cli.js` lives in;
 * - the live process must be that file (not a lookalike from another worktree);
 * - the page served at the owner's URL must be that checkout's built page, byte for byte;
 * - the checkout itself must be a **committed** checkout of `main` — a working tree with uncommitted changes is
 *   a workspace, not a deployment (the owner's 2026-10-17 rule: the daemon runs from a folder that only has
 *   committed main).
 *
 * A machine with no live service, or no installed agent, reports unjudged rather than passing: an unobservable
 * deployment is not a verified one.
 */

const SERVICE_PORT = 3082
const OWNER_URL = 'http://127.0.0.1:8082/'
const LABEL = 'com.dtadpole.heddle-web'

/** The installed agent's plist, or null when this machine has no agent. */
function installedAgent() {
  const plist = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${LABEL}.plist`)
  if (!existsSync(plist)) return null
  try {
    const out = execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], { encoding: 'utf8' })
    const args = JSON.parse(out)
    const cli = args.find((argument) => typeof argument === 'string' && argument.endsWith('/dist/cli.js'))
    if (cli === undefined) return null
    return { plist, cli, root: cli.slice(0, -'/dist/cli.js'.length) }
  } catch {
    return null
  }
}

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

/** A git answer from the deployment checkout, or null when the path is not a git checkout. */
function gitAt(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

test("the live service behind the owner's port runs the deployment checkout's cli", async (context) => {
  const agent = installedAgent()
  const live = liveService()
  if (!skipUnless(context, agent !== null && live !== null, 'an installed agent and a live heddle service on this machine')) return
  assert.ok(
    live.command.includes(agent.cli),
    `the service runs the deployment checkout's cli (${agent.cli}); it runs: ${live.command}`,
  )
})

test("the page the owner sees is the deployment checkout's built page, byte for byte", async (context) => {
  const agent = installedAgent()
  const live = liveService()
  if (!skipUnless(context, agent !== null && live !== null, 'an installed agent and a live heddle service on this machine')) return
  const built = readFileSync(join(agent.root, 'dist', 'server', 'page.html'), 'utf8')
  const response = await fetch(OWNER_URL, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
  assert.equal(response.status, 200, `the owner's URL answers with a page (${response.status})`)
  const served = await response.text()
  /**
   * The server reads its page file per request, so byte identity is the sharpest available statement that
   * the served page is this build and not a lookalike from another worktree or an older `dist`.
   */
  assert.equal(served.length, built.length, `the served page is this build's length (${served.length} vs ${built.length})`)
  assert.equal(served, built, "the served page is the deployment checkout's built page, byte for byte")
})

test('the deployment checkout contains only committed main', async (context) => {
  const agent = installedAgent()
  if (!skipUnless(context, agent !== null, 'an installed agent on this machine')) return
  const branch = gitAt(agent.root, 'rev-parse', '--abbrev-ref', 'HEAD')
  assert.equal(branch, 'main', `the deployment checkout is on main (it is on ${branch ?? 'a path that is not a git checkout'})`)
  const dirty = gitAt(agent.root, 'status', '--porcelain')
  assert.equal(dirty, '', `the deployment checkout has no uncommitted changes (it has: ${dirty || 'none'})`)
  const head = gitAt(agent.root, 'rev-parse', 'HEAD')
  const tip = gitAt(agent.root, 'rev-parse', 'main')
  assert.equal(head, tip, 'and its HEAD is main\'s tip, not a detached or older commit')
})
