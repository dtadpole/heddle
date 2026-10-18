import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isUnder } from '../src/paths.ts'
import { badgeFor, classify, kindOf, readFileText, tree, type TreeInput } from '../src/session/tree.ts'
import type { SessionMeta } from '../src/session/store.ts'

/**
 * The tree's primitives, pinned without a store, a CLI or a filesystem walk.
 *
 * The verifier judges the same rules from a user's seat, over the built CLI and a fixture that looks
 * like the conventions repository. These tests are the cheaper half: the badge rule, the
 * classification and the segment comparison are each one line of behaviour whose *edges* are what
 * bite, and an edge found here costs a second rather than a fixture.
 */

function scaffold(layout: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'heddle-tree-'))
  for (const path of layout) mkdirSync(join(root, path), { recursive: true })
  return root
}

function session(id: string, cwd: string, created: string, turns = 1): SessionMeta {
  return { id, cwd, created, turns }
}

test('a type badge drops the vowels, which is what keeps the three con types apart', () => {
  assert.equal(badgeFor('_verifiers_'), 'VRF')
  assert.equal(badgeFor('_tools_'), 'TLS')
  assert.equal(badgeFor('_context_'), 'CTX', 'the name this UI uses, which the vowels-dropped derivation does not give')
  assert.equal(badgeFor('_conventions_'), 'CNV')
  assert.equal(badgeFor('_constitutions_'), 'CNS')
  // Fewer than three consonants left: the full name supplies the rest rather than a short badge.
  assert.equal(badgeFor('_web_'), 'WEB')
  assert.equal(badgeFor('_data_'), 'DAT')
})

test('a folder is classified against its parent, not by its own name alone', () => {
  const none = new Set<string>()
  assert.equal(classify('_tools_', 'workspace', none), 'type')
  assert.equal(classify('_context_', 'workspace', none), 'type')
  assert.equal(classify('source-material', 'type', none), 'instance')
  // The same name is not an instance when nothing above it is a type.
  assert.equal(classify('source-material', 'workspace', none), 'folder')
  // Two to four words: one word is not an instance name, which is a real rule and not a detail.
  assert.equal(classify('material', 'type', none), 'folder')
  assert.equal(classify('shared', 'workspace', none), 'folder')
  assert.equal(classify('dist', 'workspace', new Set(['dist'])), 'generated')
})

test('containment is compared by path segment, never by string', () => {
  assert.equal(isUnder('/a/b', '/a/b'), true, 'a folder is under itself')
  assert.equal(isUnder('/a/b', '/a/b/c'), true)
  assert.equal(isUnder('/a/b', '/a/b-sibling'), false, 'the trap: every character matches, the segment does not')
  assert.equal(isUnder('/a/b', '/a'), false)
  assert.equal(isUnder('/', '/anything'), true)
})

