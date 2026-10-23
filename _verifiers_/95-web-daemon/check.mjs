import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot, skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import { installedService, listenerPid, parseUnit, serviceState, serviceTarget, supervisorFor, unitValue } from '../../_tools_/web-daemon/service.mjs'

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
 * - **The definition is complete** — a launchd agent on macOS and a systemd user unit on Linux, each with a
 *   working directory, a bound restart policy, logs that are not `/dev/null`, the documented port, and an
 *   install script whose every step is idempotent. This is checked from the repository, so both definitions
 *   are judged on any machine.
 * - **This machine is running it** — read from the platform's supervisor and from the port. A host with no
 *   service installed reports **unjudged**, because "the daemon is not installed here" is not "the daemon is
 *   broken".
 *
 * The service is read through `_tools_/web-daemon/service.mjs`, the reader `96-deployment` uses too, so the two
 * verifiers cannot disagree about which service, port or process they are judging.
 */

const CAPABILITY = 'a supervised user service that keeps the Web UI running at the documented port'
const DAEMON = join(repoRoot, '_tools_', 'web-daemon')
const SUPERVISOR = supervisorFor()
/**
 * The service judged: the deployment's, or the scratch service `rehearse.sh` names with `HEDDLE_WEB_LABEL` and
 * `HEDDLE_WEB_PORT` — which is how the stays-up check is judged without killing the owner's server (D-042).
 */
const TARGET = serviceTarget()
const NAME = `${SUPERVISOR === 'launchd' ? `${TARGET.label} agent` : `${TARGET.unit} user unit`}${TARGET.scratch ? ' (scratch)' : ''}`

/** The installed service and its supervisor's state, or a reason this host cannot be judged. */
function liveService() {
  if (SUPERVISOR === null) return { reason: `install.sh has no supervisor for ${process.platform}` }
  const service = installedService()
  if (service === null) return { reason: `no ${NAME} is installed on this host; run _tools_/web-daemon/install.sh to judge this part` }
  const state = serviceState(service)
  if (!state.loaded) return { reason: `the ${NAME} is installed but not running (${service.path})` }
  return { service, state }
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
  assert.match(plist, /@PROGRAM_ARGUMENTS@/, 'the arguments are rendered by the installer, one element per argument')

  const script = readFileSync(installer, 'utf8')
  assert.match(script, /set -eu/, 'the installer fails loudly rather than continuing past an error')
  for (const flag of ['--status', '--restart', '--uninstall']) {
    assert.ok(script.includes(flag), `it offers ${flag}`)
  }
  /**
   * The arguments the template no longer spells out are the installer's: it renders the loopback host, the port
   * the machine supplies and the profile beside the checkout, so the definition is complete only with both files.
   */
  for (const argument of ['--host 127.0.0.1', '--port "$port"', '--config "$repo/cordis.yml"']) {
    assert.ok(script.includes(argument), `the installer renders ${argument}`)
  }
  /**
   * Idempotence is the property that makes it safe to run twice, and the script achieves it by unloading
   * before loading. Both halves are asserted because either one alone is a duplicate or a leak.
   */
  assert.match(script, /bootout/, 'installing replaces an existing agent rather than adding a second')
  assert.match(script, /launchctl bootstrap/, 'and it loads through launchd rather than running the process itself')
  assert.match(script, /launchctl kickstart/, 'and starts it on demand, because this Mac was measured not to spawn a bootstrapped job by itself')
  assert.match(script, /readlink -f|volta/, 'it resolves the real interpreter rather than handing launchd a shell shim')
})

test('the Linux unit definition is committed and complete', async (context) => {
  const template = join(DAEMON, 'heddle-web.service.template')
  const installer = join(DAEMON, 'install.sh')
  if (!skipUnless(context, existsSync(template) && existsSync(installer), 'a systemd user unit for Linux hosts')) return

  /**
   * The same properties as the agent's, in systemd's words, read as **values** through a unit parser so a
   * comment cannot satisfy them. `Restart=always` is `KeepAlive`; a fixed `RestartSec` with no start limit is
   * `ThrottleInterval` — systemd's default limit would stop restarting after a burst and leave the service dead,
   * which launchd never does.
   */
  const unit = parseUnit(readFileSync(template, 'utf8'))
  const exec = unitValue(unit, 'Service', 'ExecStart') ?? ''
  assert.match(exec, /^@PROGRAM@ web /, 'it runs the harness\'s own launcher, whichever build supplies it')
  assert.match(exec, /--host 127\.0\.0\.1(\s|$)/, 'it binds loopback, as the server itself requires')
  assert.match(exec, /--port @PORT@(\s|$)/, 'the port is a placeholder, so the machine supplies it')
  assert.match(exec, /--config @REPO@\/cordis\.yml(\s|$)/, 'and the profile beside the checkout is named explicitly')
  assert.equal(unitValue(unit, 'Service', 'WorkingDirectory'), '@REPO@', 'the checkout is the working directory')
  assert.equal(unitValue(unit, 'Service', 'Restart'), 'always', 'it is restarted on every exit, a kill included')
  assert.match(unitValue(unit, 'Service', 'RestartSec') ?? '', /^\d+$/, 'at a bounded rate')
  assert.equal(unitValue(unit, 'Unit', 'StartLimitIntervalSec'), '0', 'and the supervisor never gives up on it')
  for (const key of ['StandardOutput', 'StandardError']) {
    const value = unitValue(unit, 'Service', key) ?? ''
    assert.match(value, /^append:\S+/, `${key} appends to a file rather than discarding or truncating`)
    assert.ok(!value.includes('/dev/null'), `${key} is not /dev/null`)
  }
  assert.ok((unit.Service?.Environment ?? []).some((value) => value.startsWith('HEDDLE_HOME=')), 'the store and secret location is explicit')
  assert.equal(unitValue(unit, 'Install', 'WantedBy'), 'default.target', 'an enabled unit starts with the user manager, at boot when the account lingers')

  const script = readFileSync(installer, 'utf8')
  assert.match(script, /systemctl --user daemon-reload/, 'the installer makes systemd read the new definition')
  assert.match(script, /systemctl --user enable/, 'enables it, so it starts without anyone starting it')
  assert.match(script, /systemctl --user restart/, 'and restarts it, so a running service picks up the new definition')
  assert.match(script, /systemctl --user disable --now/, 'uninstalling stops it as well as removing it')
  assert.match(script, /Linger/, 'and it checks lingering, without which a user unit dies at logout')
})

