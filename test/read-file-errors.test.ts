import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools, displayPath } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A failed read is classified and names the file, as DSH's read tool does (`dsh-tool-fs` resolveRegularReadTarget):
 * `FS_NOT_FOUND` / `FS_NOT_REGULAR_FILE`, `cannot read "<path>": …`, with DSH's display spelling of the path
 * (`dsh-fs-local` localDisplayPath). Live-testing issue #4: this build returned Node's raw `ENOENT` text and the Rust
 * build the raw OS error with no path, both as `TOOL_FAILED`.
 */

test("displayPath is DSH's spelling: absolute and normalised, unless it walks '..'", () => {
  assert.equal(displayPath('/work', 'notes/missing.txt'), '/work/notes/missing.txt')
  assert.equal(displayPath('/work', './notes//missing.txt'), '/work/notes/missing.txt')
  assert.equal(displayPath('/work', '/elsewhere/./x.txt'), '/elsewhere/x.txt')
  assert.equal(displayPath('/work', '../outside/x.txt'), '/work/../outside/x.txt', 'a walk up is kept as written')
})

async function read(path: string, layout: (workspace: string) => void = () => {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-read-errors-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  layout(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return { result: await registry.call('read_file', { path }, { cwd: workspace, session: handle, log: () => {} }), workspace }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a missing file is FS_NOT_FOUND and names the file', async () => {
  const { result, workspace } = await read('notes/missing.txt')
  assert.deepEqual(result.error, { code: 'FS_NOT_FOUND', message: `cannot read "${workspace}/notes/missing.txt": not found` })
})

test('a path through a file is not found too, not a raw ENOTDIR', async () => {
  const { result, workspace } = await read('plain.txt/inner', (root) => writeFileSync(join(root, 'plain.txt'), 'x'))
  assert.deepEqual(result.error, { code: 'FS_NOT_FOUND', message: `cannot read "${workspace}/plain.txt/inner": not found` })
})

test('a directory is FS_NOT_REGULAR_FILE and names it', async () => {
  const { result, workspace } = await read('notes', (root) => mkdirSync(join(root, 'notes')))
  assert.deepEqual(result.error, { code: 'FS_NOT_REGULAR_FILE', message: `cannot read "${workspace}/notes": not a regular file` })
})

test('a readable file still reads as before', async () => {
  const { result } = await read('notes/here.txt', (root) => {
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'notes', 'here.txt'), 'hello')
  })
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'hello')
})
