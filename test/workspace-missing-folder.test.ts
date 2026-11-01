import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { canonicalPath, canonicalPathThroughAncestors } from '../src/paths.ts'
import { WorkspaceService } from '../src/workspace/service.ts'

/**
 * A workspace whose folder was deleted or moved (GitHub issue #141).
 *
 * DSH keeps such a workspace and lets a person remove it: the registry deletes and renames by id (`workspace.delete`,
 * dsh-workspace lib/index.js:461-471; the browser's dialogs call `deleteWorkspace(workspaceId)` and
 * `renameWorkspace(workspaceId, title)`, dsh-client-ui-workspace lib/client.js:3784, :3818, :5192-5197), its
 * `status()` says `missing-dir` without touching the record (lib/index.js:154-160, types.d.ts:131-136), and its file
 * tree says the folder is gone rather than empty or out of bounds (dsh-client-ui-sidebar-files lib/client.js:483-489,
 * words at :770). Here a path whose folder is gone could no longer be matched once it was spelled through a link
 * (`/tmp/x/w` for a record at `/private/tmp/x/w`): the lexical fallback of `canonicalPath` keeps the link, so the
 * routes answered "no workspace" and the tree "not under any workspace root".
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-missing-folder-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A fresh place with a real folder and a link to it — `/tmp` and `/private/tmp` in miniature. */
function place(): { real: string; alias: string; workspaces: WorkspaceService } {
  counter += 1
  const base = join(scratch, `place-${counter}`)
  const real = join(base, 'real')
  const alias = join(base, 'alias')
  mkdirSync(real, { recursive: true })
  symlinkSync(real, alias)
  return { real: realpathSync(real), alias, workspaces: new WorkspaceService(new Context(), { file: join(base, 'workspaces.json') }) }
}

test('a folder that is gone is spelled through the real path of its deepest existing ancestor', () => {
  const { real, alias } = place()
  mkdirSync(join(real, 'here'))
  assert.equal(canonicalPathThroughAncestors(join(alias, 'here')), join(real, 'here'), 'an existing folder is its real path, as canonicalPath gives it')
  assert.equal(canonicalPathThroughAncestors(join(alias, 'gone', 'deeper')), join(real, 'gone', 'deeper'), 'a missing tail is kept under the real path of what exists')
  assert.equal(canonicalPathThroughAncestors(`${join(alias, 'gone')}/../gone/`), join(real, 'gone'), 'dots and a trailing separator are resolved first')
  assert.equal(canonicalPath(join(alias, 'gone')), join(alias, 'gone'), 'canonicalPath itself keeps its lexical fallback (test/paths.test.ts pins it)')
})

test('a workspace whose folder is gone is still found, renamed and removed by its id, its stored path and a spelling through a link', () => {
  const { real, alias, workspaces } = place()
  mkdirSync(join(real, 'w'))
  const record = workspaces.add(join(alias, 'w')).record
  assert.equal(record.path, join(real, 'w'), 'the record stores the canonical path')
  rmSync(join(real, 'w'), { recursive: true })

  assert.equal(workspaces.find(record.id)?.id, record.id, 'by id')
  assert.equal(workspaces.find(record.path)?.id, record.id, 'by the stored path')
  assert.equal(workspaces.find(join(alias, 'w'))?.id, record.id, 'and by the path a person typed, through the link, though the folder is gone')
  assert.equal(workspaces.find(join(alias, 'not-registered')), undefined, 'a folder that is gone and was never registered is still no workspace')

  assert.equal(workspaces.rename(join(alias, 'w'), 'Gone')?.title, 'Gone', 'it is renamed by that spelling')
  const removal = workspaces.remove(join(alias, 'w'), { all: [], force: true })
  assert.equal(removal.removed.id, record.id, 'and removed by it')
  assert.deepEqual(workspaces.list(), [], 'and is no longer listed')
})

