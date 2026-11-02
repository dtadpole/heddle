// A finished bash call's stderr comes back in its own section after stdout, as DSH's bash renders a run (`dsh-tool-bash`
// renderResult): stdout, a newline when stdout has text that does not end in one, then `[stderr]` and a newline before
// the stderr text. Live-testing issue #246: both builds glued the streams, so `printf out; printf err >&2` came back as
// `outerr`, in success and after a failure alike, and a warning on stderr read as ordinary output. heddle keeps its
// error line first; the marker order of exits and timeouts is not judged here.
// A scripted endpoint asks for one bash call per run. Runs against whichever harness HEDDLE_BIN names, or the TS build.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { oneToolCall } from './fs-tool-turn.mjs'

/** Run one turn whose model runs `command` once; return the tool results. */
async function bashResult(command) {
  const { results } = await oneToolCall({ label: 'bash-streams', tool: 'bash', args: () => ({ command }) })
  return results
}

test('stdout and stderr come back apart, stderr under a [stderr] marker', async () => {
  assert.deepEqual(await bashResult('printf out; printf err >&2'), ['out\n[stderr]\nerr'])
})

test('a command that fails keeps the same marked body below its error line', async () => {
  assert.deepEqual(await bashResult('printf out; printf err >&2; exit 7'), ['error (EXIT): the command exited 7\nout\n[stderr]\nerr'])
})

test('stdout that ends in a newline gets no second one before the marker', async () => {
  assert.deepEqual(await bashResult("printf 'out\\n'; printf err >&2"), ['out\n[stderr]\nerr'])
})

test('stderr alone is still marked', async () => {
  assert.deepEqual(await bashResult('printf err >&2'), ['[stderr]\nerr'])
})

test('stdout alone comes back as before', async () => {
  assert.deepEqual(await bashResult('printf out'), ['out'])
})
