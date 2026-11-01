import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import type { SandboxMode } from '../src/sandbox/policy.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * What `write_file` tells the model it wrote (live-testing issue #3): the size in UTF-8 bytes, as the sentence says,
 * and the file relative to the workspace only when it is inside it. The TS build counted UTF-16 code units (five
 * Chinese characters read as 5 bytes) and named a file outside the workspace as a climb of `../`; the Rust build
 * already reported both correctly.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-write-report-')))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A registry whose sandbox runs in `mode`: the registry resolves each call's mode itself, never from the caller. */
function registry(label: string, mode: SandboxMode) {
  const workspace = join(scratch, `${label}-workspace`)
  mkdirSync(workspace, { recursive: true })
  const sandbox = new SandboxService(new Context(), { mode, workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, `${label}-sessions`) })
  const tools = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  return { tools, workspace, context: { cwd: workspace, session: sessions.start({ cwd: workspace }), log: () => {} } }
}

test('write_file reports UTF-8 bytes and names a file inside the workspace relative to it', async () => {
  const { tools, workspace, context } = registry('inside', 'workspace-write')
  const written = await tools.call('write_file', { path: 'zh.txt', content: '你好，世界' }, context)
  assert.equal(written.output, 'wrote 15 bytes to zh.txt', 'five characters are fifteen bytes of UTF-8')
  assert.equal((written.data as { bytes: number }).bytes, 15, 'and the data says the same')
  const dotted = await tools.call('write_file', { path: '..notes.txt', content: 'x' }, context)
  assert.equal(dotted.output, 'wrote 1 bytes to ..notes.txt', 'a file inside whose name starts with two dots is not a climb')
  assert.ok(!written.output.includes(workspace), 'the workspace itself is not spelled out')
})

test('write_file names a file outside the workspace absolutely, never as a climb of ../', async () => {
  const { tools, context } = registry('outside', 'danger-full-access')
  const elsewhere = join(scratch, 'elsewhere')
  mkdirSync(elsewhere, { recursive: true })
  const written = await tools.call('write_file', { path: join(elsewhere, 'x.txt'), content: 'x' }, context)
  assert.equal(written.output, `wrote 1 bytes to ${join(elsewhere, 'x.txt')}`)
  assert.ok(!written.output.includes('..'), 'no climb')
})