test('the tree shows a session on an instance and on nothing else', () => {
  const root = scaffold([
    '_tools_/some-tool',
    '_tools_/some-tool/src/deep',
    'shared',
    '_monitors_',
  ])
  const input: TreeInput = {
    roots: [{ path: root, title: 'fixture' }],
    sessions: [
      session('s-root', root, '2026-10-11T10:00:00.000Z'),
      session('s-tool', join(root, '_tools_', 'some-tool'), '2026-10-11T10:01:00.000Z'),
      session('s-deep', join(root, '_tools_', 'some-tool', 'src', 'deep'), '2026-10-11T10:02:00.000Z'),
      session('s-shared', join(root, 'shared'), '2026-10-11T10:03:00.000Z'),
    ],
    generated: ['dist'],
  }
  try {
    const atRoot = tree(root, input)
    assert.equal(atRoot.kind, 'workspace')
    assert.equal(atRoot.session, null, 'the root is a boundary rather than an instance')

    const tools = (atRoot.children ?? []).find((node) => node.label === '_tools_')
    assert.equal(tools?.kind, 'type')
    assert.equal(tools?.session, null, 'a type folder is the boundary itself')
    assert.equal(tools?.children, null, 'and it was not expanded, which is not the same as empty')

    const instance = tree(join(root, '_tools_'), input).children?.find((node) => node.label === 'some-tool')
    assert.equal(instance?.kind, 'instance')
    assert.equal(instance?.session?.id, 's-tool', 'the instance carries the session that ran in it')

    const inside = tree(join(root, '_tools_', 'some-tool'), input)
    assert.equal(inside.children?.find((node) => node.label === 'src')?.session, null, 'a plain folder inside carries none')

    const shared = (atRoot.children ?? []).find((node) => node.label === 'shared')
    assert.equal(shared?.kind, 'folder')
    assert.equal(shared?.session, null, 'and a plain container carries none either')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the newest session bound to an instance is the one the instance shows', () => {
  const root = scaffold(['_tools_/some-tool'])
  const folder = join(root, '_tools_', 'some-tool')
  try {
    const input: TreeInput = {
      roots: [{ path: root, title: 'fixture' }],
      // Deliberately not in order: the newest is what the folder points at, whatever the list order.
      sessions: [
        session('s-old', folder, '2026-10-11T09:00:00.000Z'),
        session('s-new', folder, '2026-10-11T11:00:00.000Z'),
        session('s-middle', folder, '2026-10-11T10:00:00.000Z'),
      ],
    }
    const node = tree(join(root, '_tools_'), input).children?.find((child) => child.label === 'some-tool')
    assert.equal(node?.session?.id, 's-new')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a nested root is a workspace node inside its parent, and owns what is under it', () => {
  const root = scaffold(['inner/deep'])
  const inner = join(root, 'inner')
  try {
    const input: TreeInput = {
      roots: [
        { path: root, title: 'outer' },
        { path: inner, title: 'inner' },
      ],
      sessions: [session('s-deep', join(inner, 'deep'), '2026-10-11T10:00:00.000Z')],
    }
    const outer = tree(root, input)
    const nested = (outer.children ?? []).find((node) => node.label === 'inner')
    assert.equal(nested?.kind, 'workspace', 'a registered root is a workspace node rather than a folder')

    const roots = tree(null, input)
    assert.equal(roots.kind, 'roots')
    assert.deepEqual(
      (roots.children ?? []).map((node) => node.label),
      ['outer'],
      'the nested root is not also listed at the top level',
    )

    // The instance rule still applies under the nested root: `deep` is plain, so its session is stored
    // and accounted for but is not a node.
    const atInner = tree(inner, input)
    assert.equal(atInner.children?.find((node) => node.label === 'deep')?.session, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kindOf walks from the root, so a type may repeat at any depth', () => {
  const root = scaffold(['_projects_/a-project/_context_/source-material'])
  try {
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [] }
    assert.equal(kindOf(join(root, '_projects_'), input), 'type')
    assert.equal(kindOf(join(root, '_projects_', 'a-project'), input), 'instance')
    assert.equal(kindOf(join(root, '_projects_', 'a-project', '_context_'), input), 'type')
    assert.equal(kindOf(join(root, '_projects_', 'a-project', '_context_', 'source-material'), input), 'instance')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plumbing is not enumerated and a declared generated folder is named as one', () => {
  const root = scaffold(['node_modules/left-pad', '.git/objects', 'dist', '_logs_/repo-actions'])
  try {
    const input: TreeInput = {
      roots: [{ path: root, title: 'fixture' }],
      sessions: [],
      generated: ['dist'],
    }
    const labels = (tree(root, input).children ?? []).map((node) => node.label)
    assert.deepEqual(labels, ['_logs_', 'dist'], `plumbing is absent and the rest is name-sorted\nsaw: ${labels.join(', ')}`)
    const dist = (tree(root, input).children ?? []).find((node) => node.label === 'dist')
    assert.equal(dist?.kind, 'generated')
    assert.equal(dist?.badge, null, 'and it is not a type, so it has no badge')
    assert.equal(dist?.children, null, 'a child that was not expanded reports no children rather than an empty list')
    assert.deepEqual(tree(join(root, 'dist'), input).children, [], 'asked for, an empty folder reports an empty list')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('files are nodes after folders, a dot-entry is not, and an unreadable folder is empty rather than fatal', () => {
  const root = scaffold(['_tools_/some-tool'])
  try {
    writeFileSync(join(root, 'README.md'), '# read me\n')
    writeFileSync(join(root, '.hidden.md'), '# not shown\n')
    writeFileSync(join(root, '_tools_', 'INDEX.md'), '# the type\n')
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [] }

    /**
     * The owner's rule of 2026-10-11, reversing this test's first version: files are shown under a
     * folder, and a click opens one. Folders still come first, and a dot-entry is still not content.
     */
    const children = tree(root, input).children ?? []
    assert.deepEqual(
      children.map((node) => `${node.kind}:${node.label}`),
      ['type:_tools_', 'file:README.md'],
      'folders first, then files, and a dot-entry is not enumerated',
    )
    const file = children.find((node) => node.kind === 'file')
    assert.deepEqual(file?.children, [], 'a file is a leaf: asked and empty, not unasked')
    assert.equal(file?.bytes, 10, 'and it carries its size, so a row can say how big it is')

    assert.equal(kindOf(join(root, 'README.md'), input), 'file', 'a path that is not a directory is a file, whatever its name looks like')

    const missing = tree(join(root, 'not-there'), input)
    assert.deepEqual(missing.children, [], 'a folder that does not exist has nothing to show')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the reader hands back text, refuses what a viewer cannot show, and says when it truncated', () => {
  const root = scaffold([])
  try {
    writeFileSync(join(root, 'notes.md'), '# one\n# two\n')
    const reading = readFileText(join(root, 'notes.md'))
    assert.equal(reading.name, 'notes.md')
    assert.equal(reading.text, '# one\n# two\n')
    assert.equal(reading.lines, 2, 'a trailing newline does not count as a third line')
    assert.equal(reading.truncated, false)

    const clipped = readFileText(join(root, 'notes.md'), { limit: 4 })
    assert.equal(clipped.text, '# on')
    assert.equal(clipped.truncated, true, 'a file longer than the limit is truncated rather than refused')
    assert.equal(clipped.bytes, 12, 'and its real size is still reported')

    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    assert.throws(() => readFileText(join(root, 'blob.bin')), /binary/)
    assert.throws(() => readFileText(root), /not a file/, 'a directory is not a file')
    assert.throws(() => readFileText(join(root, 'not-there')), /not a file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a _sessions_ folder is not a node, and its sessions come first in the branch they belong to', () => {
  const root = scaffold([
    '_tools_/some-tool',
    '_tools_/some-tool/_sessions_/first-conversation',
    '_tools_/some-tool/_sessions_/second-conversation',
    '_tools_/some-tool/src',
    '_tools_/empty-tool/_sessions_',
  ])
  try {
    writeFileSync(join(root, '_tools_', 'some-tool', 'INDEX.md'), '# some-tool\n')
    writeFileSync(join(root, '_tools_', 'some-tool', '_sessions_', 'first-conversation', 'INDEX.md'), '# first\n')
    writeFileSync(join(root, '_tools_', 'some-tool', '_sessions_', 'second-conversation', 'INDEX.md'), '# second\n')
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [] }

    const instance = tree(join(root, '_tools_', 'some-tool'), input)
    assert.deepEqual(
      (instance.children ?? []).map((node) => `${node.kind}:${node.label}`),
      ['session:second-conversation', 'session:first-conversation', 'folder:src', 'file:INDEX.md'],
      'the sessions are hoisted above the branch’s own files and folders, newest name first',
    )
    assert.ok(
      !(instance.children ?? []).some((node) => node.label === '_sessions_'),
      'and the folder that holds them is not a node at all',
    )

    /**
     * A session is a leaf: its definition folder holds `INDEX.md` and `session.json`, and the tree shows
     * neither, because the panel shows the conversation rather than the filing.
     */
    const session = (instance.children ?? [])[0]!
    /**
     * The children are held in a local before they are asserted empty.
     */
    const sessionChildren = session.children ?? []
    /**
     * Emptiness is asserted by length rather than by `deepEqual` against `[]`: that form **narrows** the
     * asserted value to `never[]`, so the rows below became `never` and stopped having a `label` at all.
     * The claim is the same and the type error that said nothing about the tree is gone.
     */
    assert.equal(sessionChildren.length, 0, 'a session row is a leaf, not a folder to open')
    assert.ok(
      !sessionChildren.some((node) => node.label === 'INDEX.md' || node.label === 'session.json'),
      'and nothing from its definition folder is offered as a row',
    )

    const level = tree(join(root, '_tools_'), input)
    const levelChildren = level.children ?? []
    assert.ok(
      !levelChildren.some((node) => node.label === '_sessions_'),
      'nothing at the type level names it either',
    )

    // A sessions folder with no session leaves no trace, because there is nothing to show.
    const empty = tree(join(root, '_tools_', 'empty-tool'), input)
    assert.deepEqual((empty.children ?? []).map((node) => node.kind), [], 'an empty _sessions_ folder adds no row')

    assert.equal(kindOf(join(root, '_tools_', 'some-tool', '_sessions_', 'first-conversation'), input), 'session')
    assert.equal(kindOf(join(root, '_tools_', 'some-tool', '_sessions_'), input), 'type', 'asked for directly, it is still a type folder')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archived sessions are hidden by default, shown on request, and alone when only they are asked for', () => {
  const root = scaffold(['_tools_/some-tool/_sessions_/alpha', '_tools_/some-tool/_sessions_/beta', '_tools_/some-tool/_sessions_/gamma'])
  try {
    for (const [name, id, created] of [
      ['alpha', 'session-1', '2026-10-17T10:00:00.000Z'],
      ['beta', 'session-2', '2026-10-17T11:00:00.000Z'],
      ['gamma', 'session-3', '2026-10-17T12:00:00.000Z'],
    ] as const) {
      writeFileSync(
        join(root, '_tools_/some-tool/_sessions_', name, 'session.json'),
        JSON.stringify({ id, log: `/logs/${id}`, cwd: join(root, '_tools_/some-tool'), createdAt: created }),
      )
    }
    const sessions = [
      { ...session('session-1', join(root, '_tools_/some-tool'), '2026-10-17T10:00:00.000Z'), archived: true },
      session('session-2', join(root, '_tools_/some-tool'), '2026-10-17T11:00:00.000Z'),
      { ...session('session-3', join(root, '_tools_/some-tool'), '2026-10-17T12:00:00.000Z'), pinned: true },
    ]
    const at = (mode: 'hide' | 'show' | 'only'): string[] => {
      const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions, ...(mode === undefined ? {} : { archived: mode }) }
      const node = tree(join(root, '_tools_/some-tool'), input)
      return (node.children ?? []).filter((child) => child.kind === 'session').map((child) => child.label)
    }

    /**
     * The default is a promise: a row a person put away is not one they asked for. `show` is the way back, and
     * `only` is the state a person reaches for when a session has vanished — a two-state toggle cannot express it.
     */
    assert.deepEqual(at('hide'), ['gamma', 'beta'], 'the archived session is not drawn by default')
    assert.deepEqual(at('show'), ['gamma', 'beta', 'alpha'], 'and is drawn with its siblings when asked for: pinned first, then newest name first')
    assert.deepEqual(at('only'), ['alpha'], 'while "only" answers with nothing but the archived ones')

    const shown = (tree(join(root, '_tools_/some-tool'), { roots: [{ path: root, title: 'fixture' }], sessions, archived: 'show' }).children ?? [])
    assert.equal(shown.find((child) => child.label === 'alpha')?.archived, true, 'an archived row says so, so a list can dim it')
    assert.equal(shown.find((child) => child.label === 'gamma')?.pinned, true, 'and a pinned row says so')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pinned session sorts above newer ones, and the flags come from the store rather than the definition', () => {
  const root = scaffold(['_tools_/some-tool/_sessions_/older', '_tools_/some-tool/_sessions_/newer'])
  try {
    /** The definition carries no flags — and a hand-written one that does must not be believed. */
    writeFileSync(
      join(root, '_tools_/some-tool/_sessions_/older', 'session.json'),
      JSON.stringify({ id: 'session-older', log: '/logs/older', cwd: join(root, '_tools_/some-tool'), createdAt: '2026-10-17T09:00:00.000Z', archived: true }),
    )
    writeFileSync(
      join(root, '_tools_/some-tool/_sessions_/newer', 'session.json'),
      JSON.stringify({ id: 'session-newer', log: '/logs/newer', cwd: join(root, '_tools_/some-tool'), createdAt: '2026-10-17T10:00:00.000Z' }),
    )
    const meta = { ...session('session-older', join(root, '_tools_/some-tool'), '2026-10-17T09:00:00.000Z'), pinned: true }
    const input: TreeInput = { roots: [{ path: root, title: 'fixture' }], sessions: [meta, session('session-newer', join(root, '_tools_/some-tool'), '2026-10-17T10:00:00.000Z')] }

    const children = tree(join(root, '_tools_/some-tool'), input).children ?? []
    const labels = children.filter((child) => child.kind === 'session').map((child) => child.label)
    assert.deepEqual(labels, ['older', 'newer'], 'the pin outranks the clock')
    assert.equal(children.find((child) => child.label === 'older')?.pinned, true, 'and the row carries the pin')
    assert.equal(
      children.find((child) => child.label === 'older')?.archived,
      undefined,
      'while the stale flag in the definition is ignored: the store is the one place a flag lives',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pinned sessions order by when they were pinned, newest pin first', () => {
  const root = scaffold(['_tools_/some-tool/_sessions_/alpha', '_tools_/some-tool/_sessions_/beta', '_tools_/some-tool/_sessions_/gamma'])
  try {
    for (const [name, id, created] of [
      ['alpha', 'session-1', '2026-10-17T10:00:00.000Z'],
      ['beta', 'session-2', '2026-10-17T11:00:00.000Z'],
      ['gamma', 'session-3', '2026-10-17T12:00:00.000Z'],
    ] as const) {
      writeFileSync(
        join(root, '_tools_/some-tool/_sessions_', name, 'session.json'),
        JSON.stringify({ id, log: `/logs/${id}`, cwd: join(root, '_tools_/some-tool'), createdAt: created }),
      )
    }
    /**
     * All three are pinned, and the reference's pin is a **stack**: each new pin is prepended, so the order is the time
     * each was pinned, newest first — not the order of their names and not the order they were created.
     */
    const sessions = [
      { ...session('session-1', join(root, '_tools_/some-tool'), '2026-10-17T10:00:00.000Z'), pinned: true, pinnedAt: '2026-10-17T13:00:00.000Z' },
      { ...session('session-2', join(root, '_tools_/some-tool'), '2026-10-17T11:00:00.000Z'), pinned: true, pinnedAt: '2026-10-17T15:00:00.000Z' },
      { ...session('session-3', join(root, '_tools_/some-tool'), '2026-10-17T12:00:00.000Z'), pinned: true, pinnedAt: '2026-10-17T14:00:00.000Z' },
    ]
    const labels = (tree(join(root, '_tools_/some-tool'), { roots: [{ path: root, title: 'fixture' }], sessions }).children ?? [])
      .filter((child) => child.kind === 'session')
      .map((child) => child.label)
    assert.deepEqual(labels, ['beta', 'gamma', 'alpha'], 'the newest pin is first, not the newest session')

    /** A session pinned without a time (an older record) sorts after the timed ones rather than crashing the order. */
    const mixed = [
      { ...session('session-1', join(root, '_tools_/some-tool'), '2026-10-17T10:00:00.000Z'), pinned: true, pinnedAt: '2026-10-17T13:00:00.000Z' },
      { ...session('session-2', join(root, '_tools_/some-tool'), '2026-10-17T11:00:00.000Z'), pinned: true },
    ]
    const mixedLabels = (tree(join(root, '_tools_/some-tool'), { roots: [{ path: root, title: 'fixture' }], sessions: mixed }).children ?? [])
      .filter((child) => child.kind === 'session')
      .map((child) => child.label)
    /** gamma's definition has no store record, so it still draws — after the pinned rows, as any unpinned session does. */
    assert.deepEqual(mixedLabels, ['alpha', 'beta', 'gamma'], 'a pin without a time still sorts among the pinned rows')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessions inside one folder order by the time they were last written to, newest first', () => {
  const root = scaffold(['_tools_/some-tool/_sessions_/alpha', '_tools_/some-tool/_sessions_/beta', '_tools_/some-tool/_sessions_/gamma'])
  try {
    for (const [name, id, created] of [
      ['alpha', 'session-1', '2026-10-17T10:00:00.000Z'],
      ['beta', 'session-2', '2026-10-17T11:00:00.000Z'],
      ['gamma', 'session-3', '2026-10-17T12:00:00.000Z'],
    ] as const) {
      writeFileSync(
        join(root, '_tools_/some-tool/_sessions_', name, 'session.json'),
        JSON.stringify({ id, log: `/logs/${id}`, cwd: join(root, '_tools_/some-tool'), createdAt: created }),
      )
    }
    const labelsFor = (sessions: readonly { readonly id: string }[]) =>
      (tree(join(root, '_tools_/some-tool'), { roots: [{ path: root, title: 'fixture' }], sessions }).children ?? [])
        .filter((child) => child.kind === 'session')
        .map((child) => child.label)

    /**
     * The order is what a reader did **last**, not the clock in the folder name: gamma is the newest definition, but alpha was
     * written to most recently and leads. The owner reported this as "sessions are regularly sorted, but not by what I did".
     */
    const sessions = [
      { ...session('session-1', join(root, '_tools_/some-tool'), '2026-10-17T10:00:00.000Z'), updated: '2026-10-17T16:00:00.000Z' },
      { ...session('session-2', join(root, '_tools_/some-tool'), '2026-10-17T11:00:00.000Z'), updated: '2026-10-17T13:00:00.000Z' },
      { ...session('session-3', join(root, '_tools_/some-tool'), '2026-10-17T12:00:00.000Z'), updated: '2026-10-17T14:00:00.000Z' },
    ]
    assert.deepEqual(labelsFor(sessions), ['alpha', 'gamma', 'beta'], 'newest write first')

    /** A pinned session still leads the folder, whatever its write time, and pinned ones order by their pin. */
    const pinned = sessions.map((entry) => (entry.id === 'session-2' ? { ...entry, pinned: true, pinnedAt: '2026-10-17T15:00:00.000Z' } : entry))
    assert.deepEqual(labelsFor(pinned), ['beta', 'alpha', 'gamma'], 'a pin holds the top of its folder')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
