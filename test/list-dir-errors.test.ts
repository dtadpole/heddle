import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools, listingError } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A failed listing is classified and names the directory, as DSH's directory list does (`dsh-fs-local` listDirectory
 * and listingIoError): a missing target, or one reached through a file, is `FS_NOT_FOUND`, `cannot list "<path>": not
 * found`; a file is `FS_NOT_DIRECTORY`, `cannot list "<path>": not a directory`; a directory the OS refuses to open is
 * `FS_PERMISSION_DENIED`. The path is DSH's display spelling (`dsh-fs-local` localDisplayPath), as read_file's is.
 * Live-testing issue #223: this build returned Node's raw `ENOENT: … scandir` / `ENOTDIR` text as `TOOL_FAILED`, and a
 * dangling symbolic link anywhere in the folder failed the whole listing with a raw `ENOENT: … stat`.
 */

async function list(path: string | undefined, layout: (workspace: string) => void = () => {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-list-errors-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  layout(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    const args = path === undefined ? {} : { path }
    return { result: await registry.call('list_dir', args, { cwd: workspace, session: handle, log: () => {} }), workspace }
  } finally {
    // The permission case leaves a locked folder, which the removal could not open.
    try {
      chmodSync(join(workspace, 'locked'), 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('a missing directory is FS_NOT_FOUND and names it', async () => {
  const { result, workspace } = await list('missing')
  assert.deepEqual(result.error, { code: 'FS_NOT_FOUND', message: `cannot list "${workspace}/missing": not found` })
  assert.equal(result.output, '')
})

test('a path through a file is not found too, not a raw ENOTDIR', async () => {
  const { result, workspace } = await list('plain.txt/inner', (root) => writeFileSync(join(root, 'plain.txt'), 'preserved'))
  assert.deepEqual(result.error, { code: 'FS_NOT_FOUND', message: `cannot list "${workspace}/plain.txt/inner": not found` })
})

test('a file is FS_NOT_DIRECTORY and names it', async () => {
  const { result, workspace } = await list('./plain.txt', (root) => writeFileSync(join(root, 'plain.txt'), 'preserved'))
  assert.deepEqual(result.error, { code: 'FS_NOT_DIRECTORY', message: `cannot list "${workspace}/plain.txt": not a directory` })
})

test('a directory the OS will not open is FS_PERMISSION_DENIED and names it', { skip: process.getuid?.() === 0 ? 'root opens any directory' : false }, async () => {
  const { result, workspace } = await list('locked', (root) => {
    mkdirSync(join(root, 'locked'))
    writeFileSync(join(root, 'locked', 'inside.txt'), 'x')
    chmodSync(join(root, 'locked'), 0o000)
  })
  assert.deepEqual(result.error, { code: 'FS_PERMISSION_DENIED', message: `cannot list "${workspace}/locked": permission denied` })
})

test('a dangling symbolic link is listed by name, as the Rust build lists it, and does not fail the listing', async () => {
  const { result } = await list(undefined, (root) => {
    writeFileSync(join(root, 'plain.txt'), 'preserved')
    symlinkSync('nowhere', join(root, 'dangling'))
  })
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'dangling\nplain.txt (9B)')
})

test('a failed listing is classified by its platform error', () => {
  const failure = (code: string, message = code) => Object.assign(new Error(message), { code })
  assert.deepEqual(listingError('/work/x', failure('ENOENT')), { code: 'FS_NOT_FOUND', message: 'cannot list "/work/x": not found' })
  assert.equal(listingError('/work/x', failure('ENOTDIR')).code, 'FS_NOT_FOUND')
  assert.equal(listingError('/work/x', failure('EACCES')).code, 'FS_PERMISSION_DENIED')
  assert.equal(listingError('/work/x', failure('EPERM')).code, 'FS_PERMISSION_DENIED')
  assert.deepEqual(listingError('/work/x', failure('EIO', 'disk on fire')), { code: 'FS_IO_ERROR', message: 'cannot list "/work/x": disk on fire' })
})

test('a listable directory still lists as before', async () => {
  const { result } = await list('.', (root) => {
    writeFileSync(join(root, 'plain.txt'), 'preserved')
    mkdirSync(join(root, 'sub'))
  })
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'plain.txt (9B)\nsub/')
})
