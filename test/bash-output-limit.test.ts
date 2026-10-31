import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { BASH_OUTPUT_LIMIT, builtinTools, tailOutput } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/** The bash output cap is a setting (`tools.bashOutputLimit`), as DSH's shell output cap is, not a fixed 20,000. */

async function bashWith(options: { readonly bashOutputLimit?: number }, command: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-limit-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox, options)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return await registry.call('bash', { command }, { cwd: workspace, session: handle, log: () => {} })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The kept tail and the spill path of a cut output. */
function cutParts(output: string): { kept: string; path: string } {
  const match = /^([\s\S]*)\n\[output truncated; full output: (.+)\]$/.exec(output)
  assert.ok(match, `the cut is marked with the spill path: ${output.slice(-120)}`)
  return { kept: match[1] as string, path: match[2] as string }
}

test('a configured output limit keeps the last characters and names a file with all of the output (#83)', async () => {
  const result = await bashWith({ bashOutputLimit: 50 }, "printf 'HEAD-PROBE'; printf 'a%.0s' $(seq 1 500); printf 'TAIL-PROBE'")
  assert.equal(result.error, undefined)
  const { kept, path } = cutParts(result.output)
  assert.equal(kept, `${'a'.repeat(40)}TAIL-PROBE`, 'the end of the output, which DSH keeps')
  assert.equal(readFileSync(path, 'utf8'), `HEAD-PROBE${'a'.repeat(500)}TAIL-PROBE`, 'the file holds the whole output')
  rmSync(path, { force: true })
})

test('a cut never starts on half a character', () => {
  const { kept, path } = cutParts(tailOutput(`${'a'.repeat(10)}😀z`, 2))
  assert.equal(kept, 'z', 'the emoji would have been split, so the tail starts after it')
  rmSync(path, { force: true })
})

test('output within the limit is untouched, and the default is the old fixed 20,000', async () => {
  const result = await bashWith({ bashOutputLimit: 500 }, "printf 'b%.0s' $(seq 1 500)")
  assert.equal(result.output, 'b'.repeat(500))
  assert.equal(BASH_OUTPUT_LIMIT, 20_000)
  const unset = await bashWith({}, "printf 'c%.0s' $(seq 1 20010)")
  const { kept, path } = cutParts(unset.output)
  assert.equal(kept, 'c'.repeat(20_000))
  rmSync(path, { force: true })
})

test('an output beyond the full-output cap names no file rather than a partial one (#83 review)', () => {
  // DSH discards a spill past its cap, so the marker never points at an incomplete copy.
  assert.equal(tailOutput('x'.repeat(100), 10, 50), `${'x'.repeat(10)}\n[output truncated; full output: (unavailable)]`)
})