test("the workspace list marks a folder that is gone as missing-dir, DSH's Workspace.status(), and leaves the record as it was", () => {
  const { real, workspaces } = place()
  for (const name of ['kept', 'deleted', 'moved', 'replaced']) mkdirSync(join(real, name))
  const add = (name: string): string => workspaces.add(join(real, name)).record.id
  const ids = { kept: add('kept'), deleted: add('deleted'), moved: add('moved'), replaced: add('replaced') }
  rmSync(join(real, 'deleted'), { recursive: true })
  renameSync(join(real, 'moved'), join(real, '..', 'moved-away'))
  rmSync(join(real, 'replaced'), { recursive: true })
  writeFileSync(join(real, 'replaced'), 'a file where the folder was\n')
  const before = readFileSync(workspaces.file, 'utf8')

  const status = Object.fromEntries(workspaces.views([]).map((view) => [view.id, view.status]))
  assert.equal(status[ids.kept], 'ok', 'a folder that is there is ok')
  assert.equal(status[ids.deleted], 'missing-dir', 'a deleted one is missing-dir')
  assert.equal(status[ids.moved], 'missing-dir', 'so is a moved one')
  assert.equal(status[ids.replaced], 'missing-dir', 'and a path that is no longer a folder, as DSH stats it')
  assert.equal(readFileSync(workspaces.file, 'utf8'), before, 'reading the status writes nothing: the folder may only be away for a while')
})

test("the tree route's question: a folder that is gone under a root is missing there, and one behind a link out of every root is outside", () => {
  const { real, alias, workspaces } = place()
  mkdirSync(join(real, 'w', 'inner'), { recursive: true })
  const outside = join(real, '..', 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(real, 'w', 'way-out'))
  const record = workspaces.add(join(real, 'w')).record

  assert.equal(workspaces.missingFolder(join(real, 'w', 'inner')), undefined, 'an existing folder is not missing')
  assert.equal(workspaces.missingFolder(join(alias, 'w')), undefined, 'nor is one spelled through a link')
  const inner = workspaces.missingFolder(join(alias, 'w', 'never-made'))
  assert.deepEqual(inner && { path: inner.path, owner: inner.owner?.id }, { path: join(real, 'w', 'never-made'), owner: record.id }, 'a folder that is gone under the root is missing, at its canonical path, owned by the root')
  const out = workspaces.missingFolder(join(real, 'w', 'way-out', 'never-made'))
  assert.deepEqual(out && { path: out.path, owner: out.owner }, { path: join(realpathSync(outside), 'never-made'), owner: undefined }, 'one behind a link out of the root is judged where the link lands: outside')

  rmSync(join(real, 'w'), { recursive: true })
  const root = workspaces.missingFolder(join(alias, 'w'))
  assert.deepEqual(root && { path: root.path, owner: root.owner?.id }, { path: join(real, 'w'), owner: record.id }, "the root's own folder, gone, is missing and still the root's")
})

/** The page's half: the workspace dialogs ask by id, and a workspace group whose folder is gone says so in DSH's words. */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const block = (name: string): string => {
  const begin = page.indexOf(`/* ${name}:begin */`)
  const end = page.indexOf(`/* ${name}:end */`)
  assert.ok(begin !== -1 && end > begin, `page.html carries the ${name} block`)
  return page.slice(begin, end)
}

interface WorkspaceFolderBlock {
  NOT_FOUND: string
  GONE_LINE: string
  gone: (group: unknown) => boolean
  levelFailure: (body: unknown) => { code: string; line: string } | null
  routeKey: (node: { path: string; group?: { workspace?: { id?: string } | null } }, workspaces: { id: string; path: string }[]) => string
}

