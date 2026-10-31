import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService } from '../src/session/service.ts'
import { tree, type TreeInput } from '../src/session/tree.ts'

/**
 * A folder heddle cannot read, and a branch heddle cannot write (issue #106).
 *
 * DSH's file tree tells an empty level from a failed one (dsh-client-ui-sidebar-files lib/client.js:483-489): a listing
 * that failed is a failure with a code, and its file backend says `cannot list "<path>": permission denied` for a folder
 * it may not read (dsh-fs-local lib/index.js:269). The tree here caught every read error and answered `[]`, which the page
 * drew as "nothing inside". Creating a session writes its definition into the branch, and a branch heddle cannot write
 * failed with Node's raw `EACCES … mkdir '<absolute path>'`, after the store had already recorded the session.
 *
 * File modes do not stop the superuser, so these checks are skipped when run as root.
 */

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-unreadable-')))
const restore: string[] = []
after(() => {
  for (const dir of restore) {
    try {
      chmodSync(dir, 0o755)
    } catch {
      // already gone
    }
  }
  rmSync(scratch, { recursive: true, force: true })
})

let counter = 0
function workspace(): string {
  counter += 1
  const root = join(scratch, `work-${counter}`)
  mkdirSync(join(root, 'locked'), { recursive: true })
  writeFileSync(join(root, 'locked', 'held.txt'), 'a file the tree cannot list\n')
  mkdirSync(join(root, 'empty'), { recursive: true })
  return root
}

function lock(dir: string): void {
  restore.push(dir)
  chmodSync(dir, 0o000)
}

function input(root: string, title = 'work'): TreeInput {
  return { roots: [{ path: root, title }], sessions: [] }
}

test('an unreadable folder is a failure with a code and DSH\'s sentence, not an empty list', { skip: asRoot && 'file modes do not apply to root' }, () => {
  const root = workspace()
  lock(join(root, 'locked'))
  assert.throws(
    () => tree(join(root, 'locked'), input(root)),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'workspace-file/unreadable')
      assert.equal((error as Error).message, 'cannot list "locked": permission denied', 'the folder is named relative to its workspace')
      return true
    },
  )
  assert.deepEqual(tree(join(root, 'empty'), input(root)).children, [], 'an empty folder is still asked and empty')
  const parent = tree(root, input(root))
  assert.ok(parent.children?.some((node) => node.label === 'locked'), 'and the readable folder above still names it')
})

test('an unreadable workspace root is a failure naming the root by its title, and the roots listing leaves its children unlisted', { skip: asRoot && 'file modes do not apply to root' }, () => {
  const root = workspace()
  const other = workspace()
  lock(root)
  const roots: TreeInput = { roots: [{ path: root, title: 'locked-work' }, { path: other, title: 'open-work' }], sessions: [] }
  assert.throws(
    () => tree(root, roots),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'workspace-file/unreadable')
      assert.equal((error as Error).message, 'cannot list "locked-work": permission denied')
      return true
    },
  )
  const listing = tree(null, roots)
  const locked = listing.children?.find((node) => node.path === root)
  const open = listing.children?.find((node) => node.path === other)
  assert.equal(locked?.children, null, 'not asked-and-empty: the listing could not ask')
  assert.ok(Array.isArray(open?.children) && open.children.length > 0, 'while a readable root beside it lists as before')
})

test('a session in a branch heddle cannot write is refused by code, names the folder without its path, and records nothing', { skip: asRoot && 'file modes do not apply to root' }, () => {
  const root = workspace()
  const sessions = new SessionService(new Context(), { root: join(scratch, `sessions-${counter}`) })
  lock(root)
  assert.throws(
    () => sessions.createAt(root),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'session/unwritable')
      assert.equal((error as Error).message, `cannot write to "${basename(root)}": permission denied`)
      assert.ok(!(error as Error).message.includes(scratch), 'no absolute path in the sentence')
      return true
    },
  )
  assert.deepEqual(
    sessions.list().filter((meta) => meta.cwd === root),
    [],
    'the store holds no session for the refused branch',
  )
  chmodSync(root, 0o755)
  const created = sessions.createAt(root)
  assert.equal(created.definition.dir.startsWith(join(root, '_sessions_')), true, 'and once writable, the same branch takes a session')
})
