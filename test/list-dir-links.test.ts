import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
 * A symbolic link in a listing is shown as what it points at, as DSH's directory list does (`dsh-fs-local`
 * listDirectory probes each child with `stat`, which follows the link) and as the Rust build's list_dir does: a link to
 * a folder is a folder, `link/`, and a link to a file is a file of the target's size. This build took the folder test
 * from the directory entry, which does not follow the link, so a link to a folder came out as a file with the folder's
 * size (`link (96B)` on macOS). Issue #230.
 */

async function listWorkspace(layout: (workspace: string) => void) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-list-links-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(join(workspace, 'real'), { recursive: true })
  writeFileSync(join(workspace, 'real', 'inside.txt'), 'x')
  writeFileSync(join(workspace, 'plain.txt'), 'preserved')
  layout(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return await registry.call('list_dir', {}, { cwd: workspace, session: handle, log: () => {} })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a symbolic link to a folder is listed as a folder', async () => {
  const result = await listWorkspace((root) => symlinkSync('real', join(root, 'link')))
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'link/\nplain.txt (9B)\nreal/')
})

test('a symbolic link to a file is listed as a file of the target size', async () => {
  const result = await listWorkspace((root) => symlinkSync('plain.txt', join(root, 'alias')))
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'alias (9B)\nplain.txt (9B)\nreal/')
})
