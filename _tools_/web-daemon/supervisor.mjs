#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * The supervisor half of the Web UI service: it runs the server and puts it back when it exits.
 *
 * **Why it exists.** The convention's supervisor is launchd's `KeepAlive` (macOS) or systemd's `Restart=always`
 * (Linux): the platform restarts the job when the process exits. That is still the outer layer and this file does
 * not replace it — it adds the inner one. On the Mac this repository is developed on (macOS 27.0, 26A428,
 * 2026-10-22) launchd loads an agent but does not spawn it again: a plain `sleep` started with `RunAtLoad` +
 * `KeepAlive` and killed with SIGKILL is still `state = not running` ten seconds later, and a `StartInterval`
 * job never fires at all. The measurement is in `INDEX.md`; the consequence is that on this host "the server
 * comes back after a kill" is not something the platform delivers, so the service must.
 *
 * **What it is not.** Not a replacement for the agent: the agent still owns the log, the working directory and
 * the environment, and it is still what starts this at login. Not a daemon manager either: it runs exactly one
 * child, because the server is one process.
 *
 * Usage, as `install.sh` renders it into the agent:
 *
 *   node supervisor.mjs --health-url http://127.0.0.1:3082/healthz --reclaim-port 3082 -- <program> [arguments…]
 *
 * **Two failures an exit does not show** (measured on a scratch agent, 2026-10-22): a server that hangs keeps its
 * port bound and answers nothing, and the job still reads `running`, so no exit ever comes; and a supervisor that is
 * killed takes the server with it, because launchd kills the job's process group and then never restarts the job.
 * `--health-url` answers the first: a server that misses `--health-misses` probes in a row (one every
 * `--health-every` seconds, after a start-up grace) is killed, and the ordinary restart path takes over. The agent's
 * `AbandonProcessGroup` answers the second — the server outlives a dead supervisor — and `--reclaim-port` makes that
 * safe: before each start, a listener on that port running **exactly this command** is a leftover from a previous
 * generation and is stopped first. A listener running anything else is reported and left alone.
 *
 * **One supervisor per service, by lock** (`--lock FILE`): reclaiming is only safe when no second supervisor of the
 * same service is alive, or each would stop the other's server in turn. The file records the holder's pid; a live
 * holder whose command line is a supervisor refuses the start, and anything else — a dead pid, a reused one — is a
 * stale lock taken over. Node has no `flock`, so this is the convention's third discriminator: a pidfile with its
 * command line checked.
 *
 * A server run that lasts at least `STABLE_MS` resets the failure count and is restarted immediately. Runs that
 * die sooner are restarted at a doubling delay, and after `--max-failures` of them it **slows down instead of
 * stopping**: one retry every `--retry-seconds` (60 s by default), with one loud line saying so. Exiting is the
 * right shape where the platform restarts the job — and wrong here, where launchd was measured not to: a transient
 * cause (another process holding the port for a minute, a profile being written) would otherwise leave the page
 * down until a person noticed. `--give-up` restores the bounded behaviour for a host whose platform does restart
 * the job.
 */

/** A run at least this long counts as having started: a crash loop shorter than this is a failure to start. */
const STABLE_MS = 5_000
/** The longest a restart is delayed, however many have failed. */
const MAX_DELAY_MS = 5_000
/** Consecutive failed starts before the supervisor stops retrying fast. */
const DEFAULT_MAX_FAILURES = 10
/**
 * How long it waits between slow retries once that limit is reached.
 *
 * The first version **exited 1** after the fast retries, and on a host whose platform restarts the job that is the
 * right shape: launchd or systemd picks it up and the log says why. On this Mac, launchd was measured not to
 * restart a loaded agent at all, so exiting means the page stays down until a person or a monitor notices — even
 * when the cause was transient (another process holding the port for a minute). A slow retry keeps the service
 * alive through that, at one log line a minute; `--give-up` asks for the old bounded behaviour for a host whose
 * platform does restart the job.
 */
const DEFAULT_SLOW_RETRY_MS = 60_000
/** Seconds between health probes, probes missed in a row before a restart, and the start-up grace before counting. */
const DEFAULT_HEALTH_EVERY_MS = 5_000
const DEFAULT_HEALTH_MISSES = 3
const DEFAULT_HEALTH_GRACE_MS = 20_000
/** How long a probe may take before it counts as missed. */
const PROBE_TIMEOUT_MS = 2_000

/**
 * The delay before restart number `failures` (1-based): 250 ms, doubling, capped.
 *
 * Backoff exists because a server that cannot bind its port fails in milliseconds, and restarting it as fast as
 * possible turns one failure into thousands of log lines and a busted CPU.
 */
