import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { BASH_MAX_TIMEOUT_MS, bashWallTime, builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A bash call's own `timeoutMs` follows DSH's rule (`dsh-tool-bash` validateBashArgs, `dsh-timeout` clampTimeout):
 * absent takes the default, a value that is not a finite positive number is refused, a larger one is cut to the cap
 * (`bashMaxTimeoutMs`, DSH's `maxTimeoutMs`). Live-testing issue #13: `0`, `-5` and `3000000000` went straight into
 * `setTimeout`, which fires those after a millisecond, so the command was killed before it ran.
 */

test('the wall-time rule: default when absent, refused when not a finite positive number, cut to the cap', () => {
  assert.deepEqual(bashWallTime(undefined, 30_000, 600_000), { ms: 30_000 })
  assert.deepEqual(bashWallTime(null, 30_000, 600_000), { ms: 30_000 })
  for (const [value, shown] of [[0, '0'], [-5, '-5'], [Number.NaN, 'null'], ['5000', '"5000"'], [true, 'true']] as const) {
    assert.deepEqual(bashWallTime(value, 30_000, 600_000), { refusal: `invalid timeoutMs: expected a positive number, got ${shown}` }, String(value))
  }
  assert.deepEqual(bashWallTime(Number.POSITIVE_INFINITY, 30_000, 600_000), { refusal: 'invalid timeoutMs: expected a positive number, got null' })
  assert.deepEqual(bashWallTime(3_000_000_000, 30_000, 600_000), { ms: 600_000 }, 'cut to the cap')
  assert.deepEqual(bashWallTime(1500.4, 30_000, 600_000), { ms: 1500 }, 'a fractional millisecond rounds')
  assert.deepEqual(bashWallTime(0.2, 30_000, 600_000), { ms: 1 }, 'a tiny positive value is still a timer, never zero')
  assert.deepEqual(bashWallTime(undefined, 900_000, 600_000), { ms: 600_000 }, 'a default above the cap is cut too')
  assert.equal(BASH_MAX_TIMEOUT_MS, 600_000, "DSH's ten minutes")
})

async function bash(args: Record<string, unknown>, options: { readonly bashMaxTimeoutMs?: number } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-timeout-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const marker = join(scratch, 'ran.marker')
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  const tools = builtinTools(sandbox, options)
  for (const tool of tools) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    const command = String(args.command ?? 'touch {marker}; echo ok').replace('{marker}', JSON.stringify(marker))
    const result = await registry.call('bash', { ...args, command }, { cwd: workspace, session: handle, log: () => {} })
    const description = JSON.stringify(tools.find((tool) => tool.spec.name === 'bash')?.spec)
    return { result, ran: existsSync(marker), description }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('timeoutMs 0 is refused and the command does not run', async () => {
  const { result, ran } = await bash({ timeoutMs: 0 })
  assert.deepEqual(result.error, { code: 'BAD_ARGS', message: 'invalid timeoutMs: expected a positive number, got 0' })
  assert.equal(ran, false)
})

test('an over-large timeoutMs runs the command instead of killing it at once', async () => {
  const { result, ran } = await bash({ timeoutMs: 3_000_000_000, command: 'sleep 0.2; touch {marker}; echo ok' })
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.equal(result.output, 'ok\n')
  assert.equal(ran, true)
})

test('bashMaxTimeoutMs caps what a call may ask for, and the schema says so', async () => {
  const { result, ran, description } = await bash({ timeoutMs: 5_000, command: 'sleep 3; touch {marker}; echo late' }, { bashMaxTimeoutMs: 300 })
  assert.deepEqual(result.error, { code: 'TIMEOUT', message: 'the command exceeded 300ms and was killed' })
  assert.equal(ran, false)
  assert.match(description, /default 30000, at most 300\./)
})
