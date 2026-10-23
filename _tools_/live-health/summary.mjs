#!/usr/bin/env node
/**
 * The pinned live-health record as a table, newest last.
 *
 * Read-only: it reads `_context_/rust-port/live-health.jsonl` and prints Markdown. The record is the
 * JSONL, which the scheduled pass appends to; this is how a person reads it without the prose table
 * in `live-health.md` falling behind.
 *
 *   node _tools_/live-health/summary.mjs            # every pass
 *   node _tools_/live-health/summary.mjs --last=12  # the newest twelve
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArguments, summaryRow } from './rules.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const options = parseArguments(process.argv.slice(2))
const entries = readFileSync(join(REPO, '_context_', 'rust-port', 'live-health.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))
const last = Number(options.last)
const shown = Number.isFinite(last) && last > 0 ? entries.slice(-last) : entries

const header = ['At (UTC)', 'Deployment', 'Gate', 'Process', 'Door', 'Load', 'Marker', 'Turn', 'Console', 'Outage', 'Verdict', 'Preview']
const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
for (const entry of shown) lines.push(`| ${summaryRow(entry).join(' | ')} |`)
const failed = entries.filter((entry) => entry.verdict === 'fail').length
process.stdout.write(`${lines.join('\n')}\n\n${entries.length} passes pinned, ${failed} failed; showing ${shown.length}.\n`)