test('the daemon is loaded, owns the port and answers, or this host has none', async (context) => {
  const live = liveService()
  if (live.service === undefined) {
    context.skip(live.reason)
    return
  }
  const { service } = live

  /**
   * **Port ownership is the liveness discriminator**, and the convention is explicit that a process-name
   * search is not: `pgrep -f` matches the searcher's own command line and has been measured concluding a
   * dead service was up. A bound port cannot be satisfied by our own argv and cannot be satisfied twice.
   */
  const documented = TARGET.documentedPort
  assert.equal(service.port, documented, `the installed ${NAME} is written for the documented port ${documented} (${service.port})`)
  assert.equal(service.host, '127.0.0.1', 'and binds loopback')

  const health = await fetch(`http://127.0.0.1:${service.port}/healthz`, { signal: AbortSignal.timeout(5000) })
  assert.equal(health.status, 200, 'the port answers')
  const body = await health.json()
  assert.equal(body.service, 'heddle-web', 'and the answer names this service rather than merely something listening')
  assert.equal(body.port, service.port, 'and reports the port it owns')

  /**
   * The bare page is refused, and the refusal is a document rather than a sentence.
   *
   * The check does not hand itself a session — the launch token is minted per process and printed into the
   * daemon's log — so it asserts the two things the daemon's own configuration decides: the refusal, and that
   * the refusal is the page that offers the form. The authenticated page is judged by `80-web-ui` and
   * `90-web-ui-token`, which start their own server, and by `96-deployment` against this one.
   */
  const refused = await fetch(`http://127.0.0.1:${service.port}/`, { signal: AbortSignal.timeout(5000) })
  assert.equal(refused.status, 401, 'the bare page is refused without a session')
  assert.match(refused.headers.get('content-type') ?? '', /text\/html/, 'and the refusal is a document')
  assert.match(await refused.text(), /<form[^>]*action="\/"/, 'carrying the form that opens it')

  // Authentication still applies to data, even though the daemon is trusted: the token protects the API.
  const api = await fetch(`http://127.0.0.1:${service.port}/api/sessions`, { signal: AbortSignal.timeout(5000) })
  assert.equal(api.status, 401, 'the API behind the daemon still requires the token')
})

test('the definition keeps the process alive rather than pretending to', async (context) => {
  const live = liveService()
  if (live.service === undefined) {
    context.skip(`${live.reason}, so its restart behaviour cannot be judged here`)
    return
  }
  const { service } = live
  /**
   * The claim is that this is a **daemon**, not a process someone started. Measured: killing the process that
   * owns the port leaves a **different** pid serving it within seconds — systemd on Linux (3 s, 2026-10-22), and
   * on macOS the supervisor `install.sh` puts in front of the server (measured the same day, because launchd on
   * this Mac does not restart a job at all). Which process the platform or the supervisor holds is their
   * business; the process that serves is the one this check kills, which is the one an outage is.
   *
   * A bounded wait, because a supervisor that takes minutes to notice is also a finding.
   */
  const before = listenerPid(service.port)
  if (!skipUnless(context, before !== null, `no process is listening on port ${service.port}, so the restart cannot be judged`)) return

  process.kill(before, 'SIGKILL')
  const deadline = Date.now() + 20_000
  let recovered = null
  while (Date.now() < deadline && recovered === null) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    try {
      const health = await fetch(`http://127.0.0.1:${service.port}/healthz`, { signal: AbortSignal.timeout(1000) })
      if (health.ok) recovered = listenerPid(service.port)
    } catch {
      // still down
    }
  }
  assert.ok(recovered !== null, `the server came back within twenty seconds after being killed (port ${service.port})`)
  assert.notEqual(recovered, before, `and it is a new process (${before} -> ${recovered}), not the killed one answering late`)
})