export function restartDelay(failures) {
  const n = Math.max(1, failures)
  return Math.min(250 * 2 ** (n - 1), MAX_DELAY_MS)
}

/**
 * What to do after a run of `ranForMs` ended, given how many starts have already failed in a row.
 *
 * Returns the new count, the delay, and whether to give up. A run that lasted counts as a start, which is the
 * distinction between "the server keeps crashing" and "the server was killed once after hours of work".
 */
export function nextAttempt({
  ranForMs,
  failures,
  maxFailures = DEFAULT_MAX_FAILURES,
  slowRetryMs = DEFAULT_SLOW_RETRY_MS,
  giveUp = false,
}) {
  if (ranForMs >= STABLE_MS) return { failures: 0, delayMs: 0, slow: false, giveUp: false }
  const grown = failures + 1
  if (grown >= maxFailures) {
    if (giveUp) return { failures: grown, delayMs: 0, slow: false, giveUp: true }
    return { failures: grown, delayMs: slowRetryMs, slow: true, giveUp: false }
  }
  return { failures: grown, delayMs: restartDelay(grown), slow: false, giveUp: false }
}

/**
 * What one health probe means for a running server: `{ misses, restart }`.
 *
 * A server that has never answered gets `graceMs` to start before a miss counts, so a slow start is not a hang; after
 * that, or once it has answered, `allowed` misses in a row mean it is hung and must be restarted. One answer resets
 * the count, so a single slow request does not restart a working server.
 */
export function afterProbe({ ok, misses, allowed = DEFAULT_HEALTH_MISSES, ranForMs, graceMs = DEFAULT_HEALTH_GRACE_MS, answeredOnce }) {
  if (ok) return { misses: 0, restart: false }
  if (!answeredOnce && ranForMs < graceMs) return { misses, restart: false }
  const grown = misses + 1
  return { misses: grown, restart: grown >= allowed }
}

/**
 * Whether the process listening on our port is a leftover of this same service: its command line is exactly the
 * command this supervisor runs. Anything else is somebody else's process and is never ours to stop.
 */
export function isOurLeftover(listenerCommand, command) {
  const normal = (text) => text.trim().split(/\s+/).join(' ')
  return typeof listenerCommand === 'string' && listenerCommand.trim() !== '' && normal(listenerCommand) === normal(command.join(' '))
}

/**
 * Whether this supervisor may take the lock: `take` unless the recorded holder is another live supervisor.
 *
 * A pid alone is not proof: pids are reused, so a live pid whose command line is not a supervisor is a stale lock.
 */
export function lockVerdict({ holderPid, holderAlive, holderCommand, selfPid }) {
  if (!Number.isInteger(holderPid) || holderPid <= 0 || holderPid === selfPid) return 'take'
  if (!holderAlive) return 'take'
  return typeof holderCommand === 'string' && holderCommand.includes('supervisor.mjs') ? 'refuse' : 'take'
}

/**
 * The command line as `{ command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses,
 * healthGraceMs, reclaimPort, lock }`.
 *
 * Everything after `--` is the server and is passed through untouched: flags, paths with spaces, and a program
 * that is not node (the Rust binary the port will serve) all stay exactly as the installer rendered them.
 */
export function parseSupervisorArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('missing "--" before the server command')
  let maxFailures = DEFAULT_MAX_FAILURES
  let slowRetryMs = DEFAULT_SLOW_RETRY_MS
  let giveUp = false
  let healthUrl = null
  let healthEveryMs = DEFAULT_HEALTH_EVERY_MS
  let healthMisses = DEFAULT_HEALTH_MISSES
  let healthGraceMs = DEFAULT_HEALTH_GRACE_MS
  let reclaimPort = null
  let lock = null
  const number = (flag, at) => {
    const value = argv[at + 1]
    if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
      throw new Error(`${flag} needs a positive integer`)
    }
    return Number(value)
  }
  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index]
    if (arg === '--max-failures') {
      maxFailures = number(arg, index)
      index += 1
    } else if (arg === '--retry-seconds') {
      slowRetryMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--give-up') {
      giveUp = true
    } else if (arg === '--health-url') {
      const value = argv[index + 1]
      if (value === undefined || !/^https?:\/\//.test(value)) throw new Error('--health-url needs an http(s) URL')
      healthUrl = value
      index += 1
    } else if (arg === '--health-every') {
      healthEveryMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--health-misses') {
      healthMisses = number(arg, index)
      index += 1
    } else if (arg === '--health-grace') {
      healthGraceMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--reclaim-port') {
      reclaimPort = number(arg, index)
      index += 1
    } else if (arg === '--lock') {
      const value = argv[index + 1]
      if (value === undefined || !value.startsWith('/')) throw new Error('--lock needs an absolute path')
      lock = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'usage: supervisor.mjs [--max-failures N] [--retry-seconds S] [--give-up] [--health-url URL [--health-every S] [--health-misses N] [--health-grace S]] [--reclaim-port N] [--lock FILE] -- <program> [arguments…]',
      )
    } else {
      throw new Error(`unknown supervisor option ${arg}`)
    }
  }
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error('no server command after --')
  return { command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses, healthGraceMs, reclaimPort, lock }
}