test("a workspace group whose folder is gone is told by the list's status, and its line is DSH's not-found sentence", () => {
  const folder = new Function(`${block('workspace-folder')}\nreturn WorkspaceFolder`)() as WorkspaceFolderBlock
  assert.equal(folder.NOT_FOUND, 'workspace-file/not-found', "DSH's code for a directory that is not there")
  assert.equal(folder.GONE_LINE, 'That directory is gone. It may have been moved or deleted.', "and DSH's words for it (dsh-client-ui-sidebar-files lib/client.js:770)")
  assert.equal(folder.gone({ workspace: { id: 'w', status: 'missing-dir' } }), true)
  assert.equal(folder.gone({ workspace: { id: 'w', status: 'ok' } }), false)
  assert.equal(folder.gone({ workspace: { id: 'w' } }), false, 'a server that does not say is not read as gone')
  assert.equal(folder.gone({ workspace: null }), false, 'Ungrouped has no folder')
  assert.equal(folder.gone(undefined), false)
})

test('Rename and Delete workspace name the workspace by its id, as DSH does, whatever became of its folder', () => {
  const folder = new Function(`${block('workspace-folder')}\nreturn WorkspaceFolder`)() as WorkspaceFolderBlock
  const workspaces = [
    { id: 'w-1', path: '/work/one' },
    { id: 'w-2', path: '/work/two' },
  ]
  assert.equal(folder.routeKey({ path: '/work/two' }, workspaces), 'w-2', 'the id the server lists for the row')
  assert.equal(folder.routeKey({ path: '/work/gone', group: { workspace: { id: 'w-9' } } }, workspaces), 'w-9', 'the drawn row\'s own id when the list no longer has it (another client removed it, #49)')
  assert.equal(folder.routeKey({ path: '/work/older' }, []), '/work/older', 'and the path only when nothing names an id')
})

/**
 * developer-ten's N1 on stack-4: the tree route answers `404 {code: 'workspace-file/not-found'}` for a folder that is gone
 * under a root, and the page did not know the code when the folder went **after** the page read it — a folder deleted
 * after its level was drawn, or a workspace's folder gone after `/api/workspaces` was read. Those said "could not read X:
 * the tree answered 404" in the tree's note, over "nothing inside". DSH draws one failed line under the directory in its
 * own words for that code (`failureLine`, dsh-client-ui-sidebar-files lib/client.js:483-489, words at :770).
 */
class FakeNode {
  tagName: string
  className = ''
  textContent = ''
  isConnected = true
  children: FakeNode[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly properties = new Map<string, string>()
  readonly style = {
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    getPropertyValue: (name: string) => this.properties.get(name) ?? '',
  }

  constructor(tagName: string) {
    this.tagName = tagName
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }
}

/** A top-level function of the page, from its `function` line to the first line that is a lone `}`; `''` when absent. */
const pageFunction = (name: string): string => {
  const start = page.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  if (start < 0) return ''
  return page.slice(start + 1, page.indexOf('\n}', start + 1) + 2)
}

/** `loadChildren` with the tree's drawing stood in for, against a tree route that answers `reply`. */
function childrenPage(reply: { status: number; body: unknown }) {
  const notes: string[] = []
  const requests: string[] = []
  const env = {
    document: { createElement: (tag: string) => new FakeNode(tag) },
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body }
    },
    setNote: (text: string) => notes.push(text),
  }
  const load = new Function(
    'env',
    `const { document, fetch, setNote } = env
    ${block('workspace-folder')}
    const archiveQuery = () => ''
    const markSelection = () => undefined
    const paintSessionRows = () => undefined
    const reopenChildGroups = async () => undefined
    const groupRow = () => document.createElement('li')
    const folderRows = (children) => children
    const nodeRow = (child) => Object.assign(document.createElement('li'), { textContent: child.label })
    ${pageFunction('paintGoneFolder')}
    ${pageFunction('failedLevel')}
    ${pageFunction('failedLevelLine')}
    ${pageFunction('loadChildren')}
    return loadChildren`,
  )(env) as (node: unknown, li: FakeNode) => Promise<void>
  return { load, notes, requests }
}

const goneAnswer = { status: 404, body: { error: 'no entry at "/work/w/gone"', code: 'workspace-file/not-found' } }
/** What a drawn level reads as: each child's text, and a failed line as `failed:<code>:<text>`. */
const shown = (group: FakeNode | undefined) =>
  (group?.children ?? []).map((child) => (child.dataset.filesRow === 'failed' ? `failed:${child.dataset.filesCode}:${child.textContent}` : child.textContent))

