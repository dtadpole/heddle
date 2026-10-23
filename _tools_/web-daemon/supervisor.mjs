#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
 *   node supervisor.mjs --max-failures 10 -- <program> [server arguments…]
 *
 * A server run that lasts at least `STABLE_MS` resets the failure count and is restarted immediately. Runs that
 * die sooner are restarted at a doubling delay, and after `--max-failures` of them **the supervisor gives up and
 * exits 1** rather than spinning forever: a broken build, a taken port or a missing profile is a person's problem,
 * and a loop that hides it is worse than a service that stops where the log says why.
 */

/** A run at least this long counts as having started: a crash loop shorter than this is a failure to start. */
const STABLE_MS = 5_000
/** The longest a restart is delayed, however many have failed. */
const MAX_DELAY_MS = 5_000
/** Consecutive failed starts before the supervisor stops trying. */
const DEFAULT_MAX_FAILURES = 10

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
export function nextAttempt({ ranForMs, failures, maxFailures = DEFAULT_MAX_FAILURES }) {
  if (ranForMs >= STABLE_MS) return { failures: 0, delayMs: 0, giveUp: false }
  const grown = failures + 1
  if (grown >= maxFailures) return { failures: grown, delayMs: 0, giveUp: true }
  return { failures: grown, delayMs: restartDelay(grown), giveUp: false }
}

/**
 * The command line as `{ command, maxFailures }`.
 *
 * Everything after `--` is the server and is passed through untouched: flags, paths with spaces, and a program
 * that is not node (the Rust binary the port will serve) all stay exactly as the installer rendered them.
 */
export function parseSupervisorArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('missing "--" before the server command')
  let maxFailures = DEFAULT_MAX_FAILURES
  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index]
    if (arg === '--max-failures') {
      const value = argv[index + 1]
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error('--max-failures needs a positive integer')
      }
      maxFailures = Number(value)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('usage: supervisor.mjs [--max-failures N] -- <program> [arguments…]')
    } else {
      throw new Error(`unknown supervisor option ${arg}`)
    }
  }
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error('no server command after --')
  return { command, maxFailures }
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
  const { command, maxFailures } = parsed

  let stopping = false
  let failures = 0
  let current = null
  let wake = null

  const stop = () => {
    stopping = true
    current?.signalling('SIGTERM')
    if (wake !== null) wake()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  process.stdout.write(`heddle-supervisor: running ${command.join(' ')}\n`)
  while (!stopping) {
    current = startServer(command)
    const ended = await current.done
    current = null
    if (stopping) break
    process.stdout.write(
      `heddle-supervisor: ${command[0]} exited (${ended.signal ?? `code ${ended.code}`}) after ${ended.ranForMs} ms\n`,
    )
    const attempt = nextAttempt({ ranForMs: ended.ranForMs, failures, maxFailures })
    failures = attempt.failures
    if (attempt.giveUp) {
      process.stderr.write(
        `heddle-supervisor: giving up after ${failures} failed starts in a row; the log above says why\n`,
      )
      process.exit(1)
    }
    if (attempt.delayMs > 0) {
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
