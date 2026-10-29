import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { BASH_OUTPUT_LIMIT, builtinTools } from '../src/tools/builtin.ts'
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

test('a configured output limit cuts the combined output there and marks the cut', async () => {
  const result = await bashWith({ bashOutputLimit: 50 }, "printf 'a%.0s' $(seq 1 500)")
  assert.equal(result.error, undefined)
  assert.equal(result.output, `${'a'.repeat(50)}\n… truncated`)
})

test('output within the limit is untouched, and the default is the old fixed 20,000', async () => {
  const result = await bashWith({ bashOutputLimit: 500 }, "printf 'b%.0s' $(seq 1 500)")
  assert.equal(result.output, 'b'.repeat(500))
  assert.equal(BASH_OUTPUT_LIMIT, 20_000)
  const unset = await bashWith({}, "printf 'c%.0s' $(seq 1 20010)")
  assert.equal(unset.output, `${'c'.repeat(20_000)}\n… truncated`)
})
