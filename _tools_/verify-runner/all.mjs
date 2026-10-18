#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import { repoRoot } from './lib.mjs'

/**
 * Run **every** verifier part in order, with a per-part timing table and one verdict.
 *
 * The two targets are the same mechanism with one environment variable:
 *
 *   HEDDLE_VERIFY_UI=0 node _tools/verify-runner/all.mjs   # standard: no browser, deliberate skips allowed
 *   node _tools/verify-runner/all.mjs                      # UI: every check, browser included
 *
 * In standard mode each part is given `--allow-skip`, so its browser checks report skipped and the part's verdict is 0 with
 * its skipped count named. The table is printed either way, because knowing which part is slow is the reason the split
 * exists — the timings are measurements of this machine, not estimates.
 *
 * Exit: 0 when every part holds, 1 when any part fails. A part that could not be judged still exits 3 from the runner, and
 * that is reported as a failure of the target here: an unjudged part is not a pass.
 */

const root = repoRoot
const parts = readdirSync(join(root, '_verifiers_'))
  .filter((name) => /^[0-9]/.test(name) && statSync(join(root, '_verifiers_', name)).isDirectory())
  .sort()
const standard = process.env.HEDDLE_VERIFY_UI === '0'

const rows = []
let failed = 0
const started = Date.now()
for (const part of parts) {
  const script = join('_verifiers_', part, 'verify.sh')
  const at = Date.now()
  const result = spawnSync('sh', [script, ...(standard ? ['--allow-skip'] : [])], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 900_000,
  })
  const ms = Date.now() - at
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const verdict = /verdict \d+ — (.*)/.exec(output)?.[1] ?? (result.status === 0 ? 'holds' : `exit ${String(result.status)}`)
  const ok = result.status === 0
  if (!ok) failed += 1
  rows.push({ part, ms, ok, verdict })
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${part.padEnd(26)} ${String(Math.round(ms / 100) / 10).padStart(6)}s  ${verdict}\n`)
}

const total = Date.now() - started
const width = rows.reduce((longest, row) => Math.max(longest, row.part.length), 0)
process.stdout.write(`\n${'-'.repeat(width + 40)}\n`)
for (const row of [...rows].sort((left, right) => right.ms - left.ms).slice(0, 6)) {
  process.stdout.write(`slowest  ${row.part.padEnd(width)} ${String(Math.round(row.ms / 100) / 10).padStart(6)}s\n`)
}
const skipped = rows.reduce((sum, row) => sum + (/skipped/.exec(row.verdict) === null ? 0 : 1), 0)
process.stdout.write(
  `\n${failed === 0 ? 'verdict 0' : 'verdict 1'} — ${rows.length - failed}/${rows.length} part(s) hold in ${Math.round(total / 100) / 10}s` +
    `${standard ? ` (standard target: no browser, ${skipped} part(s) state skipped checks)` : ' (UI target: browser included)'}\n`,
)
process.exitCode = failed === 0 ? 0 : 1
