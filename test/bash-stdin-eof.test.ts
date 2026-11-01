import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A command that reads stdin gets end-of-file at once (live-testing issue #97). The bash tool has no input to give,
 * and DSH's shell leaves stdin closed when none is supplied. The TypeScript runner left Node's default pipe open and
 * never ended it, so `read` waited until the wall time killed the command.
 */

async function bash(command: string, timeoutMs: number) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-stdin-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return await registry.call('bash', { command, timeoutMs }, { cwd: workspace, session: handle, log: () => {} })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a shell read gets end-of-file at once instead of waiting for the wall time', async () => {
  const started = Date.now()
  const result = await bash('if read -r line; then printf input; else printf eof; fi', 2000)
  assert.equal(result.error, undefined, `no error: ${JSON.stringify(result.error)}`)
  assert.equal(result.output, 'eof')
  assert.ok(Date.now() - started < 1500, 'well before the 2 s wall time')
})

test('a program that reads all of stdin sees it empty', async () => {
  const result = await bash('wc -c', 2000)
  assert.equal(result.error, undefined, `no error: ${JSON.stringify(result.error)}`)
  assert.equal(result.output.trim(), '0')
})