/** The command line of `pid`, or `null` when it is not running. */
function commandOf(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return null
  }
  const shown = spawnSync(PS, ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return (shown.stdout ?? '').trim()
}

/** Take the lock at `path`, or return the live holder's pid. Written atomically: a temporary file, then a rename. */
function takeLock(path) {
  let holderPid = null
  try {
    holderPid = Number(readFileSync(path, 'utf8').trim())
  } catch {
    // no lock yet
  }
  const holderCommand = Number.isInteger(holderPid) && holderPid > 0 ? commandOf(holderPid) : null
  const verdict = lockVerdict({ holderPid, holderAlive: holderCommand !== null, holderCommand, selfPid: process.pid })
  if (verdict === 'refuse') return holderPid
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, `${process.pid}\n`)
  renameSync(temporary, path)
  return null
}

/** Release the lock, only while it is still ours. */
function releaseLock(path) {
  try {
    if (Number(readFileSync(path, 'utf8').trim()) === process.pid) rmSync(path, { force: true })
  } catch {
    // already gone
  }
}

/**
 * The first of `candidates` that exists, else the bare name for `PATH` to resolve.
 *
 * By absolute path because the agent's `PATH` is `/usr/local/bin:/usr/bin:/bin` plus node's folder, and macOS keeps
 * `lsof` in `/usr/sbin`: measured 2026-10-22 on a scratch agent, the bare name was not found, the reclaim saw no
 * listener, and the new server failed to bind ten times in a row beside the orphan it should have replaced.
 */
function tool(candidates) {
  return candidates.find((path) => existsSync(path)) ?? candidates[candidates.length - 1]
}
const LSOF = tool(['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'])
const PS = tool(['/bin/ps', '/usr/bin/ps', 'ps'])

/**
 * The pid listening on 127.0.0.1:`port` and its command line, `null` when nothing listens, or `{ error }` when the
 * question cannot be asked — which is reported, never read as "nothing listens".
 */
