import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { repoRoot, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 9 — the Web UI daemon.
 *
 * Judged here rather than inside `80-web-ui` because it is a different claim. That part judges the
 * **server**: it starts one on an ephemeral port and on the documented default, and checks what it
 * answers. This part judges the **daemon**: that the harness is arranged to be *running*, at the
 * documented port, without anyone having started it — which needs a definition, a way to install it,
 * and a liveness decision that a process name cannot fake.
 *
 * Two claims, and the second depends on the host:
 *
 * - **The definition is complete** — a launchd agent with a working directory, a bound restart policy,
 *   logs that are not `/dev/null`, the documented port, and an install script whose every step is
 *   idempotent. This is checked from the repository, so it holds on any machine.
 * - **This machine is running it** — read from launchd and from the port. A host with no agent installed
 *   reports **unjudged**, because "the daemon is not installed here" is not "the daemon is broken".
 */

const CAPABILITY = 'a launchd agent that keeps the Web UI running at the documented port'
const LABEL = 'com.dtadpole.heddle-web'
const DAEMON = join(repoRoot, '_tools_', 'web-daemon')

/** The port the installed agent was written for, or `null` when nothing is installed. */
function installedPort() {
  const plist = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${LABEL}.plist`)
  if (!existsSync(plist)) return null
  try {
    const out = execFileSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist], { encoding: 'utf8' })
    const args = JSON.parse(out)
    const at = args.indexOf('--port')
    return { plist, port: Number(args[at + 1]) }
  } catch {
    return null
  }
}

/** Whether launchd reports the agent loaded. */
function agentLoaded() {
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('the daemon definition is committed and complete', async (context) => {
  const template = join(DAEMON, 'heddle-web.plist.template')
  const installer = join(DAEMON, 'install.sh')
  if (!skipUnless(context, existsSync(template) && existsSync(installer), CAPABILITY)) return

  const plist = readFileSync(template, 'utf8')
  /**
   * The properties that decide whether this is a service rather than a command: a restart policy, a
   * working directory (which is what makes the default profile load), a log path, and the loopback host.
   * `KeepAlive` is the supervisor half of the convention, and the throttle is what bounds a crash loop.
   */
  for (const key of ['ProgramArguments', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive', 'StandardOutPath', 'StandardErrorPath']) {
    assert.match(plist, new RegExp(`<key>${key}</key>`), `the agent declares ${key}`)
  }
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, 'it is kept alive rather than run once')
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/, 'and a crash loop is throttled')
  assert.match(plist, /127\.0\.0\.1/, 'it binds loopback, as the server itself requires')
  /**
   * The **values** are checked, not the text: the template's own comment explains why `/dev/null` is
   * wrong, so a check that searched the file for that string failed on the sentence saying not to use it.
   * A check that cannot tell a value from a comment is checking the wrong thing.
   */
  for (const key of ['StandardOutPath', 'StandardErrorPath']) {
    const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]
    assert.ok(value !== undefined && value.length > 0, `${key} names a file`)
    assert.notEqual(value, '/dev/null', `${key} is not /dev/null`)
  }
  assert.match(plist, /@PORT@/, 'the port is a placeholder, so the machine supplies it rather than the repository')

  const script = readFileSync(installer, 'utf8')
  assert.match(script, /set -eu/, 'the installer fails loudly rather than continuing past an error')
  for (const flag of ['--status', '--restart', '--uninstall']) {
    assert.ok(script.includes(flag), `it offers ${flag}`)
  }
  /**
   * Idempotence is the property that makes it safe to run twice, and the script achieves it by unloading
   * before loading. Both halves are asserted because either one alone is a duplicate or a leak.
   */
  assert.match(script, /bootout/, 'installing replaces an existing agent rather than adding a second')
  assert.match(script, /launchctl bootstrap/, 'and it loads through launchd rather than running the process itself')
  assert.match(script, /readlink -f|volta/, 'it resolves the real interpreter rather than handing launchd a shell shim')
})

test('the daemon is loaded, owns the port and answers, or this host has none', async (context) => {
  const installed = installedPort()
  const loaded = agentLoaded()
  if (installed === null || !loaded) {
    context.skip(
      `no ${LABEL} agent is installed on this host${installed === null ? '' : ' (installed but not loaded)'}; run _tools_/web-daemon/install.sh to judge this part`,
    )
    return
  }

  /**
   * **Port ownership is the liveness discriminator**, and the convention is explicit that a process-name
   * search is not: `pgrep -f` matches the searcher's own command line and has been measured concluding a
   * dead service was up. A bound port cannot be satisfied by our own argv and cannot be satisfied twice.
   */
  assert.equal(installed.port, 3082, `the installed agent is written for the documented port (${installed.port})`)

  const health = await fetch(`http://127.0.0.1:${installed.port}/healthz`)
  assert.equal(health.status, 200, 'the port answers')
  const body = await health.json()
  assert.equal(body.service, 'heddle-web', 'and the answer names this service rather than merely something listening')
  assert.equal(body.port, installed.port, 'and reports the port it owns')

  /**
   * The server is the daemon's child, so asking the server is asking the daemon. The page is checked too,
   * because a health endpoint that answers while the UI does not is the shape of a half-started service.
   */
  /**
   * The bare page is refused, and served with a session: the daemon fronts a server that now requires one.
   * This asserted a public page, which was the behaviour before the correction.
   */
  /**
   * The bare page is refused, and the refusal is a document rather than a sentence.
   *
   * The check cannot hand itself a session here — the launch token is minted per process and printed into
   * the daemon's log, which this check does not read — so it asserts the two things the daemon's own
   * configuration decides: the refusal, and that the refusal is the page that offers the form. The
   * authenticated page is judged by `80-web-ui` and `90-web-ui-token`, which start their own server.
   */
  const refused = await fetch(`http://127.0.0.1:${installed.port}/`)
  assert.equal(refused.status, 401, 'the bare page is refused without a session')
  assert.match(refused.headers.get('content-type') ?? '', /text\/html/, 'and the refusal is a document')
  assert.match(await refused.text(), /<form[^>]*action="\/"/, 'carrying the form that opens it')

  // Authentication still applies to data, even though the daemon is trusted: the token protects the API.
  const api = await fetch(`http://127.0.0.1:${installed.port}/api/sessions`)
  assert.equal(api.status, 401, 'the API behind the daemon still requires the token')
})

