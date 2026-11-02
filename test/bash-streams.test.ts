import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools, markedStreams } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A finished command's stderr comes back in its own `[stderr]` section after stdout, as DSH's bash renders a run
 * (`dsh-tool-bash` renderResult). Live-testing issue #246: both builds glued the streams, so `printf out; printf err
 * >&2` came back as `outerr`.
 */

async function bash(command: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-streams-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return await registry.call('bash', { command }, { cwd: workspace, session: handle, log: () => {} })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('stdout and stderr come back apart, stderr under a [stderr] marker', async () => {
  const result = await bash('printf out; printf err >&2')
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'out\n[stderr]\nerr')
})

test('a failed command keeps the same marked body under its error', async () => {
  const result = await bash('printf out; printf err >&2; exit 7')
  assert.deepEqual(result.error, { code: 'EXIT', message: 'the command exited 7' })
  assert.equal(result.output, 'out\n[stderr]\nerr')
})

test('stderr alone is still marked, and stdout alone is unchanged', async () => {
  assert.equal((await bash('printf err >&2')).output, '[stderr]\nerr')
  assert.equal((await bash('printf out')).output, 'out')
})

test('markedStreams adds a newline before the marker only when stdout lacks one', () => {
  assert.equal(markedStreams('out', 'err'), 'out\n[stderr]\nerr')
  assert.equal(markedStreams('out\n', 'err'), 'out\n[stderr]\nerr')
  assert.equal(markedStreams('', 'err'), '[stderr]\nerr')
  assert.equal(markedStreams('out', ''), 'out')
  assert.equal(markedStreams('', ''), '')
})
