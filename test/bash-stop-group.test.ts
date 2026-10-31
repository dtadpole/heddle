import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { killProcessGroup } from '../src/sandbox/process-group.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A Stop or a timeout ends the whole command, not only its shell (live-testing draft developer-five-5).
 *
 * The command starts a background `sleep`, writes its pid, and waits: the shape of `sleep 37; echo late`, with the
 * child's pid in hand to look for afterwards. Before the fix the shell alone was killed, the `sleep` ran on with
 * init as its parent, and the call did not settle until it exited, because it still held the output pipes.
 */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (alive(pid) && Date.now() < deadline) await settle(20)
  return !alive(pid)
}

async function runBackgroundSleep(how: { readonly stopAfterStart?: boolean; readonly timeoutMs?: number }) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-stop-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const pidFile = join(scratch, 'child.pid')
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  const controller = new AbortController()
  const args: Record<string, unknown> = { command: `sleep 41 & echo $! > ${JSON.stringify(pidFile)}; wait` }
  if (how.timeoutMs !== undefined) args.timeoutMs = how.timeoutMs
  try {
    const call = registry.call('bash', args, { cwd: workspace, session: handle, signal: controller.signal, log: () => {} })
    const startBy = Date.now() + 5_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < startBy) await settle(20)
    const child = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(alive(child), 'the background command runs before the stop')
    const from = Date.now()
    if (how.stopAfterStart === true) controller.abort()
    const result = await call
    return { result, child, settledInMs: Date.now() - from }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('killProcessGroup refuses the pids that would reach every process, and counts a gone group as stopped', () => {
  assert.equal(killProcessGroup(undefined), false)
  assert.equal(killProcessGroup(0), false)
  assert.equal(killProcessGroup(1), false)
  assert.equal(killProcessGroup(-5), false)
  assert.equal(killProcessGroup(2 ** 22 + 12_345), true, 'no such group: already stopped')
})

test('Stop ends the shell and the command it started, at once, and the call says it was stopped', { timeout: 10_000 }, async () => {
  const { result, child, settledInMs } = await runBackgroundSleep({ stopAfterStart: true })
  assert.equal(result.error?.code, 'INTERRUPTED', JSON.stringify(result.error))
  assert.equal(result.error?.message, 'the command was stopped before it finished')
  assert.ok(settledInMs < 2_000, `the call settled ${settledInMs} ms after the Stop`)
  assert.ok(await gone(child, 3_000), 'the background sleep is gone too')
})

test('the wall time ends the shell and the command it started, and the call says it timed out', { timeout: 10_000 }, async () => {
  const { result, child } = await runBackgroundSleep({ timeoutMs: 600 })
  assert.equal(result.error?.code, 'TIMEOUT', JSON.stringify(result.error))
  assert.ok(await gone(child, 3_000), 'the background sleep is gone too')
})
