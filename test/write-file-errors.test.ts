import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * A write aimed at something that is not a regular file is refused and names it, as DSH's text write does
 * (`dsh-fs-local` writeText probes the target first): an existing folder is `FS_NOT_REGULAR_FILE`, `cannot write
 * "<path>": not a regular file`, with DSH's display spelling of the path, and the folder is left as it was.
 * Live-testing issue #237: this build returned Node's raw `EISDIR: … open` text as `TOOL_FAILED`.
 */

async function write(path: string, content: string, inspect: (workspace: string) => unknown = () => undefined) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-write-errors-')))
  const workspace = join(scratch, 'workspace')
  mkdirSync(join(workspace, 'folder'), { recursive: true })
  writeFileSync(join(workspace, 'folder', 'plain.txt'), 'preserved')
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    const result = await registry.call('write_file', { path, content }, { cwd: workspace, session: handle, log: () => {} })
    return { result, workspace, disk: inspect(workspace) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a write aimed at a folder is FS_NOT_REGULAR_FILE, names it, and leaves the folder as it was', async () => {
  const { result, workspace, disk } = await write('./folder', 'ordinary text', (root) => ({
    folder: statSync(join(root, 'folder')).isDirectory(),
    child: readFileSync(join(root, 'folder', 'plain.txt'), 'utf8'),
  }))
  assert.deepEqual(result.error, { code: 'FS_NOT_REGULAR_FILE', message: `cannot write "${workspace}/folder": not a regular file` })
  assert.equal(result.output, '')
  assert.deepEqual(disk, { folder: true, child: 'preserved' })
})

test('a write over an existing file and to a new one still writes as before', async () => {
  const over = await write('folder/plain.txt', 'recovered', (root) => readFileSync(join(root, 'folder', 'plain.txt'), 'utf8'))
  assert.equal(over.result.error, undefined)
  assert.equal(over.result.output, 'wrote 9 bytes to folder/plain.txt')
  assert.equal(over.disk, 'recovered')
  const fresh = await write('deeper/new.txt', 'x', (root) => readFileSync(join(root, 'deeper', 'new.txt'), 'utf8'))
  assert.equal(fresh.result.output, 'wrote 1 bytes to deeper/new.txt')
  assert.equal(fresh.disk, 'x')
})