function listenerOn(port) {
  const found = spawnSync(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (found.error) return { error: `${LSOF}: ${found.error.message}` }
  const pid = Number((found.stdout ?? '').trim().split('\n')[0])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const shown = spawnSync(PS, ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return { pid, command: (shown.stdout ?? '').trim() }
}

/**
 * Stop a leftover of this service holding `port` before a start: SIGTERM, then SIGKILL after three seconds.
 *
 * The leftover exists because the agent abandons its process group: a supervisor that was killed leaves its server
 * serving, which is the point, and the next supervisor would otherwise fail to bind for as long as it lives.
 */
async function reclaim(port, command) {
  const listener = listenerOn(port)
  if (listener === null) return
  if (listener.error) {
    process.stderr.write(`heddle-supervisor: cannot look for a leftover on port ${port} (${listener.error}); starting anyway\n`)
    return
  }
  if (!isOurLeftover(listener.command, command)) {
    process.stderr.write(`heddle-supervisor: port ${port} is held by pid ${listener.pid} (${listener.command}), which is not this service; leaving it alone\n`)
    return
  }
  process.stdout.write(`heddle-supervisor: reclaiming port ${port} from a previous generation (pid ${listener.pid})\n`)
  const signal = (name) => {
    try {
      process.kill(listener.pid, name)
    } catch {
      // already gone
    }
  }
  signal('SIGTERM')
  for (let waited = 0; waited < 3_000; waited += 100) {
    if (listenerOn(port)?.pid !== listener.pid) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signal('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 200))
}

/** One probe: true when the URL answers 2xx within the timeout. */
async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await response.arrayBuffer().catch(() => {})
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start one server and describe it while it runs.
 *
 * Resolves with a handle the loop can signal and await; it never rejects, because a program that cannot even be
 * created is a failed start like any other and the loop above is the one place that decides what to do about it.
 */
function startServer(command) {
  let child = null
  try {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
  } catch (error) {
    process.stderr.write(`heddle-supervisor: could not start ${command[0]}: ${error.message}\n`)
  }
  const startedAt = Date.now()
  const signalling = (signal) => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  const done =
    child === null
      ? Promise.resolve({ code: null, signal: null, ranForMs: 0 })
      : new Promise((resolve) => {
          let settled = false
          const finish = (code, signal) => {
            if (settled) return
            settled = true
            resolve({ code, signal, ranForMs: Date.now() - startedAt })
          }
          child.once('error', (error) => {
            process.stderr.write(`heddle-supervisor: ${command[0]}: ${error.message}\n`)
            finish(null, null)
          })
          child.once('exit', (code, signal) => finish(code, signal))
        })
  return { startedAt, signalling, done }
}

async function main() {
  let parsed
  try {
    parsed = parseSupervisorArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`heddle-supervisor: ${error.message}\n`)
    process.exit(2)
  }
  const { command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses, healthGraceMs, reclaimPort, lock } = parsed
  if (lock !== null) {
    const holder = takeLock(lock)
    if (holder !== null) {
      process.stderr.write(`heddle-supervisor: another supervisor (pid ${holder}) already runs this service (lock ${lock}); not starting a second\n`)
      process.exit(3)
    }
    process.on('exit', () => releaseLock(lock))
  }

  let stopping = false
  let failures = 0
  let slowedBefore = false
  let current = null
  let wake = null

  const stop = () => {
    stopping = true
    current?.signalling('SIGTERM')
    // A hung server — a stopped process, or one stuck in a loop — never acts on SIGTERM, and launchd would then wait
    // out its own exit timeout before killing this supervisor. Five seconds is the server's chance to stop cleanly.
    const run = current
    if (run !== null) setTimeout(() => run.signalling('SIGKILL'), 5_000).unref()
    if (wake !== null) wake()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  process.stdout.write(`heddle-supervisor: running ${command.join(' ')}\n`)
  while (!stopping) {
    if (reclaimPort !== null) await reclaim(reclaimPort, command)
    if (stopping) break
    current = startServer(command)
    let watch = null
    if (healthUrl !== null) {
      // Probe the running server; a hung one is killed, and its exit takes the ordinary restart path below.
      const run = current
      let misses = 0
      let answeredOnce = false
      let probing = false
      watch = setInterval(async () => {
        if (probing) return
        probing = true
        const ok = await probe(healthUrl)
        probing = false
        if (ok) answeredOnce = true
        const verdict = afterProbe({ ok, misses, allowed: healthMisses, ranForMs: Date.now() - run.startedAt, graceMs: healthGraceMs, answeredOnce })
        misses = verdict.misses
        if (verdict.restart && !stopping) {
          process.stderr.write(`heddle-supervisor: ${healthUrl} missed ${misses} probes in a row; the server is hung, restarting it\n`)
          run.signalling('SIGKILL')
          clearInterval(watch)
        }
      }, healthEveryMs)
    }
    const ended = await current.done
    if (watch !== null) clearInterval(watch)
    current = null
    if (stopping) break
    process.stdout.write(
      `heddle-supervisor: ${command[0]} exited (${ended.signal ?? `code ${ended.code}`}) after ${ended.ranForMs} ms\n`,
    )
    const attempt = nextAttempt({ ranForMs: ended.ranForMs, failures, maxFailures, slowRetryMs, giveUp })
    const slowed = attempt.slow && !slowedBefore
    failures = attempt.failures
    slowedBefore = attempt.slow
    if (attempt.giveUp) {
      process.stderr.write(
        `heddle-supervisor: giving up after ${failures} failed starts in a row; the log above says why\n`,
      )
      process.exit(1)
    }
    if (attempt.delayMs > 0) {
      if (slowed) {
        process.stderr.write(
          `heddle-supervisor: ${failures} starts in a row failed; still retrying, every ${Math.round(attempt.delayMs / 1000)} s, because nothing else restarts this service on this host\n`,
        )
      }
      process.stdout.write(`heddle-supervisor: restarting in ${attempt.delayMs} ms\n`)
      await new Promise((resolve) => {
        wake = resolve
        setTimeout(resolve, attempt.delayMs)
      })
      wake = null
    }
  }
  process.stdout.write('heddle-supervisor: stopped\n')
  process.exit(0)
}

/**
 * Run only when this file is the program.
 *
 * The rules above are imported by `_tests_/supervisor-rules`, and importing a supervisor must not start one — the
 * first version of this file did, and the test run became the server's command line.
 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`heddle-supervisor: ${error.stack ?? error.message}\n`)
    process.exit(1)
  })
}
