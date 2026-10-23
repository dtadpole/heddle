// The TypeScript side of the differential: projects a decoded session log with src/server/ledger.ts.
//
//   node ts_projection.mjs <log.jsonl>                 prints { ledger, rows, timeline, stats } as JSON
//   node ts_projection.mjs <log.jsonl> <rust.json>     compares with project_log's output; exit 0 when equal
//
// Equal means equal after JSON.parse, which is how the page reads the answers: key order and the spelling of a
// number (`1.0` from Rust, `1` from JavaScript) do not count. The download, where bytes matter, is compared
// byte for byte by the real-server probe instead (VERIFICATION.md). Runs from source with Node 24.
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const ledgerModule = new URL('../../../../src/server/ledger.ts', import.meta.url)
const { projectLedger, projectRows, projectTimeline, projectSessionStats } = await import(ledgerModule.href)

const [logPath, rustPath] = process.argv.slice(2)
if (logPath === undefined) {
  console.error('usage: node ts_projection.mjs <log.jsonl> [rust.json]')
  process.exit(2)
}
const events = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
const ledger = projectLedger(events)
const projection = { ledger, rows: projectRows(ledger), timeline: projectTimeline(ledger), stats: projectSessionStats(events) }

if (rustPath === undefined) {
  console.log(JSON.stringify(projection, null, 2))
} else {
  const rust = JSON.parse(readFileSync(rustPath, 'utf8'))
  const typescript = JSON.parse(JSON.stringify(projection))
  const parts = ['ledger', 'rows', 'timeline', 'stats'].filter((part) => !isDeepStrictEqual(typescript[part], rust[part]))
  console.log(parts.length === 0 ? `identical: ${logPath}` : `DIFFERENT in ${parts.join(', ')}: ${logPath}`)
  process.exit(parts.length === 0 ? 0 : 1)
}