test('the definition keeps the process alive rather than pretending to', async (context) => {
  const installed = installedPort()
  if (installed === null || !agentLoaded()) {
    context.skip(`no ${LABEL} agent is loaded on this host, so its restart behaviour cannot be judged here`)
    return
  }
  /**
   * The claim is that this is a **daemon**, not a process someone started. Measured: killing the server
   * leaves launchd with a different pid serving the same port within seconds, which is the difference
   * between "it is running" and "it will be running".
   *
   * A bounded wait, because a supervisor that takes minutes to notice is also a finding.
   */
  const before = await fetch(`http://127.0.0.1:${installed.port}/healthz`).then((response) => response.json())
  const pid = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*pid = (\d+)/.exec(line))
    .find((match) => match !== null)?.[1]
  if (!skipUnless(context, typeof pid === 'string', 'launchd did not report a pid, so the restart cannot be judged')) return

  process.kill(Number(pid), 'SIGKILL')
  const deadline = Date.now() + 20_000
  let recovered = false
  while (Date.now() < deadline && !recovered) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    try {
      const health = await fetch(`http://127.0.0.1:${installed.port}/healthz`)
      if (health.ok) recovered = true
    } catch {
      // still down
    }
  }
  assert.ok(recovered, `the service came back within twenty seconds after being killed (was on port ${before.port})`)
})
