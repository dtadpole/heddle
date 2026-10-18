#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'

/**
 * The runner behind every verifier in `_verifiers_/`.
 *
 * It exists for one reason: this project's verifiers keep the project's verdict
 * contract, and `node --test` alone cannot. Measured on Node v24.19.0, a suite
 * where every check is skipped exits `0`, which is exactly the answer that must
 * never be given for "nothing was judged". So the runner reads the TAP stream,
 * counts what actually happened, and exits `3` when nothing was judged or when
 * any check was skipped.
 *
 *   node _tools_/verify-runner/run.mjs <check.mjs> [--list] [--json]
 *
 * Exit contract:
 *   0  every check passed
 *   1  at least one check failed
 *   3  nothing could be judged (a skip, or no checks at all)
 */

const USAGE = `usage: node _tools_/verify-runner/run.mjs <check.mjs> [--list] [--json]

Runs one verifier check file under node's test runner and exits with the
project's verdict: 0 holds, 1 fails, 3 could not be judged.`

function usage(stream, code) {
  stream.write(`${USAGE}\n`)
  process.exitCode = code
}

/** Recursively collect node's own JSON records, including nested subtests. */
function collect(record, out = []) {
  out.push(record)
  for (const nested of record.subtests ?? []) collect(nested, out)
  return out
}

/**
 * Read the TAP trailing counters.
 *
 * Node writes these without a colon — measured on v24.19.0: `# tests 4`,
 * `# pass 0`, `# skipped 4`. The first version of this file expected a colon and
 * therefore read every suite as empty, which is worth recording because the
 * symptom was silent: every verifier returned `3`, which looks exactly like a
 * project with nothing built yet.
 */
export function tapCounts(text, key) {
  const match = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(text)
  return match ? Number(match[1]) : 0
}

/**
 * Run one check file and return the verdict rather than exiting, so the
 * classification above is testable.
 *
 * @param {string} check absolute path to a `*.check.mjs` file
 * @param {{list?: boolean, json?: boolean, allowSkip?: boolean}} options
 */
export async function runCheck(check, options = {}) {
  const args = ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', check]

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })

  const result = classify(stdout, stderr, code, { allowSkip: options.allowSkip === true })
  return { ...result, code, stdout, stderr, check }
}

/**
 * Turn a node test run into the project's verdict.
 *
 * Exported because the mapping is the whole point of this file and is worth a
 * test of its own: an unjudged check must never be counted as a pass.
 */
export function classify(stdout, stderr, code, options = {}) {
  const tests = tapCounts(stdout, 'tests')
  const pass = tapCounts(stdout, 'pass')
  const fail = tapCounts(stdout, 'fail')
  const skipped = tapCounts(stdout, 'skipped')
  const cancelled = tapCounts(stdout, 'cancelled')
  const todo = tapCounts(stdout, 'todo')

  const counts = { tests, pass, fail, skipped, cancelled, todo }

  if (tests === 0) return { verdict: 3, reason: 'no checks were collected', counts }
  if (fail > 0 || cancelled > 0) return { verdict: 1, reason: `${fail || cancelled} check(s) failed`, counts }
  if (pass === 0 && skipped === 0 && todo === 0) return { verdict: 3, reason: 'no verdict was produced', counts }
  if (skipped > 0 || todo > 0) {
    /**
     * The **standard target** deliberately excludes the browser checks (`HEDDLE_VERIFY_UI=0`), so their skips are a stated
     * part of that run rather than an unjudged gap. The flag is explicit: without `--allow-skip`, a skip still means exit 3,
     * which is the contract this runner exists for.
     */
    if (options.allowSkip === true && fail === 0 && cancelled === 0) {
      return { verdict: 0, reason: `all ${pass} judged check(s) passed; ${skipped + todo} skipped by this target`, counts }
    }
    return { verdict: 3, reason: `${skipped + todo} of ${tests} check(s) could not be judged`, counts }
  }
  if (pass === 0) return { verdict: 3, reason: 'every check was skipped, so nothing was judged', counts }
  return { verdict: 0, reason: `all ${pass} check(s) passed`, counts }
}

/**
 * The check names and how each finished.
 *
 * A TAP `ok` line carries an optional trailing `# SKIP <reason>`, which is where
 * an unjudged check says why. Node indents these lines inside a suite, so the
 * leading whitespace is part of the shape rather than noise.
 */
export function collectNames(stdout) {
  const names = []
  for (const line of stdout.split('\n')) {
    const ok = /^\s*ok \d+ - (.+)$/.exec(line)
    if (ok) {
      const body = ok[1]
      const skip = / # SKIP(?: (.*))?$/.exec(body)
      const name = body.replace(/ # (SKIP|TODO).*$/, '').trim()
      names.push(skip ? { name, status: 'skip', reason: (skip[1] ?? '').trim() } : { name, status: 'pass' })
      continue
    }
    const notOk = /^\s*not ok \d+ - (.+)$/.exec(line)
    if (notOk) names.push({ name: notOk[1].replace(/ # .*$/, '').trim(), status: 'fail' })
  }
  return names
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) return usage(process.stderr, 2)
  const check = argv.find((arg) => !arg.startsWith('-'))
  const list = argv.includes('--list')
  const json = argv.includes('--json')
  const allowSkip = argv.includes('--allow-skip')
  if (!check) return usage(process.stderr, 2)

  const result = await runCheck(check, { list, json, allowSkip })

  if (list) {
    for (const entry of collectNames(result.stdout)) {
      const suffix = entry.status === 'skip' ? `  [unjudged${entry.reason ? `: ${entry.reason}` : ''}]` : ''
      process.stdout.write(`${entry.status.padEnd(6)} ${entry.name}${suffix}\n`)
    }
    process.exitCode = result.verdict
    return
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ check: result.check, verdict: result.verdict, ...result.counts, reason: result.reason })}\n`,
    )
    process.exitCode = result.verdict
    return
  }

  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.stdout.write(`\nverdict ${result.verdict} — ${result.reason}\n`)
  process.exitCode = result.verdict
}

// Exported for the runner's own test; executed when invoked directly.
if (import.meta.main) await main()