test("N1: a folder deleted after its level was drawn says DSH's gone line under it, not \"the tree answered 404\"", async () => {
  const { load, notes, requests } = childrenPage(goneAnswer)
  const li = new FakeNode('li')
  li.style.setProperty('--tree-depth', '2')
  await load({ kind: 'folder', path: '/work/w/gone', label: 'gone', children: null }, li)
  assert.equal(requests.length, 1, 'the folder was asked for')
  assert.deepEqual(shown(li.children[0]), ['failed:workspace-file/not-found:That directory is gone. It may have been moved or deleted.'], 'one failed line, in DSH\'s words, with the code')
  assert.deepEqual(notes, [], 'and no "could not read" note')
})

test("N1: a workspace whose folder went after the list was read says DSH's gone line under its Files heading", async () => {
  const { load, notes } = childrenPage(goneAnswer)
  const li = new FakeNode('li')
  li.style.setProperty('--tree-depth', '0')
  const group = { workspace: { id: 'w-1', status: 'ok' }, children: [], sessions: [] }
  await load({ kind: 'workspace', path: '/work/w', label: 'w', group }, li)
  assert.deepEqual(shown(li.children[0]), ['Files', 'failed:workspace-file/not-found:That directory is gone. It may have been moved or deleted.'], 'the shape a folder the list calls gone is drawn with')
  assert.deepEqual(notes, [])
})

test("a failed level is DSH's failureLine by code: gone, outside, not a directory, and any other code says Read failed with its message", () => {
  const folder = new Function(`${block('workspace-folder')}\nreturn WorkspaceFolder`)() as WorkspaceFolderBlock
  assert.deepEqual(folder.levelFailure({ error: 'no entry at "/w/gone"', code: 'workspace-file/not-found' }), {
    code: 'workspace-file/not-found',
    line: 'That directory is gone. It may have been moved or deleted.',
  }, 'dsh-client-ui-sidebar-files lib/client.js:770, the answer\'s own sentence not shown')
  assert.deepEqual(folder.levelFailure({ code: 'workspace-file/not-found' }), { code: 'workspace-file/not-found', line: folder.GONE_LINE }, 'with or without a message')
  assert.equal(folder.levelFailure({ code: 'workspace-file/outside-workspace', error: 'x' })?.line, 'That directory is outside the workspace, so the sidebar will not read it.', ':771')
  assert.equal(folder.levelFailure({ code: 'workspace-file/not-directory', error: 'x' })?.line, 'That is not a directory.', ':772')
  assert.deepEqual(folder.levelFailure({ error: 'cannot list "locked": permission denied', code: 'workspace-file/unreadable' }), {
    code: 'workspace-file/unreadable',
    line: 'Read failed: cannot list "locked": permission denied',
  }, "a code DSH's tree does not name is error.unavailable, :773 (#106)")
  assert.equal(folder.levelFailure({ code: 'workspace-file/unreadable' }), null, 'which needs the message it repeats')
  assert.equal(folder.levelFailure({ error: '/x is not under any workspace root' }), null, 'an answer with no code is the note\'s')
  assert.equal(folder.levelFailure(null), null)
  assert.equal(folder.levelFailure('not json'), null)
})

test('N1: any other failure still says what the tree answered', async () => {
  const { load, notes } = childrenPage({ status: 500, body: { error: 'internal' } })
  const li = new FakeNode('li')
  await load({ kind: 'folder', path: '/work/w/x', label: 'x', children: null }, li)
  assert.deepEqual(notes, ['could not read x: the tree answered 500'])
  const answered = childrenPage({ status: 200, body: { children: [{ kind: 'folder', path: '/work/w/x/y', label: 'y', children: null }] } })
  const opened = new FakeNode('li')
  await answered.load({ kind: 'folder', path: '/work/w/x', label: 'x', children: null }, opened)
  assert.deepEqual(shown(opened.children[0]), ['y'], 'and a folder that answers is drawn as before')
})
