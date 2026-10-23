#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import { repoRoot } from './lib.mjs'

/**
 * The **lane gate**: may a merge candidate go to `main`, judged by the verifiers of the parts a lane owns?
 *
 *   HEDDLE_BIN=rust/target/release/heddle node _tools_/verify-runner/lane.mjs 05-config-system 10-llm-backends ...
 *   node _tools_/verify-runner/lane.mjs --json --timeout 400 <part> ...
 *
 * It answers a different question from `all.mjs`. `all.mjs` asks whether every part **holds**, so an unjudged part is a
 * failure there. A lane gate asks whether the candidate **breaks** anything: a check that fails, or a check file that
 * produced no verdict at all, blocks the merge; a check that could not be judged — its capability is not advertised
 * yet — does not (D-042). So the gate is green with unjudged checks, and red the moment one check fails.
 *
 * A check file that times out or crashes is counted as broken, never as unjudged: measured on 2026-10-22, a lane run
 * whose summary dropped such a file would have read a half-wired binary's five-minute stall as "nothing failed".
 *
 * Exit: 0 green (nothing failed, nothing broken), 1 red, 2 usage.
 */

const DEFAULT_TIMEOUT_SECONDS = 400

/**
 * The gate's decision over one record per check file.
 *
 * A record is `{ part, check, result }` where `result` is the runner's `--json` object (`verdict`, `tests`, `pass`,
 * `fail`, `skipped`), or `null` when the file timed out, crashed, or printed no verdict. Red when any check failed, any
 * file's verdict is `1`, or any file is broken; green otherwise, whatever was left unjudged.
 */
export function laneVerdict(records) {
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 }
  const failing = []
  const broken = []
  for (const record of records) {
    const result = record.result
    if (result === null || typeof result !== 'object' || typeof result.verdict !== 'number') {
      broken.push(`${record.part}/${record.check}`)
      continue
    }
    totals.tests += result.tests ?? 0
    totals.pass += result.pass ?? 0
    totals.fail += result.fail ?? 0
    totals.skipped += result.skipped ?? 0
    if ((result.fail ?? 0) > 0 || result.verdict === 1) failing.push(`${record.part}/${record.check}`)
  }
  const green = failing.length === 0 && broken.length === 0
  return { verdict: green ? 'green' : 'red', ...totals, files: records.length, failing, broken }
}

/** Parse the last line of a runner's `--json` output, or `null` when there is no verdict to read. */
export function parseVerdictLine(stdout) {
  const last = String(stdout ?? '').trim().split('\n').pop() ?? ''
  try {
    const value = JSON.parse(last)
    return value !== null && typeof value === 'object' && typeof value.verdict === 'number' ? value : null
  } catch {
    return null
  }
}

/**
 * The command line: `--json`, `--timeout <seconds>`, and the part folders in the order given.
 *
 * Returns `null` for a command line the gate cannot run (no parts, or a timeout that is not a positive number).
 * Measured while writing it: an inline filter that skipped "the argument after --timeout" dropped the **first part**
 * whenever --timeout was absent, so a lane run silently judged one folder fewer than it was asked to.
 */
export function parseArgs(argv) {
  const parts = []
  let json = false
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--timeout') {
      timeoutSeconds = Number(argv[index + 1])
      index += 1
    } else if (arg.startsWith('--')) return null
    else parts.push(arg)
  }
  if (parts.length === 0 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return null
  return { parts, json, timeoutSeconds }
}

function usage() {
  process.stderr.write('usage: node _tools_/verify-runner/lane.mjs [--json] [--timeout <seconds>] <part> [<part> ...]\n')
  process.exitCode = 2
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args === null) return usage()
  const { parts, json, timeoutSeconds } = args

  const records = []
  for (const part of parts) {
    const dir = join(repoRoot, '_verifiers_', part)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      records.push({ part, check: '(missing folder)', result: null, seconds: 0 })
      continue
    }
    for (const check of readdirSync(dir).filter((name) => /^check.*\.mjs$/.test(name)).sort()) {
      const at = Date.now()
      const run = spawnSync(process.execPath, [join(repoRoot, '_tools_', 'verify-runner', 'run.mjs'), join('_verifiers_', part, check), '--json'], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: timeoutSeconds * 1000,
        killSignal: 'SIGKILL',
      })
      const result = run.error ? null : parseVerdictLine(run.stdout)
      const seconds = Math.round((Date.now() - at) / 100) / 10
      records.push({ part, check, result, seconds })
      if (!json) {
        const shown = result === null ? `BROKEN (${run.error ? run.error.code ?? 'error' : 'no verdict'})` : `verdict ${result.verdict}  pass ${result.pass}  fail ${result.fail}  skipped ${result.skipped}`
        process.stdout.write(`${part}/${check}`.padEnd(56) + `${shown}  ${seconds}s\n`)
      }
    }
  }

  const decision = laneVerdict(records)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...decision, binary: process.env.HEDDLE_BIN ?? null, records })}\n`)
  } else {
    process.stdout.write(
      `\n${decision.files} check file(s), ${decision.tests} checks: ${decision.pass} pass, ${decision.fail} fail, ${decision.skipped} unjudged` +
        `${decision.broken.length > 0 ? `, ${decision.broken.length} broken` : ''}\n` +
        `lane ${decision.verdict}${decision.failing.length > 0 ? ` — failing: ${decision.failing.join(', ')}` : ''}${decision.broken.length > 0 ? ` — broken: ${decision.broken.join(', ')}` : ''}\n`,
    )
  }
  process.exitCode = decision.verdict === 'green' ? 0 : 1
}

if (import.meta.main) main()
