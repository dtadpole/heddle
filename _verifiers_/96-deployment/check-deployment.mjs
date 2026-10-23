import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import {
  UNIT,
  builtPagePath,
  checkoutState,
  checkoutVerdict,
  expectedPage,
  installedService,
  lastLaunchToken,
  listenerPid,
  processCommand,
} from '../../_tools_/web-daemon/service.mjs'

/**
 * The deployment the owner actually uses — not the tree the checks run in.
 *
 * Every other verifier judges a checkout on an ephemeral port. This one judges the live service: **which
 * checkout its process runs**, whether the page the owner's URL answers with is that checkout's built page, and
 * whether that checkout contains only committed `main`. It exists because a green branch once sat beside a page
 * that served another worktree's build, and the owner saw the old UI twice while every suite passed.
 *
 * The deployment checkout is read from the installed service rather than from this repository, so the check judges
 * the same fact from any working checkout. The service is read through `_tools_/web-daemon/service.mjs`, which
 * reads the launchd agent on macOS and the systemd user unit on Linux the same way `95-web-daemon` does:
 *
 * - the service's command line names the build — the checkout's `dist/cli.js`, or the binary `HEDDLE_BIN` named —
 *   and its checkout;
 * - the live process must be that build (not a lookalike from another worktree);
 * - the page served must be that checkout's page, byte for byte;
 * - the checkout itself must be a **committed** checkout of `main` — a working tree with uncommitted changes is
 *   a workspace, not a deployment (the owner's 2026-10-17 rule: the daemon runs from a folder that only has
 *   committed main). A deployment worktree detached exactly at `origin/main` qualifies, because git checks `main`
 *   out in one worktree only and the base clone holds it.
 *
 * **Where the owner's URL is.** On macOS the service sits on 3082 behind the gate on 8082, and the gate is the
 * owner's URL. On a Linux host nothing fronts the server: it owns the port the owner's SSH forward reaches, and the
 * forward's local end is on the owner's machine, out of this host's sight. There the page is fetched from the
 * service port itself, with a session opened from the launch token the service printed into its own log, so the
 * bytes compared are the bytes the forward carries.
 *
 * A machine with no live service, or no installed service, reports unjudged rather than passing: an unobservable
 * deployment is not a verified one.
 */

const GATE_URL = 'http://127.0.0.1:8082/'

/**
 * This verifier judges **the deployment**, never a scratch service: the overrides `rehearse.sh` sets so that
 * `95-web-daemon` can be judged on a scratch agent are blanked here, because the page behind 8082 is the deployment's
 * whatever the shell this runs in happens to name.
 */
const DEPLOYMENT_ENV = { ...process.env, HEDDLE_WEB_LABEL: '', HEDDLE_WEB_UNIT: '' }

/** The installed service and the process owning its port, or a reason this host cannot be judged. */
function deployment() {
  const service = installedService(DEPLOYMENT_ENV)
  if (service === null) return { reason: 'an installed agent or user unit on this machine' }
  if (service.port === null) return { reason: `a --port in the installed service's command line (${service.path})` }
  const pid = listenerPid(service.port)
  if (pid === null) return { reason: `a live heddle service listening on ${service.port}` }
  const command = processCommand(pid)
  if (command === null) return { reason: `the command line of pid ${pid}` }
  return { service, pid, command }
}

/** The supervisor's control group a Linux process runs in, from `/proc/<pid>/cgroup`, or `null`. */
function cgroupOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  } catch {
    return null
  }
}

test("the live service behind the owner's port runs the deployment checkout's build", async (context) => {
  const live = deployment()
  if (!skipUnless(context, live.service !== undefined, live.reason)) return
  const { service, pid, command } = live
  assert.ok(
    command.includes(service.entry),
    `the process on ${service.port} runs the deployment checkout's build (${service.entry}); it runs: ${command}`,
  )
  if (service.supervisor === 'systemd') {
    /**
     * Running the right file is not yet being the supervised process: a server started by hand from the same
     * checkout would pass the line above and die with the shell that started it. On Linux the supervisor's own
     * record settles it — the port's owner must be inside the unit's control group.
     */
    const cgroup = cgroupOf(pid)
    if (!skipUnless(context, cgroup !== null, `the control group of pid ${pid}`)) return
    assert.ok(cgroup.includes(`/${UNIT}`), `the process on ${service.port} (pid ${pid}) belongs to ${UNIT}, not to a shell; its cgroup: ${cgroup.trim()}`)
  }
})

/** The page the owner's URL answers with: through the gate on macOS, through a fresh session on Linux. */
async function servedPage(service) {
  if (service.supervisor === 'launchd') {
    const response = await fetch(GATE_URL, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
    return { url: GATE_URL, status: response.status, text: await response.text() }
  }
  const token = service.log !== null && existsSync(service.log) ? lastLaunchToken(readFileSync(service.log, 'utf8')) : null
  if (token === null) return { unjudged: `a launch token in the service's log (${service.log ?? 'no log file configured'})` }
  const base = `http://127.0.0.1:${service.port}`
  const handshake = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  if (handshake.status !== 303 || cookie === '') {
    return { url: `${base}/`, status: handshake.status, text: '', handshake: `the newest launch token in ${service.log} did not open a session (${handshake.status})` }
  }
  const response = await fetch(`${base}/`, { headers: { cookie }, signal: AbortSignal.timeout(8000) })
  return { url: `${base}/`, status: response.status, text: await response.text() }
}

test("the page the owner sees is the deployment checkout's built page, byte for byte", async (context) => {
  const live = deployment()
  if (!skipUnless(context, live.service !== undefined, live.reason)) return
  const { service } = live
  const path = builtPagePath(service)
  if (!skipUnless(context, existsSync(path), `the deployment checkout's page at ${path}`)) return
  const built = readFileSync(path, 'utf8')
  /**
   * The build's own document is the file on disk; the served document is that file with **one** documented
   * substitution — the `<meta name="heddle-page">` marker replaced by the first twelve hex of the file's own
   * sha256 (`markedPage` in `src/server/web.ts`). That marker is how a stale build is told apart from a missing
   * feature, so the check states both halves: the expected document carries this build's hash, and the served
   * document is exactly that document. Anything else — a page from another checkout, or an older build that
   * lacks the marker — fails on the hash, not merely on a length.
   */
  const { marker, page: expected } = expectedPage(built)
  assert.ok(expected.includes(`<meta name="heddle-page" content="${marker}">`), 'the build states its own identity')
  const served = await servedPage(service)
  if (!skipUnless(context, served.unjudged === undefined, served.unjudged)) return
  assert.equal(served.handshake, undefined, served.handshake)
  assert.equal(served.status, 200, `the owner's URL (${served.url}) answers with a page (${served.status})`)
  assert.equal(served.text.length, expected.length, `the served page is this build's length (${served.text.length} vs ${expected.length})`)
  assert.equal(served.text, expected, "the served page is the deployment checkout's built page, byte for byte")
})

test('the deployment checkout contains only committed main', async (context) => {
  const service = installedService(DEPLOYMENT_ENV)
  if (!skipUnless(context, service !== null && service.root !== null, 'an installed agent or user unit on this machine')) return
  const verdict = checkoutVerdict(checkoutState(service.root))
  assert.ok(verdict.ok, `the deployment checkout ${service.root} contains only committed main: ${verdict.reason}`)
})
