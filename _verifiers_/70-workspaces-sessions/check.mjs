import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { decodeTranscript } from '../../src/session/transcript.ts'
import { fixtureDir, isolatedHome, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/check-helpers/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { isUnder } from '../../src/paths.ts'

/**
 * Verifier 7 — workspaces and sessions.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: **workspaces are folders with records, and sessions live
 * under a folder**, the way DSH does it.
 *
 * The part is judged from a user's seat rather than from the store's shape. A person who has run
 * two turns in two directories asks three questions: *where did my conversation go, which folder
 * does it belong to, and can I get back to it?* The checks answer those, and they read the
 * transcript on disk as well, because a listing that disagrees with the files is worse than no
 * listing.
 *
 * The association rule being judged is heddle's own, and it is the one the owner chose on 2026-10-11:
 * a session belongs to the workspace with the **longest root that is an ancestor of its working
 * directory**. Containment, not equality — so a session started in a subdirectory *is* a member of
 * the workspace above it, and the nearest registered root owns it when roots nest.
 *
 * The rest of the part is the navigation that rule makes possible, and it is stated in
 * [`../../SESSION_TREE.md`](../../SESSION_TREE.md): one folder holds one session, the folder's name is
 * the session's name, and the tree classifies each folder by the conventions repository's own rules
 * (`_type_` folders, kebab-case instances, plain containers). Those checks judge the **derivation**,
 * one level at a time, rather than a rendered page, because that is where the mechanism lives.
 *
 * Measured: three of the checks here changed when the owner reversed the equality rule — the
 * subdirectory check that asserted the old rule, and the "found again" check that assumed two runs in
 * one folder make two sessions. Both now assert the new model and say so, rather than being bent to
 * keep passing.
 */

const CAPABILITY = 'workspaces as folders with records, and sessions grouped under them'

/**
 * The second capability: the folder-bound session tree.
 *
 * Every check below this line judges a mechanism that does not exist yet, and each one reports
 * **unjudged** (`3`) rather than failing until it does — which is the honest verdict for a claim whose
 * subject is unbuilt, and the reason the part's own verdict moves to `3` rather than `0` the moment
 * these checks land. The marker is the `tree` command in the CLI's own help: the command cannot exist
 * without the derivation behind it, and if it exists but is wrong the checks run and report a failure,
 * which is the distinction that matters.
 */
const TREE_CAPABILITY = 'the folder-bound session tree, judged one level at a time'

async function supportsFolderTree() {
  const help = await runCli(['--help'])
  /**
   * The probe is the **command line** in the help, not the word.
   *
   * Measured: `/tree/` matched the help's own prose — "prints the loaded plugin tree" — so every check
   * below ran against a build with no `tree` command and reported thirteen failures, which is the one
   * verdict that must not be given for "this is not built".
   */
  return /^\s{2}tree\b/m.test(help.stdout)
}

function harness(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(`session-work-${label}`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'a remembered answer' }] })
  return {
    home,
    work,
    config,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    /**
     * The project's own profile is named explicitly, and the session store is pointed at the fixture.
     *
     * Measured: a command run with `cwd` set to a fixture directory booted an empty tree, because the
     * profile is found beside the run — so the fixture passed `--config` with the repository's profile
     * rather than relying on the working directory to supply one. `--session-root` is the supported
     * way to keep the owner's store out of it.
     */
    args: ['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions')],
  }
}

async function supportsCommands() {
  const help = await runCli(['--help'])
  return /workspaces/.test(help.stdout) && /sessions/.test(help.stdout)
}

/** The commands a check uses when it does not want the fixture's own profile to be found by cwd. */
function adminArgs(h, extra) {
  return ['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), ...extra]
}

/** Write a file, creating its directory, because a fixture tree is all directories and one file. */
function entry(path, text = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A fixture shaped like the conventions repository, because that is what the tree has to classify.
 *
 * Every content folder carries its `INDEX.md` (the convention's one hard rule), a type folder holds
 * only its index and its instances, `_formatters_` is left empty on purpose — an empty type folder is
 * valid in the conventions and must render as such — and the two folders that must **not** appear are
 * a plumbing directory and a generated one.
 *
 * It **registers its own root** as well, because a tree is a view of the folders a person registered:
 * asking for the tree of an unregistered directory is refused on purpose, and a fixture that skipped
 * the registration would be judging the refusal rather than the classification.
 */
async function conventionsFixture(h) {
  const work = h.work
  entry(join(work, 'AGENTS.md'), '# entry point of the root\n')
  entry(join(work, 'README.md'), '# read me\n')
  for (const type of ['_tools_', '_verifiers_', '_monitors_', '_projects_']) {
    entry(join(work, type, 'INDEX.md'), `# ${type}\n`)
  }
  /**
   * One type folder with **nothing** inside it — not even its `INDEX.md`.
   *
   * `_monitors_` above has its index, which is a file node now that files are shown, so it is no longer
   * the empty case. This one is created and left bare on purpose: "asked and empty" is a distinct answer
   * from "not asked", and the only way to judge it is with a folder that has no entries at all.
   */
  mkdirSync(join(work, '_formatters_'), { recursive: true })
  entry(join(work, '_tools_', 'some-tool', 'INDEX.md'), '# some-tool\n')
  /**
   * A branch's sessions, which the tree shows **without** their `_sessions_` folder and above everything
   * else the branch holds — the owner's rule of 2026-10-11, and the reason this fixture needs one.
   */
  entry(join(work, '_tools_', 'some-tool', '_sessions_', 'first-conversation', 'INDEX.md'), '# a session\n')
  entry(join(work, '_tools_', 'some-tool', '_sessions_', 'first-conversation', 'session.json'), '{}\n')
  entry(join(work, '_tools_', 'some-tool', '_sessions_', 'second-conversation', 'INDEX.md'), '# another session\n')
  entry(join(work, '_tools_', 'some-tool', 'run.py'), 'print("hi")\n')
  entry(join(work, '_verifiers_', '05-config-system', 'INDEX.md'), '# the claim\n')
  entry(join(work, '_verifiers_', '05-config-system', 'verify.sh'), 'exit 0\n')
  entry(join(work, '_projects_', 'a-project', 'INDEX.md'), '# a-project\n')
  entry(join(work, '_projects_', 'a-project', 'ULTIMATE_GOAL.md'), '# the goal\n')
  entry(join(work, '_projects_', 'a-project', '_context_', 'INDEX.md'), '# gathered\n')
  entry(join(work, '_projects_', 'a-project', '_context_', 'source-material', 'INDEX.md'), '# the material\n')
  entry(join(work, 'shared', 'INDEX.md'), '# shared\n')
  entry(join(work, 'shared', '_skills_', 'INDEX.md'), '# _skills_\n')
  entry(join(work, 'shared', '_skills_', 'a-skill', 'INDEX.md'), '# a-skill\n')
  entry(join(work, 'shared', '_skills_', 'a-skill', 'SKILL.md'), '# the skill\n')
  entry(join(work, 'dist', 'index.html'), '<!doctype html>\n')
  entry(join(work, 'node_modules', 'left-pad', 'package.json'), '{}\n')
  entry(join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  const added = await runCli(adminArgs(h, ['workspace', 'add', work]), { env: h.env, cwd: work })
  assert.equal(added.code, 0, `the fixture registered its own root\n${added.stdout}${added.stderr}`)
  return work
}

/** One level of the tree, read through the CLI. */
async function treeAt(h, path, options = {}) {
  const result = await runCli(adminArgs(h, ['tree', ...(path === undefined ? [] : [path]), '--json', ...(options.extra ?? [])]), {
    env: h.env,
    cwd: options.cwd ?? h.work,
  })
  return { result, tree: parseJson(result.stdout) }
}

/** The child a node names, or `undefined` when it does not list one. */
function childOf(node, label) {
  return (node?.children ?? []).find((entry) => entry.label === label)
}

/** The workspace listing, parsed. */
async function workspacesOf(h) {
  const result = await runCli(adminArgs(h, ['workspaces', '--json']), { env: h.env, cwd: h.work })
  assert.equal(result.code, 0, `the listing ran\n${result.stdout}${result.stderr}`)
  return parseJson(result.stdout)
}

/** The flat session listing, parsed. */
async function sessionsOf(h) {
  const result = await runCli(adminArgs(h, ['sessions', '--json']), { env: h.env, cwd: h.work })
  assert.equal(result.code, 0, `the listing ran\n${result.stdout}${result.stderr}`)
  return parseJson(result.stdout)
}

test('a run writes a session record that outlives it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('writes')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.timedOut, false, `the run finished\n${result.stdout}${result.stderr}`)
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const sessions = sessionsUnder(join(h.home, 'sessions'))
    assert.equal(sessions.length, 1, `the run left exactly one record behind\nfound: ${sessions.join(', ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the transcript is readable on disk and holds the turn', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('readable')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const transcript = transcriptFile(join(h.home, 'sessions', sessionsUnder(join(h.home, 'sessions'))[0] ?? ''))
    assert.ok(existsSync(transcript), `the transcript exists at ${transcript}`)

    const events = readTranscript(transcript)
    const kinds = [...new Set(events.map((event) => event.type))]
    for (const wanted of ['message', 'assistant/completed', 'turn/completed']) {
      assert.ok(kinds.includes(wanted), `the transcript records '${wanted}'\nsaw: ${kinds.join(', ')}`)
    }
    const recorded = events
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(recorded.includes('remember the word loom'), `the user's words are in the record\nsaw: ${recorded.join(' | ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a resumed session carries the earlier turns', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('resume')
  try {
    const first = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(id, 'the first run created a session')

    const second = await runCli([...h.args, '--turn', 'what did I ask you to remember', '--resume', id], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const texts = readTranscript(join(h.home, 'sessions', id))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('remember the word loom'), 'the first turn is still in the resumed session')
    assert.ok(texts.includes('what did I ask you to remember'), 'the second turn was appended to it')
    assert.equal(sessionsUnder(join(h.home, 'sessions')).length, 1, 'resuming did not start a second session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the record is appended to, never rewritten', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('append')
  try {
    await runCli([...h.args, '--turn', 'first'], { env: h.env })
    const id = sessionsUnder(join(h.home, 'sessions'))[0] ?? ''
    const transcript = transcriptFile(join(h.home, 'sessions', id))
    /**
     * Compared as **bytes**, because a transcript is now a sequence of zstd frames.
     *
     * Decoding it as UTF-8 and comparing strings would mostly work and occasionally fail: a frame
     * boundary can land in the middle of a multi-byte character, and the shorter read would end in a
     * replacement character where the longer one has the real one. The claim is about bytes anyway —
     * an append leaves everything before it untouched — so bytes are what is compared.
     */
    const before = readFileSync(transcript)
    await runCli([...h.args, '--turn', 'second', '--resume', id], { env: h.env })
    const after = readFileSync(transcript)
    assert.ok(after.length > before.length, 'the second turn was appended')
    assert.ok(after.subarray(0, before.length).equals(before), 'the earlier bytes are still the beginning of the file')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is grouped under the workspace whose folder it ran in', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('grouped')
  try {
    const run = await runCli([...h.args, '--turn', 'say something'], { env: h.env, cwd: h.work })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)

    const listing = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'workspaces', '--json'], { env: h.env, cwd: h.work })
    assert.equal(listing.code, 0, `the command ran\n${listing.stdout}${listing.stderr}`)
    const workspaces = parseJson(listing.stdout)
    assert.ok(Array.isArray(workspaces) && workspaces.length > 0, `a workspace exists\n${listing.stdout}`)

    /**
     * The workspace is found by its **path**, not by its title, because a title is a label a person
     * can change and the path is what the association is actually made of.
     */
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.ok(mine, `the workspace names the directory the turn ran in (${h.work})\nsaw: ${workspaces.map((w) => w.path).join(', ')}`)
    assert.ok((mine.sessions ?? []).length > 0, 'and it holds the session that ran there')
    assert.equal(mine.sessions[0], sessionsUnder(join(h.home, 'sessions'))[0], 'the id in the record is the id on disk')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session in a subdirectory is a member of the workspace root above it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('subdir')
  const sub = join(h.work, 'nested', 'deeper')
  try {
    mkdirSync(sub, { recursive: true })
    const inParent = await runCli([...h.args, '--turn', 'from the parent'], { env: h.env, cwd: h.work })
    assert.equal(inParent.code, 0, `the parent turn ran\n${inParent.stdout}${inParent.stderr}`)
    const inChild = await runCli([...h.args, '--turn', 'from the child'], { env: h.env, cwd: sub })
    assert.equal(inChild.code, 0, `the child turn ran\n${inChild.stdout}${inChild.stderr}`)

    /**
     * This check asserted the **opposite** until 2026-10-11, and the reversal is the owner's.
     *
     * DSH's rule is equality — a session belongs to the workspace whose path is its working directory
     * exactly, so a subdirectory becomes a workspace of its own — and this check was written to pin
     * that, because it is the rule that surprises people. The owner then chose containment for
     * heddle, because the left column is a tree of *folders* rather than of workspaces: every folder
     * that holds a conversation would otherwise become a registration. The check now asserts the new
     * rule rather than being deleted, so the reversal is visible in the checks as well as in
     * [`../../SESSION_TREE.md`](../../SESSION_TREE.md).
     */
    const workspaces = await workspacesOf(h)
    assert.deepEqual(
      workspaces.map((workspace) => workspace.path),
      [h.work],
      `only the root above both directories is a workspace\nsaw: ${workspaces.map((workspace) => workspace.path).join(', ')}`,
    )
    assert.equal((workspaces[0].sessions ?? []).length, 2, 'and it accounts for the session in the subdirectory as well as its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('asking one folder twice continues one session, and both turns are in it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('find')
  try {
    await runCli([...h.args, '--turn', 'the first conversation'], { env: h.env, cwd: h.work })
    await runCli([...h.args, '--turn', 'the second conversation'], { env: h.env, cwd: h.work })

    /**
     * This check assumed the opposite until 2026-10-11: two runs in one folder made two sessions,
     * and the point was that both could be found again without an id. Under the owner's
     * one-session-per-folder rule the second prompt **continues** the first, so the claim to judge is
     * that the folder has exactly one session and that it holds both turns — a person who asks twice
     * in one folder asked twice in one conversation, which is what "the folder is the session" means.
     */
    const sessions = await sessionsOf(h)
    assert.ok(Array.isArray(sessions), 'the session list is machine-readable')
    assert.equal(sessions.length, 1, `one folder holds one session\n${JSON.stringify(sessions).slice(0, 300)}`)
    assert.ok(
      String(sessions[0].title ?? '').includes('the first conversation'),
      'the session keeps the title it was started with, so a person recognises it',
    )
    assert.ok(typeof sessions[0].created === 'string' && sessions[0].created.length > 0, 'and when it was created')

    const texts = readTranscript(join(h.home, 'sessions', sessions[0].id))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('the first conversation'), 'the first prompt is in the one session')
    assert.ok(texts.includes('the second conversation'), 'and so is the second')

    const workspaces = await workspacesOf(h)
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.equal((mine?.sessions ?? []).length, 1, 'and the workspace accounts for that one session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

/*
 * The checks below judge the folder-bound session tree, which is stated in `SESSION_TREE.md` and was
 * not built when they were written (2026-10-11). Each reports unjudged until it is.
 */

test('starting a new session in a folder moves the folder to it, and the old one stays readable', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('rotate')
  const folder = join(h.work, '_tools_', 'some-tool')
  try {
    await conventionsFixture(h)
    assert.equal((await runCli([...h.args, '--turn', 'the old conversation'], { env: h.env, cwd: folder })).code, 0, 'the first turn ran')
    const before = await sessionsOf(h)
    assert.equal(before.length, 1, 'the first prompt made one session')
    const firstId = before[0].id

    const fresh = await runCli([...h.args, '--turn', 'a fresh conversation', '--new'], { env: h.env, cwd: folder })
    assert.equal(fresh.code, 0, `--new ran\n${fresh.stdout}${fresh.stderr}`)
    const after = await sessionsOf(h)
    assert.equal(after.length, 2, 'the new session did not replace the old one on disk')
    const freshId = after.map((meta) => meta.id).find((id) => id !== firstId)
    assert.ok(freshId, 'and it has an id of its own')

    /**
     * The folder points at its **current** session, which is the whole of "one folder, one session":
     * the history stays in the store and in `heddle sessions`, and only the folder's pointer moves.
     */
    const { tree } = await treeAt(h, folder)
    assert.equal(tree.session?.id, freshId, 'the folder now points at the new session')

    assert.equal((await runCli([...h.args, '--turn', 'and on we go'], { env: h.env, cwd: folder })).code, 0, 'the next turn ran')
    const finalList = await sessionsOf(h)
    assert.equal(finalList.length, 2, 'a prompt after --new continues the new session rather than making a third')

    const transcript = await runCli(adminArgs(h, ['transcript', firstId]), { env: h.env, cwd: h.work })
    assert.equal(transcript.code, 0, `the old session is still readable\n${transcript.stdout}${transcript.stderr}`)
    assert.match(transcript.stdout, /the old conversation/, 'and it still holds its own turn')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a sibling folder whose path shares a prefix is not a member', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('prefix')
  /**
   * A path prefix is not a directory ancestry, and this is the pair that tells them apart:
   * `<root>` and `<root>-sibling` share every character of the root's path. Membership compared as
   * strings would put the sibling inside the root; compared by segment it cannot.
   */
  const sibling = `${h.work}-sibling`
  try {
    mkdirSync(sibling, { recursive: true })
    assert.equal((await runCli([...h.args, '--turn', 'from the root'], { env: h.env, cwd: h.work })).code, 0, 'the root turn ran')
    assert.equal((await runCli([...h.args, '--turn', 'from the sibling'], { env: h.env, cwd: sibling })).code, 0, 'the sibling turn ran')

    const workspaces = await workspacesOf(h)
    const root = workspaces.find((workspace) => workspace.path === h.work)
    const other = workspaces.find((workspace) => workspace.path === sibling)
    assert.ok(other, `the sibling is a workspace of its own\nsaw: ${workspaces.map((workspace) => workspace.path).join(', ')}`)
    assert.equal((root?.sessions ?? []).length, 1, 'the root accounts only for its own session')
    assert.equal(other.sessions.length, 1, 'and the sibling accounts only for its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(sibling)
  }
})

test('the nearest registered root owns a session when roots nest', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('nest')
  const inner = join(h.work, 'inner')
  const deep = join(inner, 'deep')
  try {
    mkdirSync(deep, { recursive: true })
    for (const path of [h.work, inner]) {
      const added = await runCli(adminArgs(h, ['workspace', 'add', path]), { env: h.env, cwd: h.work })
      assert.equal(added.code, 0, `registering ${path} worked\n${added.stdout}${added.stderr}`)
    }
    assert.equal((await runCli([...h.args, '--turn', 'from deep'], { env: h.env, cwd: deep })).code, 0, 'the deep turn ran')

    const workspaces = await workspacesOf(h)
    const outer = workspaces.find((workspace) => workspace.path === h.work)
    const nearer = workspaces.find((workspace) => workspace.path === inner)
    assert.equal((nearer?.sessions ?? []).length, 1, 'the nearest root owns the session')
    assert.equal((outer?.sessions ?? []).length, 0, 'and the outer root does not claim it as well')

    const { tree } = await treeAt(h, h.work)
    assert.equal(childOf(tree, 'inner')?.kind, 'workspace', 'the outer tree shows the inner root as a workspace node')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the tree lists one level at a time, folders before files, and a dot-entry is not a node', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('levels')
  try {
    await conventionsFixture(h)
    const { result, tree } = await treeAt(h, h.work)
    assert.equal(result.code, 0, `the tree ran\n${result.stdout}${result.stderr}`)

    const children = tree.children ?? []
    const labels = children.map((node) => node.label)
    assert.ok(labels.includes('_tools_') && labels.includes('shared'), `the level lists folders\nsaw: ${labels.join(', ')}`)

    /**
     * This check asserted the opposite until 2026-10-11 — *a file is not a node* — and the owner reversed
     * it: the navigation shows the files under a folder, and clicking one opens its content in the right
     * panel. What survives from the original rule is the part that was really about navigation: the level
     * is one deep, folders come first, and what nobody means by content (dot-entries, `node_modules`) is
     * still not enumerated.
     */
    const file = children.find((node) => node.label === 'AGENTS.md')
    assert.ok(file, `a file under the root is a node, with the owner's rule\nsaw: ${labels.join(', ')}`)
    assert.equal(file.kind, 'file', 'and it says it is a file')
    assert.deepEqual(file.children, [], 'a file holds nothing inside, ever — asked and empty rather than unasked')
    assert.ok(typeof file.bytes === 'number' && file.bytes > 0, 'and how big it is, without being opened')

    const firstFile = children.findIndex((node) => node.kind === 'file')
    const lastFolder = children.map((node) => node.kind !== 'file').lastIndexOf(true)
    assert.ok(firstFile > lastFolder, 'folders come before files, so the structure stays together at the top')

    assert.ok(!labels.includes('some-tool'), 'a grandchild is not listed, because its parent was not asked for')
    const tools = childOf(tree, '_tools_')
    assert.ok(tools, 'the type folder is there')
    assert.equal(tools.children, null, 'a node that was not expanded says so rather than reporting an empty list')

    const inner = await treeAt(h, join(h.work, '_tools_'))
    const innerLabels = (inner.tree.children ?? []).map((node) => node.label)
    assert.ok(innerLabels.includes('some-tool'), 'expanding a folder lists its instance')
    assert.ok(innerLabels.includes('INDEX.md'), 'and its files, because this level was asked for')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a file under a root reads, and what cannot be shown is refused with a reason', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('file-read')
  const outside = fixtureDir('file-outside')
  try {
    await conventionsFixture(h)
    const read = await runCli(adminArgs(h, ['file', join(h.work, 'shared', 'INDEX.md'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(read.code, 0, `the file read\n${read.stdout}${read.stderr}`)
    const body = parseJson(read.stdout)
    assert.equal(body.name, 'INDEX.md', 'the reading names the file')
    assert.ok(String(body.text).includes('# shared'), `and carries its text\nsaw: ${String(body.text).slice(0, 60)}`)
    assert.equal(body.truncated, false, 'a small file is whole')
    assert.ok(body.lines >= 1, 'and says how many lines it has')
    assert.ok(body.bytes > 0, 'and how many bytes')

    /**
     * The fence, and it is the same one the tree uses: a reader that answers for any path is a way to read
     * the whole machine behind a token, and a symlink is why the canonical path is what gets checked.
     */
    entry(join(outside, 'secret.md'), '# not under any root\n')
    const refused = await runCli(adminArgs(h, ['file', join(outside, 'secret.md')]), { env: h.env, cwd: h.work })
    assert.notEqual(refused.code, 0, 'a file outside every root is refused')
    assert.match(`${refused.stdout}${refused.stderr}`, /workspace root/i, 'and the refusal names the rule')

    // A directory is not a file, and saying so is better than an empty panel.
    const directory = await runCli(adminArgs(h, ['file', join(h.work, 'shared')]), { env: h.env, cwd: h.work })
    assert.notEqual(directory.code, 0, 'a folder is refused')
    assert.match(`${directory.stdout}${directory.stderr}`, /not a file/i, 'with a sentence that says why')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(outside)
  }
})

test('a type folder is a type, and its badge names it without the underscores', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('type')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    for (const [label, badge] of [
      ['_tools_', 'TLS'],
      ['_verifiers_', 'VRF'],
      ['_monitors_', 'MNT'],
      ['_formatters_', 'FRM'],
    ]) {
      const node = childOf(tree, label)
      assert.equal(node?.kind, 'type', `${label} is a type folder`)
      assert.equal(node?.badge, badge, `${label} is badged from its own name`)
      assert.equal(node?.label, label, 'and it keeps the folder name as its label')
    }
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('an instance inside a type is an instance and keeps the folder name', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('instance')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, join(h.work, '_tools_'))
    const node = childOf(tree, 'some-tool')
    assert.ok(node, `the instance is listed\nsaw: ${(tree.children ?? []).map((child) => child.label).join(', ')}`)
    assert.equal(node.kind, 'instance', 'a kebab-case folder inside a type folder is an instance')
    assert.equal(node.label, 'some-tool', 'and its label is the folder name')
    assert.ok(node.badge === null || node.badge === undefined, 'an instance carries no type badge of its own')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a type inside an instance is a type again', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('recursive-type')
  try {
    await conventionsFixture(h)
    const project = join(h.work, '_projects_', 'a-project')
    const { tree } = await treeAt(h, project)
    const context_ = childOf(tree, '_context_')
    assert.equal(context_?.kind, 'type', 'a type folder inside an instance is a type')
    assert.equal(context_?.badge, 'CTX', 'badged CTX, the name this UI uses for it, which keeps it apart from _conventions_')

    const deeper = await treeAt(h, join(project, '_context_'))
    assert.equal(childOf(deeper.tree, 'source-material')?.kind, 'instance', 'and its own instance is an instance, four levels down')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a plain container folder is a folder, and a type inside it is still a type', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('container')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    const shared = childOf(tree, 'shared')
    assert.equal(shared?.kind, 'folder', 'a plain-named folder is neither a type nor an instance')
    const inner = await treeAt(h, join(h.work, 'shared'))
    assert.equal(childOf(inner.tree, '_skills_')?.kind, 'type', 'and a type inside it is still a type')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('plumbing is hidden and a declared generated folder is named as one', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('hidden')
  try {
    await conventionsFixture(h)
    const { tree } = await treeAt(h, h.work)
    const labels = (tree.children ?? []).map((node) => node.label)
    assert.ok(!labels.includes('.git'), 'a dot-directory is plumbing, not content')
    assert.ok(!labels.includes('node_modules'), 'and neither are installed dependencies')

    /**
     * A generated folder is invisible on disk, which is why the caller names it — the same word the
     * conventions linter takes (`--generated dist`), so one vocabulary decides it in both tools.
     *
     * Two directions are judged with two names, and the second name is the reason: `dist` is declared
     * by **heddle's own profile** (`heddle.patch.yml`, `generated: [dist]`), and this check runs that
     * profile — so `dist` must come back generated without any flag. Measured the hard way: the check
     * first asserted that undeclared `dist` is an ordinary folder, which stopped being true the moment
     * the project declared its own build output, and the failure was the check being wrong rather than
     * the tree.
     */
    assert.equal(childOf(tree, 'dist')?.kind, 'generated', 'the project profile declares dist, so the tree names it')

    entry(join(h.work, 'build', 'INDEX.md'), '# a folder nothing declares\n')
    const undeclared = await treeAt(h, h.work)
    assert.equal(childOf(undeclared.tree, 'build')?.kind, 'folder', 'an undeclared folder is an ordinary folder rather than hidden')

    const declared = await treeAt(h, h.work, { extra: ['--generated', 'build'] })
    assert.equal(childOf(declared.tree, 'build')?.kind, 'generated', 'and naming it marks it')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('only an instance carries a session, and nested plain folders do not', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('boundary')
  try {
    await conventionsFixture(h)
    const instance = join(h.work, '_tools_', 'some-tool')
    const deep = join(instance, 'src', 'deep')
    mkdirSync(deep, { recursive: true })

    /**
     * The owner's rule of 2026-10-11, and the fixture is built to break the obvious wrong version of
     * it: **a `_type_` folder is the boundary, and a session node exists only for an instance of
     * one.** A tree that showed a session on every folder holding one would put a session on the
     * workspace root, on `shared` and on `_tools_` itself — and on this deep plain folder, which is
     * the case the rule is really about: several levels of ordinary structure may sit inside an
     * instance, and none of them is a place to work.
     */
    for (const folder of [h.work, join(h.work, 'shared'), instance, deep]) {
      const label = folder === h.work ? 'the root' : folder.slice(h.work.length + 1)
      const run = await runCli([...h.args, '--turn', `from ${label}`], { env: h.env, cwd: folder })
      assert.equal(run.code, 0, `the turn in ${folder} ran\n${run.stdout}${run.stderr}`)
    }
    const stored = await sessionsOf(h)
    assert.equal(stored.length, 4, `four folders hold four sessions\n${JSON.stringify(stored.map((meta) => meta.cwd))}`)

    const { tree } = await treeAt(h, h.work)
    assert.equal(tree.session, null, 'the workspace root is a boundary, not an instance, so it carries no session')
    assert.equal(childOf(tree, 'shared')?.session, null, 'a plain container folder carries none either')

    const tools = await treeAt(h, join(h.work, '_tools_'))
    assert.equal(tools.tree.session, null, 'a type folder is the boundary itself, so it carries no session')
    const tool = childOf(tools.tree, 'some-tool')
    assert.ok(tool, 'the instance is listed under its type')
    assert.equal(tool.session?.turns, 1, 'and the instance carries the session that ran in it')

    const inside = await treeAt(h, instance)
    assert.equal(childOf(inside.tree, 'src')?.session, null, 'a plain folder inside an instance carries no session')
    const src = await treeAt(h, join(instance, 'src'))
    assert.equal(childOf(src.tree, 'deep')?.session, null, 'and neither does a folder nested two levels inside it')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the folder name is the session name, not the first prompt', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('label')
  const folder = join(h.work, '_tools_', 'some-tool')
  try {
    await conventionsFixture(h)
    assert.equal((await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env, cwd: folder })).code, 0, 'the turn ran')

    const { tree } = await treeAt(h, join(h.work, '_tools_'))
    const node = childOf(tree, 'some-tool')
    assert.equal(node?.label, 'some-tool', 'the node is named by its folder')
    assert.ok(typeof node?.session?.id === 'string', 'and it carries the folder session')

    const sessions = await sessionsOf(h)
    assert.match(String(sessions[0]?.title ?? ''), /remember the word loom/, 'while the transcript title is still the first prompt')
    assert.notEqual(node.label, sessions[0].title, 'the two are different facts and neither replaces the other')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('an empty type folder is a type with no children rather than an error', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('empty-type')
  try {
    await conventionsFixture(h)
    const { result, tree } = await treeAt(h, join(h.work, '_formatters_'))
    assert.equal(result.code, 0, `an empty type folder is not an error\n${result.stdout}${result.stderr}`)
    assert.equal(tree.kind, 'type', 'it is still a type folder')
    assert.deepEqual(tree.children, [], 'asked and empty is an empty list, which is not the same as unasked')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session can be created at the top-level workspace, and its definition is content', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-new')
  try {
    await conventionsFixture(h)
    /**
     * The owner's rule of 2026-10-11: `heddle session new <branch>` works at the **workspace root** as well
     * as inside an instance. It writes the session's definition into that branch — which is what makes the
     * session reviewable and committable — while the transcript stays machine state outside the repository.
     */
    const created = await runCli(adminArgs(h, ['session', 'new', h.work, '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `the session was created\n${created.stdout}${created.stderr}`)
    const body = parseJson(created.stdout)
    assert.match(String(body.name), /^session-\d{8}-\d{4}$/, `the instance is named for the clock\nsaw: ${body.name}`)
    assert.ok(existsSync(body.definition), `the definition is on disk at ${body.definition}`)
    assert.ok(!isUnder(h.work, body.log), `and the log is not in the repository\nsaw: ${body.log}`)

    const definition = JSON.parse(readFileSync(body.definition, 'utf8'))
    assert.equal(definition.id, body.session, 'the definition names the session it belongs to')
    assert.equal(definition.cwd, h.work, 'and the folder the session is bound to')
    assert.equal(definition.log, body.log, 'and the log it references')
    assert.ok(existsSync(join(String(body.definition).replace('/session.json', ''), 'INDEX.md')), 'the instance carries an entry point, like every content folder')
    /**
     * And so does the **type folder** heddle created. Measured by the convention linter on this very
     * repository: the first version wrote only the session's own folder, so a repository in which a session
     * had been started failed with `_sessions_: no entry point`. A folder a tool creates is a folder the tool
     * has to finish.
     */
    assert.ok(existsSync(join(h.work, '_sessions_', 'INDEX.md')), 'and so does the _sessions_ folder heddle had to create')

    // The tree shows it under the branch that owns it, first, and never the folder it sits in.
    const tree = await treeAt(h, h.work)
    const first = (tree.tree.children ?? [])[0]
    assert.equal(first?.kind, 'session', `the branch's first row is its session\nsaw: ${JSON.stringify((tree.tree.children ?? []).map((node) => node.kind))}`)
    assert.equal(first?.label, body.name, 'named as the definition folder is named')
    assert.ok(!(tree.tree.children ?? []).some((node) => node.label === '_sessions_'), 'and the filing folder is not drawn')

    // The session is a session: it is in the store, and it can be resumed.
    const sessions = await sessionsOf(h)
    assert.ok(sessions.some((meta) => meta.id === body.session), 'the store holds it')
    const again = await runCli(adminArgs(h, ['session', 'new', h.work, '--json']), { env: h.env, cwd: h.work })
    assert.equal(again.code, 0, 'a second session in the same branch is fine')
    assert.notEqual(parseJson(again.stdout).name, body.name, 'and it does not take the first one\'s folder')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a branch shows its sessions first, and never the folder that holds them', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('sessions-hoist')
  try {
    await conventionsFixture(h)
    const instance = await treeAt(h, join(h.work, '_tools_', 'some-tool'))
    const children = instance.tree.children ?? []
    const labels = children.map((node) => `${node.kind}:${node.label}`)

    /**
     * The rule this judges: `_sessions_` is a filing folder rather than something a person navigates, so
     * each session inside it is shown directly under the branch it belongs to and **before** that branch's
     * own folders and files. A tree that drew the folder, or sorted the sessions among the rest, would be
     * asking a reader to open a folder to find the conversation they are already sitting in.
     */
    assert.deepEqual(
      labels.filter((entry) => entry.startsWith('session:')),
      ['session:second-conversation', 'session:first-conversation'],
      `the branch's sessions are drawn, newest name first, because the names are chronological\nsaw: ${labels.join(', ')}`,
    )
    assert.equal(
      children.findIndex((node) => node.kind !== 'session'),
      labels.filter((entry) => entry.startsWith('session:')).length,
      'and they come before everything else the branch holds',
    )
    assert.ok(!labels.includes('type:_sessions_'), 'while the folder that holds them is not a node')

    const type = await treeAt(h, join(h.work, '_tools_'))
    assert.ok(
      !(type.tree.children ?? []).some((node) => node.label === '_sessions_'),
      'nothing at the type level names it either',
    )

    // Asked for directly it is still a type folder, and it lists what it holds.
    const asked = await treeAt(h, join(h.work, '_tools_', 'some-tool', '_sessions_'))
    assert.equal(asked.tree.kind, 'type', 'asked for by name, the folder says what it is')
    assert.deepEqual(
      (asked.tree.children ?? []).map((node) => node.kind),
      ['session', 'session'],
      'and answers with its sessions',
    )
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a folder outside every root is refused rather than walked', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('outside')
  const outside = fixtureDir('outside-root')
  try {
    entry(join(outside, 'INDEX.md'), '# not under any root\n')
    assert.equal((await runCli([...h.args, '--turn', 'from the root'], { env: h.env, cwd: h.work })).code, 0, 'the root turn ran')

    const { result } = await treeAt(h, outside)
    assert.notEqual(result.code, 0, 'a path that belongs to no root is refused')
    assert.match(`${result.stdout}${result.stderr}`, /root/i, 'and the refusal names the rule')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(outside)
  }
})

test('a session interrupted mid-frame still reads, and its next turn lands', async (context) => {  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  /**
   * The failure this judges was found by testing the storage format rather than the feature: a
   * transcript torn in the middle of a frame made **every event written afterwards unreadable**,
   * because the reader walks frames and stops at the first incomplete one. A session interrupted
   * once therefore swallowed every later turn — written to the file, never read back.
   *
   * The check is end-to-end because that is where the claim lives: a person resumes an interrupted
   * session and expects their next turn to be there.
   */
  const h = harness('torn')
  try {
    const first = await runCli([...h.args, '--turn', 'before the interruption'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0] ?? ''
    const transcript = transcriptFile(join(h.home, 'sessions', id))

    // A crash that stopped writing partway through the newest frame.
    const whole = readFileSync(transcript)
    truncateSync(transcript, whole.length - 5)
    assert.ok(decodeTranscript(readFileSync(transcript)).torn, 'the fixture is genuinely torn')

    const second = await runCli([...h.args, '--resume', id, '--turn', 'after the interruption'], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const events = readTranscript(join(h.home, 'sessions', id))
    const said = events
      .filter((event) => event.type === 'message' && event.message?.role === 'user')
      .map((event) => event.message.content?.[0]?.text)
    assert.ok(said.includes('before the interruption'), `the earlier turn survived the tear\nsaw: ${said.join(' | ')}`)
    assert.ok(said.includes('after the interruption'), `and the turn written after it is readable\nsaw: ${said.join(' | ')}`)
    assert.ok(
      events.some((event) => event.type === 'transcript/repaired'),
      'and the session says it was repaired rather than pretending nothing happened',
    )
    assert.ok(!decodeTranscript(readFileSync(transcript)).torn, 'the record no longer ends in a half-written frame')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

/** Boot a server for the one browser check here, resolving once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 15s\n${output}`))
        }
      }, 15_000)
    })()
  })
}

/**
 * The state of one row's disclosure, read from the page.
 *
 * There is no `+` / `−` control to read: the owner removed it on 2026-10-11 once clicking a row became the way
 * to open and close one, because a second control for one act made the eye hunt for it. The state is therefore
 * read where a reader is told about it — the row's `aria-expanded`, the tree item's own state, and the folder
 * glyph on the left — plus whether the children are drawn.
 */
function disclosure(label) {
  return `JSON.stringify((() => {
    const row = [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === ${JSON.stringify(label)})
    if (row === undefined) return { missing: true }
    const li = row.closest('li')
    const note = li.querySelector('.empty')
    return { glyph: (row.querySelector('.icon svg') || {}).dataset ? row.querySelector('.icon svg').dataset.state : null, expanded: li.getAttribute('aria-expanded'), open: li.dataset.open, note: note === null ? null : note.textContent, children: li.querySelector('ul[role=group]') === null ? 0 : li.querySelectorAll('ul[role=group] > li').length }
  })())`
}

test('a folder opens and closes with the same control, including a leaf with nothing inside', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('tree-ui')
  let live
  let browser
  try {
    await conventionsFixture(h)
    /**
     * This is the one check in this part that judges a **rendered page**, and it exists because the
     * owner hit the defect it pins: the first version of the tree turned the disclosure into a
     * disabled `·` once a folder turned out to be empty, so a leaf could be opened and then had no
     * control left to close it with. No API check could see that — the route answered correctly and
     * the derivation was right — which is the whole argument for a browser check.
     */
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll("#tree .row").length > 0`, 20_000)

    // The root is opened by clicking its **row**, which is the only control a folder has now.
    await browser.evaluate('document.querySelector("#tree .row").click()')
    await browser.waitFor(`document.querySelectorAll('#tree li[data-kind="type"]').length > 0`, 20_000)

    /**
     * The owner's rule of 2026-10-11: clicking an **expandable folder** expands and closes it, and the
     * folder glyph on the left says which state it is in — a reader should not have to read the `+` / `−`
     * control, or aim at it, to know whether a folder is open.
     */
    const toggled = JSON.parse(
      await browser.evaluate(`(async () => {
        const rowFor = (label) => [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === label)
        const state = (label) => {
          const row = rowFor(label)
          const li = row.closest('li')
          return {
            glyph: row.querySelector('.icon svg')?.dataset.state ?? null,
            open: li.dataset.open,
            expanded: li.getAttribute('aria-expanded'),
            group: li.querySelector('ul[role=group]') !== null,
          }
        }
        const before = state('_tools_')
        rowFor('_tools_').click()
        await new Promise((done) => setTimeout(done, 700))
        const opened = state('_tools_')
        rowFor('_tools_').click()
        await new Promise((done) => setTimeout(done, 400))
        const closed = state('_tools_')
        rowFor('_tools_').click()
        await new Promise((done) => setTimeout(done, 700))
        const reopened = state('_tools_')
        // Left closed, because the assertions that follow open it themselves.
        rowFor('_tools_').click()
        await new Promise((done) => setTimeout(done, 400))
        return JSON.stringify({ before, opened, closed, reopened, leftClosed: state('_tools_') })
      })()`),
    )
    assert.equal(toggled.before.glyph, 'closed', 'a closed folder shows the closed glyph')
    assert.equal(toggled.before.open, 'false', 'and the tree item says it is closed')
    assert.equal(toggled.opened.glyph, 'open', 'clicking the row itself opens the folder, and the glyph says so')
    assert.equal(toggled.opened.glyph, 'open', 'and the row is the only control, so the glyph is where the state is read')
    assert.equal(toggled.opened.open, 'true', 'the tree item carries the state for a reader')
    assert.equal(toggled.opened.group, true, 'and the children are drawn')
    assert.equal(toggled.closed.glyph, 'closed', 'clicking it again closes the folder')
    assert.equal(toggled.closed.group, false, 'and takes the children away')
    assert.equal(toggled.reopened.glyph, 'open', 'and it opens again, so the two states are a toggle rather than a one-way door')
    assert.equal(toggled.leftClosed.glyph, 'closed', 'and it closes again, leaving the tree where the next assertions expect it')

    /**
     * Opening an **instance** opens it and nothing else — the owner's rule of 2026-10-11: a folder click is
     * navigation, so it must not retarget the panel. This assertion used to be its opposite (opening an
     * instance selected it, and the note said a new conversation had started there); the rule changed and the
     * claim moved with it, rather than the check being loosened.
     */
    // The folder is reopened first: a row that is not drawn cannot be clicked, and the block above
    // deliberately leaves `_tools_` closed.
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_tools_').click()`,
    )
    await browser.waitFor(`[...document.querySelectorAll('#tree .row')].some((entry) => entry.querySelector('.label').textContent === 'some-tool')`, 20_000)
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'some-tool').click()`,
    )
    const openedInstance = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        selected: [...document.querySelectorAll('#tree li[aria-selected="true"] > .row')].map((entry) => entry.querySelector('.label').textContent),
        open: [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'some-tool').parentElement.dataset.open,
      })`),
    )
    assert.equal(openedInstance.open, 'true', 'opening an instance opens it')
    assert.deepEqual(openedInstance.selected, [], 'and chooses nothing: a folder is navigation, not a selection')

    // Closed again, because the assertions that follow drive the disclosure from a known state.
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_tools_').click()`,
    )
    await browser.waitFor(`![...document.querySelectorAll('#tree .row')].some((entry) => entry.querySelector('.label').textContent === 'some-tool')`, 20_000)

    // A leaf: `_formatters_` is a type folder with nothing inside it.
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_formatters_').click()`,
    )
    await browser.waitFor(`document.getElementById('tree-note').textContent.includes('nothing inside') || document.querySelector('#tree .empty') !== null`, 20_000)
    const open = JSON.parse(await browser.evaluate(disclosure('_formatters_')))
    assert.equal(open.expanded, 'true', 'an opened folder says so on the tree item, leaf or not')
    assert.equal(open.glyph, 'open', 'and the glyph agrees')
    assert.equal(open.note, 'nothing inside', 'and what is inside is said in words')

    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_formatters_').click()`,
    )
    await browser.waitFor(`!document.getElementById('tree-note').textContent.includes('nothing inside') || document.querySelector('#tree .empty') !== null`, 20_000)
    const closed = JSON.parse(await browser.evaluate(disclosure('_formatters_')))
    assert.equal(closed.glyph, 'closed', 'and a second click closes it again')
    assert.equal(closed.expanded, 'false', 'with the state updated')
    assert.equal(closed.children, 0, 'and the group gone rather than left behind')

    /**
     * A folder **with** children closes the same way, so the two are one behaviour rather than two
     * code paths that can drift apart.
     */
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_tools_').click()`,
    )
    await browser.waitFor(`[...document.querySelectorAll('#tree .row')].some((entry) => entry.querySelector('.label').textContent === 'some-tool')`, 20_000)
    const toolsOpen = JSON.parse(await browser.evaluate(disclosure('_tools_')))
    assert.equal(toolsOpen.glyph, 'open', 'a folder with children opens the same way')
    assert.equal(toolsOpen.children, 2, 'and what is inside it is drawn: its instance, and its own index as a file')

    /**
     * No list in the tree draws a marker, and a nested row is indented by the tree's own rule.
     *
     * The owner's second report, and the second defect only a browser could see: `loadChildren` builds
     * a node's children as a `<ul role="group">` while the style rule named `ol`, so every nested level
     * kept `list-style-type: circle` and a 40px gutter — a stray dot at the left of each row, with the
     * level pushed in. Measured under the defect: `styles` was `['none', 'circle']` and the offset was
     * 40px; the assertions below are the two halves of what a person actually sees.
     */
    const layout = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const lists = [...document.querySelectorAll('#tree ul, #tree ol')]
        const find = (label) => [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === label)
        return {
          styles: lists.map((list) => getComputedStyle(list).listStyleType),
          indent: Math.round(find('some-tool').getBoundingClientRect().left - find('_tools_').getBoundingClientRect().left),
        }
      })())`),
    )
    assert.ok(
      layout.styles.length > 1 && layout.styles.every((value) => value === 'none'),
      `no list in the tree draws a marker\nsaw: ${layout.styles.join(', ')}`,
    )
    assert.ok(
      layout.indent > 0 && layout.indent < 30,
      `a nested row is indented by the tree's own rule rather than by a browser marker gutter (${layout.indent}px)`,
    )

    /**
     * A file row opens its content in the right panel.
     *
     * The owner's rule of 2026-10-11, and the half of it that only a browser can judge: the tree showed
     * folders and a click meant a conversation, so `File` is a third view beside Chat and Trajectory, a
     * file row carries no disclosure, and what the panel shows is the file's own text rather than a
     * summary of it.
     */
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'INDEX.md').click()`,
    )
    await browser.waitFor(`document.getElementById("file-body").innerText.includes("# _tools_")`, 20_000)
    const fileView = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const row = [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'INDEX.md')
        /**
         * The **offered** tabs, which is what a person sees: a tab can be in the ring and hidden, because the
         * ring keeps its buttons and the selection decides which of them are shown. Listing them all would make
         * this probe measure the markup rather than the panel.
         */
        const ring = [...document.querySelectorAll('#views button')].filter((button) => !button.hidden).map((button) => button.textContent)
        return {
          hidden: document.getElementById('file').hidden,
          head: document.getElementById('file-head').textContent,
          body: document.getElementById('file-body').textContent.trim(),
          disclosure: row.querySelector('.untwisty') === null ? 'none' : 'present',
          menu: row.querySelector('.menu-wrap') === null ? 'none' : 'present',
          selected: [...document.querySelectorAll('#tree li[aria-selected="true"] > .row')].map((entry) => entry.querySelector('.label').textContent),
          logHidden: document.getElementById('log').hidden,
          ring,
        }
      })())`),
    )
    assert.equal(fileView.hidden, false, 'clicking a file shows the file view in the right panel')
    assert.match(fileView.head, /INDEX\.md/, 'the header names the file')
    /**
     * A markdown document arrives **rendered** — that is what the preview is for — so the assertion is the
     * heading's text rather than its source, and the verbatim case is judged on a file that is not markdown.
     */
    /**
     * The assertion is on the text the fixture actually wrote, `# _tools_`.
     *
     * It looked for `/tools/` before, which the string `_tools_` does not contain — so it could never have passed,
     * and it was only reached once the failure above it was fixed. Measured: the wait for `# _tools_` succeeded
     * while this line failed, which is what a wrong claim looks like next to a correct wait.
     */
    assert.match(fileView.body, /tools/, 'the panel shows the document that was opened, not a summary of it')
    assert.ok(!fileView.body.includes('# _tools_'), 'rendered rather than handed over as its source')
    assert.equal(fileView.logHidden, true, 'and the conversation steps aside while the file is shown')
    assert.equal(fileView.disclosure, 'none', 'a file is a leaf, so its row carries no disclosure control')
    assert.equal(fileView.menu, 'none', 'and no actions menu until it has an action')
    /**
     * The selection is what the right panel is showing, and it is exactly one row: a tint alone would be
     * indistinguishable from hover, so the check asks for the mark rather than for a colour.
     */
    assert.deepEqual(fileView.selected, ['INDEX.md'], 'the file being shown is the selected row, and only it')
    /**
     * A file is shown on **its own**, and the ring says so: one tab, the file's. This assertion has been its
     * own opposite twice — first that a file was not a tab, then that a file's tab was absent — and the
     * owner's rule of 2026-10-11 is the third statement of it: chat, trajectory and docs are all statements
     * about a session, so a file offers none of them and offers its preview instead.
     */
    assert.deepEqual(fileView.ring, ['File'], `a file offers its preview and nothing else\nsaw: ${fileView.ring.join(', ')}`)

    /**
     * A file that is not markdown is shown verbatim: the same pane, a different renderer. The branch is
     * opened first — `run.py` lives inside `some-tool`, and a row that was never drawn cannot be clicked.
     */
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'some-tool').click()`,
    )
    await browser.waitFor(`[...document.querySelectorAll('#tree .row')].some((entry) => entry.querySelector('.label').textContent === 'run.py')`, 20_000)
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'run.py').click()`,
    )
    await browser.waitFor(`document.getElementById('file-body').innerText.includes('print')`, 20_000)
    const source = await browser.evaluate(`JSON.stringify({ body: document.getElementById('file-body').textContent, renderer: document.getElementById('file-body').dataset.renderer ?? 'text' })`)
    assert.match(JSON.parse(source).body, /print\("hi"\)/, 'a source file is shown verbatim, whitespace and all')

    /**
     * The row grammar the owner asked for, asserted **geometrically** rather than by markup: what a row
     * is on the left, what can be done with it on the right, and every action behind `…`.
     *
     * The first version of this read the row's child classes in order, and it broke every time the page
     * was restructured — which is a check measuring the markup rather than the behaviour. A person sees
     * positions, so positions are what is asserted: the disclosure and the menu sit to the right of the
     * name, and the menu is the rightmost of the two.
     */
    const grammar = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const rowFor = (label) => [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === label)
        const box = (element) => element === null || element === undefined ? null : element.getBoundingClientRect()
        const report = (label) => {
          const row = rowFor(label)
          if (row === undefined) return { missing: true }
          const buttons = [...row.querySelectorAll('button')]
          /**
           * Found by what the control **says**, so a renamed class or a new wrapper cannot break it.
           *
           * There is no disclosure button to find any more: the owner removed the +/- box on 2026-10-11 once
           * clicking a row became the way to open and close a folder, leaving the menu as the row's only control.
           * No backticks in here either — this block is inside a template literal, and one closes it.
           */
          const name = box(row.querySelector('.label'))
          const menu = box(buttons.find((button) => button.textContent === '…'))
          const ownButtons = buttons.map((button) => button.textContent)
          return {
            nameLeft: name === null ? null : Math.round(name.left),
            menuLeft: menu === null ? null : Math.round(menu.left),
            hasMenu: menu !== null,
            ownButtons,
          }
        }
        const roots = [...document.querySelectorAll('#tree .row')]
        return { instance: report('some-tool'), workspace: report(roots[0].querySelector('.label').textContent) }
      })())`),
    )
    const instance = grammar.instance
    assert.ok(!instance.missing, 'the instance row is drawn')
    assert.ok(instance.nameLeft !== null, 'an instance row carries a name')
    assert.ok(instance.hasMenu, "and its `…` menu, which is now the row's only control")
    assert.ok(
      instance.menuLeft > instance.nameLeft,
      `with the control to the right of the name\nsaw name at ${instance.nameLeft}, menu at ${instance.menuLeft}`,
    )
    assert.ok(
      !instance.ownButtons.includes('×') && !grammar.workspace.ownButtons.includes('×'),
      'no action is drawn on a row — they live behind the menu',
    )

    // The menu really holds the actions, which is the half a screenshot cannot tell you.
    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === 'some-tool').querySelector('.menu-wrap button').click()`,
    )
    const menu = JSON.parse(
      await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree .menu:not([hidden]) button')].map((button) => button.textContent))`),
    )
    assert.deepEqual(menu, ['New session here'], `the instance menu offers what an instance can do\nsaw: ${menu.join(', ')}`)

    /**
     * The actions themselves, through the routes the menu calls.
     *
     * The menu is opened rather than driven — a `window.prompt` cannot be answered from here — so the two
     * requests behind `Rename…` are made from the page's own origin, which is what the menu does. That
     * judges the routes rather than the button's wiring, and the wiring is what the assertions above pin.
     */
    const renamedRoot = JSON.parse(
      await browser.evaluate(`(async () => {
        const response = await fetch('/api/workspaces/' + encodeURIComponent(${JSON.stringify(h.work)}), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'renamed in a check' }),
        })
        const body = await response.json()
        return JSON.stringify({ status: response.status, title: body.title })
      })()`),
    )
    assert.equal(renamedRoot.status, 200, 'the root can be renamed')
    assert.equal(renamedRoot.title, 'renamed in a check', 'and the record carries the new name')

    const titled = JSON.parse(
      await browser.evaluate(`(async () => {
        const opened = await fetch('/api/folders/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder: ${JSON.stringify(join(h.work, '_tools_', 'some-tool'))} }),
        })
        const { session } = await opened.json()
        const renamed = await fetch('/api/sessions/' + encodeURIComponent(session.id) + '/title', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'a renamed conversation' }),
        })
        const body = await renamed.json()
        return JSON.stringify({ status: renamed.status, title: body.title, id: session.id })
      })()`),
    )
    assert.equal(titled.status, 200, 'a conversation can be retitled')
    assert.equal(titled.title, 'a renamed conversation', 'and the meta record carries the new title')

    // The refusal cases, because a rename that silently does nothing is worse than one that refuses.
    const refused = JSON.parse(
      await browser.evaluate(`(async () => {
        const blank = await fetch('/api/workspaces/' + encodeURIComponent(${JSON.stringify(h.work)}), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '   ' }),
        })
        const missing = await fetch('/api/sessions/session-00000000-0000-0000-0000-000000000000/title', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'nowhere' }),
        })
        return JSON.stringify({ blank: blank.status, missing: missing.status })
      })()`),
    )
    assert.equal(refused.blank, 400, 'an empty name is refused rather than saved')
    assert.equal(refused.missing, 404, 'and a session that does not exist is not invented')

    await browser.evaluate(
      `[...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label').textContent === '_tools_').click()`,
    )
    await browser.waitFor(`![...document.querySelectorAll('#tree .row')].some((entry) => entry.querySelector('.label').textContent === 'some-tool')`, 20_000)
    const toolsClosed = JSON.parse(await browser.evaluate(disclosure('_tools_')))
    assert.equal(toolsClosed.glyph, 'closed', 'and closes the same way')
    assert.equal(toolsClosed.expanded, 'false', 'with the state on the tree item')
    assert.equal(toolsClosed.children, 0, 'leaving no group behind')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a folder nobody registered is adopted as ad hoc, and registering it promotes it into the tree', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  /**
   * The distinction this judges is a view rather than a mechanism: `bootstrap` adopts every folder a
   * session ran in so that "every session has a root" stays true, but a folder adopted that way is
   * not a project a person named. The tree lists the chosen ones; the adopted ones are reported
   * apart, and registering one moves it — and its sessions — with no file moving and no id changing.
   */
  const h = harness('adhoc')
  const loose = fixtureDir('adhoc-loose')
  try {
    mkdirSync(loose, { recursive: true })
    const run = await runCli([...h.args, '--turn', 'work somewhere nobody registered'], { env: h.env, cwd: loose })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)

    const before = parseJson((await runCli([...h.args, 'tree', '--json'], { env: h.env })).stdout)
    const adopted = (before.adHoc ?? []).map((node) => node.path)
    assert.ok(
      adopted.some((path) => path.endsWith(loose.split('/').filter(Boolean).pop())),
      `the folder the session ran in is reported as ad hoc rather than as a project\nsaw: ${adopted.join(', ')}`,
    )
    assert.ok(
      !(before.children ?? []).some((node) => node.path.endsWith(loose.split('/').filter(Boolean).pop())),
      'and it is not in the tree a person reads as their projects',
    )

    const added = await runCli([...h.args, 'workspace', 'add', loose, '--json'], { env: h.env })
    assert.equal(added.code, 0, `registering it succeeded\n${added.stdout}${added.stderr}`)

    const after = parseJson((await runCli([...h.args, 'tree', '--json'], { env: h.env })).stdout)
    const inTree = (after.children ?? []).map((node) => node.path)
    assert.ok(
      inTree.some((path) => path.endsWith(loose.split('/').filter(Boolean).pop())),
      `registering it promoted it into the tree\nsaw: ${inTree.join(', ')}`,
    )
    assert.ok(
      !(after.adHoc ?? []).some((node) => node.path.endsWith(loose.split('/').filter(Boolean).pop())),
      'and it is no longer ad hoc',
    )
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(loose)
  }
})

test('a workspace is unregistered, and a root that still holds sessions is refused', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  /**
   * Removal is judged by its answer rather than by the file: a root that still holds sessions and has
   * no root above it would be re-registered by `bootstrap` on the next run, so the command refuses
   * and says why — and with a parent above it, or with nothing under it, it goes.
   */
  const h = harness('remove')
  const empty = fixtureDir('remove-empty')
  const busy = fixtureDir('remove-busy')
  const parent = fixtureDir('remove-parent')
  const child = join(parent, 'child')
  try {
    for (const path of [empty, busy, child]) mkdirSync(path, { recursive: true })

    assert.equal((await runCli([...h.args, 'workspace', 'add', empty], { env: h.env })).code, 0, 'the empty one registered')
    const removed = await runCli([...h.args, 'workspace', 'remove', empty], { env: h.env })
    assert.equal(removed.code, 0, `an empty root is removed\n${removed.stdout}${removed.stderr}`)
    assert.equal((await runCli([...h.args, 'workspaces', '--json'], { env: h.env })).stdout.includes(empty), false, 'and it is gone')

    await runCli([...h.args, 'workspace', 'add', busy], { env: h.env })
    const turn = await runCli([...h.args, '--turn', 'a session that keeps this root alive'], { env: h.env, cwd: busy })
    assert.equal(turn.code, 0, `the session ran in it\n${turn.stdout}${turn.stderr}`)
    const refused = await runCli([...h.args, 'workspace', 'remove', busy], { env: h.env })
    assert.notEqual(refused.code, 0, 'a root that still holds sessions is refused')
    assert.match(`${refused.stdout}${refused.stderr}`, /still holds \d+ session/, 'and the refusal says why')

    await runCli([...h.args, 'workspace', 'add', parent], { env: h.env })
    await runCli([...h.args, 'workspace', 'add', child], { env: h.env })
    const inner = await runCli([...h.args, '--turn', 'a session under the child root'], { env: h.env, cwd: child })
    assert.equal(inner.code, 0, `a session ran under the child\n${inner.stdout}${inner.stderr}`)
    const adopted = await runCli([...h.args, 'workspace', 'remove', child], { env: h.env })
    assert.equal(adopted.code, 0, `a root with a parent above it is removed\n${adopted.stdout}${adopted.stderr}`)
    assert.match(`${adopted.stdout}${adopted.stderr}`, /adopted by/, 'and it reports where its sessions went')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(empty)
    removeDir(busy)
    removeDir(parent)
  }
})

test('New session here, on an instance row, starts a session and writes its definition', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('new-session-here')
  let live
  let browser
  try {
    await conventionsFixture(h)
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    /**
     * The owner asked whether this menu item works, and it did not: it called the route that starts a
     * transcript, so the click created a session with **no definition** — invisible in the tree, because
     * the tree finds a session by the `_sessions_` instance that names it. This is the whole user action,
     * judged as a user performs it: open the row's menu, click the item, and look for what appeared.
     */
    const clicked = await browser.evaluate(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const rowFor = (label) => [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label')?.textContent === label)
      const root = [...document.querySelectorAll('#tree .row')][0]
      root.click()
      await wait(600)
      rowFor('_tools_').click()
      await wait(700)
      const instance = rowFor('some-tool')
      const menu = [...instance.querySelectorAll('button')].find((button) => button.textContent === '…')
      if (menu === undefined) return JSON.stringify({ error: 'the instance row carries no menu' })
      menu.click()
      await wait(200)
      const item = [...document.querySelectorAll('#tree .menu:not([hidden]) button')].find((button) => button.textContent === 'New session here')
      if (item === undefined) return JSON.stringify({ error: 'the menu carries no New session here item' })
      item.click()
      await wait(1800)
      const reopened = rowFor('some-tool')
      if (reopened.parentElement.dataset.open !== 'true') {
        reopened.click()
        await wait(800)
      }
      const rows = [...reopened.parentElement.querySelectorAll(':scope > ul[role=group] > li')].map((child) => (child.dataset.kind === 'session' ? 'session' : child.dataset.kind) + ':' + child.querySelector('.label')?.textContent)
      return JSON.stringify({ rows, branchOpen: reopened.parentElement.dataset.open === 'true', selected: document.querySelector('#tree li[aria-selected="true"] > .row')?.querySelector('.label')?.textContent ?? null })
    })()`)
    const outcome = JSON.parse(clicked)
    assert.equal(outcome.error, undefined, `the menu opened and the item was there\\nsaw: ${clicked}`)
    /**
     * And the act leaves a **visible** result. Measured: the first version created the session correctly and
     * re-rendered the tree, and the owner reported that nothing happened — the branch the session appeared in
     * was closed, so the new row sat inside a closed folder. Opening the branch and selecting the new row is
     * the fix, and this is what pins it.
     */
    assert.equal(outcome.branchOpen, true, 'the branch is open when the tree comes back, so the new session is on screen')
    assert.equal(outcome.rows[0]?.startsWith('session:'), true, `the session appears first in the branch it belongs to\\nsaw: ${outcome.rows.join(', ')}`)
    const name = String(outcome.rows[0]).slice('session:'.length)
    assert.match(name, /^session-\d{8}-\d{4}$/, `named for the clock, as the convention requires\nsaw: ${name}`)

    const definition = join(h.work, '_tools_', 'some-tool', '_sessions_', name, 'session.json')
    assert.ok(existsSync(definition), `and its definition is on disk at ${definition}`)
    const fields = JSON.parse(readFileSync(definition, 'utf8'))
    assert.equal(fields.cwd, join(h.work, '_tools_', 'some-tool'), 'the definition names the folder the session is bound to')
    /**
     * And the **tree** says which conversation the row is, which is what makes clicking it open that
     * conversation rather than only expand a folder. Before this the node carried `session: null`, so a row
     * that named no session looked exactly like one that did.
     */
    const drawn = await treeAt(h, join(h.work, '_tools_', 'some-tool'))
    const sessionNode = (drawn.tree.children ?? []).find((node) => node.kind === 'session')
    assert.equal(sessionNode?.session?.id, fields.id, 'the row names the session its definition names')

    assert.ok(!isUnder(h.work, String(fields.log)), `while the transcript stays outside the repository\\nsaw: ${fields.log}`)
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a new session is filed under its workspace, and an old one keeps the shape it was born with', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('layout')
  try {
    await conventionsFixture(h)
    const created = await runCli(adminArgs(h, ['session', 'new', h.work, '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `the session was created\n${created.stdout}${created.stderr}`)
    const body = parseJson(created.stdout)

    /**
     * The owner's layout of 2026-10-11: `~/.heddle/sessions/<workspace>/<session-id>.jsonl`. The workspace
     * folder is the target folder's path with its separators turned into dashes and wrapped in `--…--`, so
     * a person opening the store sees the folders they worked in rather than a wall of opaque ids.
     */
    const workspaceFolder = join(h.home, 'sessions', `--${h.work.split('/').filter(Boolean).join('-')}--`)
    assert.ok(
      String(body.log).startsWith(`${workspaceFolder}/`),
      `the log is filed under its workspace\nsaw: ${body.log}\nwanted a path under: ${workspaceFolder}`,
    )
    assert.match(String(body.log), /\.v2\.jsonl\.zstd$|\.jsonl$/, 'and named for the session, with the format suffix the store writes')
    assert.ok(existsSync(`${workspaceFolder}/${body.session}.json`), 'the metadata sits beside it, named for the session')
    assert.ok(existsSync(String(body.log)), 'and the log itself exists')

    // Both layouts are read: a session written the old way is still a session.
    const legacy = join(h.home, 'sessions', 'session-00000000-0000-4000-8000-000000000001')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'meta.json'),
      `${JSON.stringify({ id: 'session-00000000-0000-4000-8000-000000000001', created: '2026-01-01T00:00:00.000Z', cwd: h.work, turns: 0 }, null, 2)}\n`,
    )
    writeFileSync(join(legacy, 'session.jsonl'), `${JSON.stringify({ seq: 0, at: '2026-01-01T00:00:00.000Z', type: 'session/created', cwd: h.work })}\n`)

    const listed = await sessionsOf(h)
    assert.ok(
      listed.some((meta) => meta.id === 'session-00000000-0000-4000-8000-000000000001'),
      `a session in the old layout is still listed\nsaw: ${listed.map((meta) => meta.id).join(', ')}`,
    )
    assert.ok(listed.some((meta) => meta.id === body.session), 'alongside the new one')
    const read = await runCli(adminArgs(h, ['transcript', 'session-00000000-0000-4000-8000-000000000001']), { env: h.env, cwd: h.work })
    assert.equal(read.code, 0, `and it still reads\n${read.stdout}${read.stderr}`)
    assert.match(read.stdout, /session\/created/, 'with its own log')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the panel follows the selection: a session offers two views, a file one, and a folder changes nothing', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('panel-follows-selection')
  let live
  let browser
  try {
    await conventionsFixture(h)
    /**
     * A real session, created by the CLI, because the three rules are about rows that stand for something:
     * a session row with a conversation behind it, a file with a document behind it, and a folder that is
     * only a folder.
     */
    const created = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `the session was created\n${created.stdout}${created.stderr}`)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    /**
     * `await`s the page's promise and stringifies **its** value. Measured the hard way: with the
     * `JSON.stringify` outside the call it stringifies the pending promise, which is `{}` — and a probe that
     * reads `{}` reports every field as undefined while looking like it worked.
     */
    const reading = JSON.parse(await browser.evaluate(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const rows = () => [...document.querySelectorAll('#tree .row')]
      const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
      const ring = () => [...document.querySelectorAll('#views button')].filter((b) => !b.hidden).map((b) => b.textContent)
      const current = () => document.querySelector('#tree li[aria-selected="true"] > .row')?.querySelector('.label')?.textContent ?? null
      const openState = (label) => rowFor(label)?.parentElement.dataset.open ?? null

      ;[...document.querySelectorAll('#tree .row')][0].click(); await wait(600)
      rowFor('_tools_').click(); await wait(700)
      rowFor('some-tool').click(); await wait(800)

      // 1. A session row is a leaf that shows its conversation, with two views.
      const sessionRow = rows().find((entry) => entry.parentElement.dataset.kind === 'session')
      if (sessionRow === undefined) return { error: 'no session row was drawn' }
      const sessionLabel = sessionRow.querySelector('.label').textContent
      sessionRow.click(); await wait(1200)
      const afterSession = { ring: ring(), current: current(), leaf: sessionRow.parentElement.querySelector(':scope > ul[role=group]') === null }

      /**
       * 2. A folder only opens and closes, and the panel is not retargeted.
       *
       * The folder clicked is an UNRELATED one — the second type folder, which holds nothing this
       * conversation touches. A folder that contains the selected row cannot judge this rule, because closing
       * it takes the row (and therefore its mark) off the screen no matter what the rule says.
       */
      const beforeFolder = { current: current(), ring: ring(), open: openState('_verifiers_') }
      rowFor('_verifiers_').click(); await wait(700)
      const afterFolder = { current: current(), ring: ring(), open: openState('_verifiers_') }
      rowFor('_verifiers_').click(); await wait(500)
      const closedAgain = openState('_verifiers_')

      // 3. A file is selected on its own: one tab, and it is the file's.
      rowFor('some-tool').click(); await wait(600)
      const fileRow = rows().find((entry) => entry.parentElement.dataset.kind === 'file')
      if (fileRow === undefined) return { error: 'no file row was drawn', afterSession, afterFolder }
      const fileLabel = fileRow.querySelector('.label').textContent
      fileRow.click(); await wait(1200)
      const afterFile = { ring: ring(), current: current() }

      return { sessionLabel, afterSession, beforeFolder, afterFolder, closedAgain, fileLabel, afterFile }
    })().then((value) => JSON.stringify(value))`))

    assert.equal(reading.error, undefined, `the fixture drew the rows the rules are about\nsaw: ${JSON.stringify(reading)}`)

    /** 1. A session is a leaf, and its two views are the two projections of a conversation. */
    assert.deepEqual(reading.afterSession.ring, ['Chat', 'Trajectory'], `a session offers its chat and its trajectory\nsaw: ${reading.afterSession.ring.join(', ')}`)
    assert.equal(reading.afterSession.leaf, true, 'and the row is a leaf: nothing to open under a session')
    assert.equal(reading.afterSession.current, reading.sessionLabel, 'and selecting it shows it')

    /** 2. A folder is navigation: it opens, it closes, and the panel is not retargeted. */
    assert.equal(
      reading.afterFolder.open,
      String(reading.beforeFolder.open !== 'true'),
      'clicking a folder flips it: an open folder closes and a closed one opens',
    )
    assert.equal(reading.closedAgain, reading.beforeFolder.open, 'and clicking it again puts it back')
    assert.equal(reading.afterFolder.current, reading.beforeFolder.current, `and neither click moves the selection\nsaw: ${reading.afterFolder.current}`)
    assert.deepEqual(reading.afterFolder.ring, reading.beforeFolder.ring, 'nor changes which views are offered')

    /** 3. A file is shown on its own: one tab, no session views. */
    assert.deepEqual(reading.afterFile.ring, ['File'], `a file offers its preview and nothing else\nsaw: ${reading.afterFile.ring.join(', ')}`)
    assert.equal(reading.afterFile.current, reading.fileLabel, 'and selecting it shows it')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the page wears the project icon, and its name sits above the workspaces', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('brand')
  let live
  let browser
  try {
    await conventionsFixture(h)
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )

    /**
     * The icon is served **before** authentication, deliberately: a browser asks for a favicon as a request of its
     * own, and DSH's own page links one the same way. The counterpart is asserted in the same breath, because a route
     * opened without a token must not have opened anything else — the API is still refused. That is another part's
     * claim (part 90), restated here so this part's route cannot quietly weaken it.
     */
    const icon = await fetch(new URL('/favicon.svg', live.url))
    assert.equal(icon.status, 200, 'the icon is served')
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml', 'as an SVG, which is what the link declares')
    assert.match(await icon.text(), /^<svg[\s>]/, 'and the bytes are a drawing')
    const api = await fetch(new URL('/api/sessions', live.url))
    assert.equal(api.status, 401, 'while the API is still refused without a token')

    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        await wait(400)
        const link = document.querySelector('link[rel="icon"]')
        const mark = document.getElementById('brand-mark')
        const name = document.getElementById('brand-name')
        const brand = document.getElementById('brand')
        const workspaces = document.querySelector('aside h1')
        const style = getComputedStyle(name)
        return JSON.stringify({
          title: document.title,
          href: link && link.getAttribute('href'),
          type: link && link.getAttribute('type'),
          decoded: mark ? mark.naturalWidth : 0,
          drawn: mark ? Math.round(mark.getBoundingClientRect().width) : 0,
          wordmark: name.textContent.trim(),
          font: style.fontFamily,
          brandBottom: Math.round(brand.getBoundingClientRect().bottom),
          workspacesTop: Math.round(workspaces.getBoundingClientRect().top),
        })
      })()`),
    )

    assert.equal(reading.title, 'Heddle', 'the tab names the project')
    assert.equal(reading.href, '/favicon.svg', 'and declares the icon')
    assert.equal(reading.type, 'image/svg+xml', 'as an SVG')
    assert.ok(reading.decoded > 0, 'the mark the page draws is decoded, not a broken reference')
    /**
     * The mark is drawn small whatever the file's own size is: the asset is 560 units and a brand row is not.
     */
    assert.ok(reading.drawn > 0 && reading.drawn <= 32, `the mark is drawn at a row's size, not the file's (${reading.drawn}px)`)
    assert.equal(reading.wordmark, 'Heddle', 'the name is text, so it is readable and selectable')
    assert.match(reading.font, /serif/i, 'set in a face chosen for it rather than inherited from the UI')
    /**
     * Above the workspaces, which is the owner's placement and DSH's: a brand row at the top of the sidebar, and the
     * navigation under it.
     */
    assert.ok(
      reading.brandBottom <= reading.workspacesTop + 1,
      `the brand sits above the workspaces\nsaw brand bottom ${reading.brandBottom}, workspaces top ${reading.workspacesTop}`,
    )
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is renamed from its own menu, and the row and its definition follow', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-rename')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const created = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `the session was created\n${created.stdout}${created.stderr}`)
    const made = parseJson(created.stdout)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        ;[...document.querySelectorAll('#tree .row')][0].click(); await wait(600)
        rowFor('_tools_').click(); await wait(700)
        rowFor('some-tool').click(); await wait(800)
        const sessionRow = rows().find((entry) => entry.parentElement.dataset.kind === 'session')
        if (sessionRow === undefined) return { error: 'no session row' }
        const label = sessionRow.querySelector('.label').textContent
        const menu = [...sessionRow.querySelectorAll('button')].find((button) => button.textContent === '…')
        if (menu === undefined) return { error: 'the session row carries no menu', label }
        menu.click(); await wait(250)
        const items = [...document.querySelectorAll('#tree .menu:not([hidden]) button')].map((button) => button.textContent)
        /** The prompt is stubbed, so the whole handler runs — the fetch, the redraw and the label — without a dialog. */
        window.prompt = () => 'a session with a name'
        const item = [...document.querySelectorAll('#tree .menu:not([hidden]) button')].find((button) => button.textContent === 'Rename')
        if (item === undefined) return { error: 'no rename item', items }
        item.click(); await wait(1800)
        const after = rows().find((entry) => entry.parentElement.dataset.kind === 'session')
        return { label, items, renamed: after.querySelector('.label').textContent, folder: after.title }
      })().then((value) => JSON.stringify(value))`),
    )

    assert.equal(reading.error, undefined, `the session row offers its menu\nsaw: ${JSON.stringify(reading)}`)
    /**
     * DSH's names, verbatim — that is the parity claim, so the check names all four rather than just the one it clicks.
     * A menu that drifts back to `Pin` / `Rename…` / `Fork` / `Archive` is a menu nobody who knows DSH recognises.
     */
    assert.deepEqual(
      reading.items,
      ['Pin session', 'Rename', 'Fork session', 'Archive session'],
      `the menu reads what DSH's reads\nsaw: ${reading.items.join(', ')}`,
    )
    assert.match(reading.label, /^session-\d{8}-\d{4}$/, 'the row starts with the folder name, because nothing has named it yet')
    assert.equal(reading.renamed, 'a session with a name', 'after the rename the row shows the name it was given')
    assert.equal(reading.folder, join(h.work, '_tools_', 'some-tool', '_sessions_', reading.label), 'while the folder stays reachable as the tooltip, because it is the identity')

    /** Both halves hold the new name: the store the UI reads, and the definition a reader of the repository reads. */
    const listed = await sessionsOf(h)
    assert.equal(listed.find((meta) => meta.id === made.session)?.title, 'a session with a name', 'the store holds the title')
    const definition = JSON.parse(readFileSync(join(String(made.definition).replace('/session.json', ''), 'session.json'), 'utf8'))
    assert.equal(definition.title, 'a session with a name', 'and so does the definition, so the tracked record does not disagree')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is pinned and archived in the store, and the tree follows both', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-flags')
  let live
  try {
    await conventionsFixture(h)
    const created = []
    for (let index = 0; index < 2; index += 1) {
      const one = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
      created.push(parseJson(one.stdout))
    }
    const [newer, older] = created
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    /** The launch token becomes a cookie on a redirect; an authenticated caller is the cookie, not the token. */
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    const commit = (id, patch) =>
      fetch(new URL(`/api/sessions/${id}/flags`, live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
    const branch = new URL(`/api/tree?path=${encodeURIComponent(join(h.work, '_tools_', 'some-tool'))}`, live.url)
    const listed = async (withArchived) => {
      const url = new URL(branch)
      if (withArchived) url.searchParams.set('archived', '1')
      const body = await (await fetch(url, { headers: { cookie } })).json()
      return (body.children ?? []).filter((node) => node.kind === 'session')
    }

    /**
     * **Pin** holds a session at the top of its branch. DSH's session menu has the item, and its list puts a
     * pinned session above the ones that merely came later.
     */
    const pin = await commit(older.session, { pinned: true })
    assert.equal(pin.status, 200, 'the pin was accepted')
    const pinned = await listed(false)
    assert.equal(pinned[0]?.label, older.name, `the pinned session is first\nsaw: ${pinned.map((node) => node.label).join(', ')}`)
    assert.equal(pinned[0]?.pinned, true, 'and says it is pinned')
    assert.ok(!pinned.some((node) => node.label === newer.name && node.pinned === true), 'the other one is not pinned')

    /**
     * **Archive** takes a session out of the tree without touching its log — which is why this is the act the
     * menu offers and deleting is not — and `?archived=1` is the way back.
     */
    const archive = await commit(older.session, { archived: true })
    assert.equal(archive.status, 200, 'the archive was accepted')
    const withoutArchived = await listed(false)
    assert.ok(!withoutArchived.some((node) => node.label === older.name), 'an archived session is not drawn by default')
    const withArchived = await listed(true)
    const back = withArchived.find((node) => node.label === older.name)
    assert.equal(back?.archived, true, 'and is drawn when asked for, marked as archived')
    assert.equal(back?.pinned, true, 'with its pin intact')

    /** The flags live in the store alone: the definition a reader of the repository sees never claims them. */
    const definition = JSON.parse(readFileSync(join(String(older.definition).replace('/session.json', ''), 'session.json'), 'utf8'))
    assert.equal(definition.pinned, undefined, 'the definition does not carry the pin')
    assert.equal(definition.archived, undefined, 'nor the archive')

    /**
     * The archive filter is a **mode**, not a flag — DSH offers three states and two cannot express the third.
     * `only` is the state a person reaches for when a session has vanished, so it has to answer.
     */
    const onlyArchived = async () => {
      const url = new URL(branch)
      url.searchParams.set('archived', 'only')
      const body = await (await fetch(url, { headers: { cookie } })).json()
      return (body.children ?? []).filter((node) => node.kind === 'session')
    }
    const only = await onlyArchived()
    assert.deepEqual(only.map((node) => node.label), [older.name], `archived only draws the archived sessions, and none of the live ones\nsaw: ${only.map((node) => node.label).join(', ')}`)

    /** And both are reversible, which is what makes them safe items in a menu. */
    await commit(older.session, { archived: false, pinned: false })
    const restored = await listed(false)
    assert.ok(restored.some((node) => node.label === older.name), 'unarchiving brings it back')
    assert.equal(restored.find((node) => node.label === older.name)?.pinned, undefined, 'and unpinning leaves no mark')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session forks into a new one named after it, with its conversation and its own definition', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork')
  let live
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    /** A turn, because a fork copies a conversation and an empty one proves nothing. */
    await runCli(adminArgs(h, ['--turn', 'a conversation worth continuing']), { env: h.env, cwd: branch })

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const forked = await (
      await fetch(new URL(`/api/sessions/${made.session}/fork`, live.url), { method: 'POST', headers: { cookie } })
    ).json()

    assert.notEqual(forked.session, made.session, 'the fork is a session of its own')
    assert.ok(existsSync(String(forked.definition)), 'and has a definition of its own on disk')

    /**
     * DSH's naming, observed on 2026-10-17: `<title> (1)`, and the view does not follow it. The folder keeps the
     * conventions' instance naming rule, which is why the definition's folder name is a clock name while the title
     * is the name a person reads.
     */
    const listed = await sessionsOf(h)
    const title = listed.find((meta) => meta.id === made.session)?.title ?? ''
    assert.ok(title.length > 0, 'the source session has a title to fork from')
    assert.equal(listed.find((meta) => meta.id === forked.session)?.title, `${title} (1)`, 'the fork is named after it, with an ordinal')

    const definition = JSON.parse(readFileSync(String(forked.definition), 'utf8'))
    assert.equal(definition.cwd, branch, 'bound to the folder its parent worked in')
    assert.equal(definition.title, `${title} (1)`, 'and the definition says the same name')

    /** The conversation came with it: the same user messages, in the same order. */
    const source = await runCli(adminArgs(h, ['transcript', made.session]), { env: h.env, cwd: h.work })
    const copy = await runCli(adminArgs(h, ['transcript', forked.session]), { env: h.env, cwd: h.work })
    const said = (text) => (text.stdout.match(/a conversation worth continuing/g) ?? []).length
    assert.ok(said(source) >= 1, 'the source holds the turn')
    assert.equal(said(copy), said(source), 'and the fork holds the same one')

    const tree = await (await fetch(new URL(`/api/tree?path=${encodeURIComponent(branch)}`, live.url), { headers: { cookie } })).json()
    const labels = (tree.children ?? []).filter((node) => node.kind === 'session').map((node) => node.label)
    assert.ok(labels.includes(forked.name), 'the tree draws the fork beside its parent')
    assert.ok(labels.length >= 2, 'and the parent is still there')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a session row's controls appear on hover, and a search replaces the tree with named hits", async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-hover-search')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    /** Two sessions with the same first message, which is what makes a search result ambiguous without its age. */
    for (let index = 0; index < 2; index += 1) {
      const one = await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })
      assert.equal(one.code, 0, one.stderr)
      await runCli(adminArgs(h, ['--turn', 'the same opening line']), { env: h.env, cwd: branch })
    }

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        ;[...document.querySelectorAll('#tree .row')][0].click(); await wait(700)
        rowFor('_tools_').click(); await wait(700)
        rowFor('some-tool').click(); await wait(900)
        /**
         * The tree's ARIA shape, read from DSH's own: a row that can open carries aria-expanded, a row that can be
         * chosen carries aria-selected and NO aria-expanded (its session rows have aria-selected only), and exactly
         * one row is chosen at a time. No backticks here: this comment lives inside a template literal.
         */
        const ariaShape = () => {
          const sessionItems = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          const workspaceItems = [...document.querySelectorAll('#tree li[data-kind="workspace"]')]
          return {
            chosen: sessionItems.filter((li) => li.getAttribute('aria-selected') === 'true').length,
            hasSelected: sessionItems.every((li) => li.hasAttribute('aria-selected')),
            leafExpanded: sessionItems.filter((li) => li.hasAttribute('aria-expanded')).length,
            workspaceExpanded: workspaceItems.every((li) => li.hasAttribute('aria-expanded')),
            workspaceSelected: workspaceItems.filter((li) => li.hasAttribute('aria-selected')).length,
          }
        }
        const sessions = [...document.querySelectorAll('#tree li[data-kind="session"]')]
        const controls = sessions.map((li) => ({
          label: li.querySelector(':scope > .row > .label')?.textContent,
          slots: [...li.querySelectorAll(':scope > .row .row-tools > *')].map((child) => child.className),
          buttons: [...li.querySelectorAll(':scope > .row .session-actions button')].map((b) => b.getAttribute('aria-label')),
          /**
           * Not hovered yet: DSH keeps the row quiet until the pointer arrives. The rule lives on the **slot** that
           * holds the controls, because they are absolutely placed in the age's space rather than beside it.
           */
          quiet: li.querySelector(':scope > .row .row-tools') === null ? null : getComputedStyle(li.querySelector(':scope > .row .row-tools')).opacity,
        }))
        /**
         * A pointer cannot be moved from script, so the rule is read through its **other half**: the same selector
         * also answers the focus-within selector, and focusing a control in the row is what a keyboard user does.
         */
        const target = sessions.find((li) => li.querySelector(':scope > .row .session-actions button') !== null) ?? sessions[0]
        target.querySelector(':scope > .row .session-actions button')?.focus()
        await wait(200)
        const focused = {
          opacity: getComputedStyle(target.querySelector(':scope > .row .row-tools')).opacity,
          ageOpacity: (() => { const age = target.querySelector(':scope > .row > .age'); return age === null ? null : getComputedStyle(age).opacity })(),
          buttons: [...target.querySelectorAll(':scope > .row .session-actions button')].map((b) => b.getAttribute('aria-label')),
        }

        /**
         * The right-hand slot, measured the way it was measured in DSH: the age ends 8px inside the row, and the
         * controls sit in that same slot rather than beside it.
         */
        const quiet = target.querySelector(':scope > .row > .age')
        const rowRect = target.querySelector(':scope > .row').getBoundingClientRect()
        const ageRect = quiet === null ? null : quiet.getBoundingClientRect()
        const ageSlot = { rowRight: Math.round(rowRect.right), ageRight: ageRect === null ? null : Math.round(ageRect.right) }

        /** And a selection is DSH's: the same surface as a hover, no bar, no bold. */
        target.querySelector(':scope > .row').click(); await wait(1200)
        const selectedRow = target.querySelector(':scope > .row')
        const selected = {
          background: getComputedStyle(selectedRow).backgroundColor,
          shadow: getComputedStyle(selectedRow).boxShadow,
          weight: getComputedStyle(selectedRow.querySelector('.label')).fontWeight,
        }
        const quietBackground = (() => {
          const other = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li !== target)
          return other === undefined ? null : getComputedStyle(other.querySelector(':scope > .row')).backgroundColor
        })()

        /** DSH's View options control, where the archive filter lives: one control, three states, the current one marked. */
        const viewButton = document.querySelector('#view-options button')
        viewButton.click(); await wait(250)
        const viewItems = [...document.querySelectorAll('#view-options .menu:not([hidden]) button')].map((b) => ({
          label: b.textContent.trim(),
          checked: b.getAttribute('aria-checked'),
        }))
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await wait(100)

        const input = document.getElementById('session-search')
        input.value = 'the same opening'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(900)
        const search = {
          treeHidden: document.getElementById('tree').hidden,
          resultsHidden: document.getElementById('search-results').hidden,
          hits: [...document.querySelectorAll('#search-results .hit')].map((hit) => ({
            title: hit.querySelector('.hit-title')?.textContent,
            where: hit.querySelector('.hit-workspace')?.textContent,
          })),
        }
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(400)
        const cleared = {
          treeHidden: document.getElementById('tree').hidden,
          resultsHidden: document.getElementById('search-results').hidden,
        }
        return { controls, focused, ageSlot, selected, quietBackground, aria: ariaShape(), viewItems, search, cleared }
      })().then((value) => JSON.stringify(value))`),
    )

    /**
     * DSH's arrangement: a session row carries `Pin` and `Archive` beside its `…`, and they are **invisible until
     * the row is hovered or holds focus** — the row reads as a name rather than a strip of buttons.
     */
    /**
     * Two halves of one rule. A row that stands for a **session** offers its two quick controls; a `_sessions_`
     * folder the fixture wrote by hand holds no session record, so it offers nothing at all — a row with nothing to
     * do draws nothing rather than drawing dead buttons. (Measured: the first version of this check demanded the
     * controls on every row and failed on exactly those two.)
     */
    const withControls = reading.controls.filter((row) => row.buttons.length > 0)
    const withoutControls = reading.controls.filter((row) => row.buttons.length === 0)
    assert.equal(withControls.length, 2, `the two sessions carry controls\nsaw: ${JSON.stringify(reading.controls)}`)
    for (const row of withControls) {
      /**
       * DSH's arrangement, measured from its own row: the `…` first, then `Archive session`, then `Pin session`.
       * The order is the claim — the same three gestures in a different sequence is a translation a reader has to
       * perform — so both halves of it are asserted, the slot order and the order inside the slot.
       */
      assert.deepEqual(row.slots, ['menu-wrap', 'session-actions'], `the menu leads the quick controls\nsaw: ${JSON.stringify(row.slots)}`)
      assert.deepEqual(row.buttons, ['Archive session', 'Pin session'], `then archive, then pin\nsaw: ${JSON.stringify(row.buttons)}`)
      assert.equal(row.quiet, '0', 'and they are invisible while the row is quiet')
    }
    for (const row of withoutControls) {
      assert.equal(row.quiet, null, `a row that stands for no session draws no controls (${row.label})`)
    }
    assert.ok(
      reading.focused.opacity === '1',
      `focusing the row reveals them, which is the same rule the pointer gets\nsaw opacity ${reading.focused.opacity}`,
    )

    /**
     * The two rules the owner saw missing, judged as measurements rather than as impressions: the age is the row's
     * rightmost thing when the row is quiet, and the controls take its slot when it is not.
     */
    assert.ok(reading.ageSlot.ageRight !== null, 'the row carries an age to place')
    assert.ok(
      reading.ageSlot.rowRight - reading.ageSlot.ageRight <= 10 && reading.ageSlot.rowRight - reading.ageSlot.ageRight >= 4,
      `the age sits at the row's right edge, 8px inside it\nsaw row ${reading.ageSlot.rowRight}, age ${reading.ageSlot.ageRight}`,
    )
    assert.equal(reading.focused.ageOpacity, '0', 'and it steps aside when the controls arrive')

    /** Hover and selection differ by persistence, not by strength: the same surface, no bar, no bold. */
    assert.equal(reading.selected.background, reading.focused.background === undefined ? reading.selected.background : reading.focused.background)
    assert.ok(reading.selected.background !== reading.quietBackground, 'a selected row is tinted while a quiet one is not')
    assert.equal(reading.selected.shadow, 'none', 'with no left bar or shadow marking it')
    assert.equal(reading.selected.weight, '400', 'and its name keeps the list\'s normal weight')

    /**
     * DSH's ARIA shape for a tree of sessions: a chosen row is `aria-selected`, a leaf carries no `aria-expanded`, a
     * branch does, and only one row is chosen. Read after the click above, which chose a session row.
     */
    assert.equal(reading.aria.chosen, 1, `exactly one row is chosen\nsaw: ${reading.aria.chosen}`)
    assert.equal(reading.aria.hasSelected, true, 'every session row says whether it is chosen')
    assert.equal(reading.aria.leafExpanded, 0, 'and none of them claims to have something under it')
    assert.equal(reading.aria.workspaceExpanded, true, 'while a branch row carries aria-expanded')
    assert.equal(reading.aria.workspaceSelected, 0, 'and no chosen state, which is not what a branch has')

    /**
     * And a search **replaces** the tree with a flat list, as DSH does: each hit reads its name and where it lives.
     * The age is there because two sessions can share a first message, which is exactly this fixture.
     */
    assert.equal(reading.search.treeHidden, true, 'a query puts the tree away')
    assert.equal(reading.search.resultsHidden, false, 'and shows the results')
    assert.equal(reading.search.hits.length, 2, `both matching sessions are hits\nsaw: ${JSON.stringify(reading.search.hits)}`)
    for (const hit of reading.search.hits) {
      assert.equal(hit.title, 'the same opening line', 'a hit is named by its title')
      assert.match(String(hit.where), /·/, 'and says where it lives, beside its age')
    }
    /**
     * And the filter is one control with DSH's three states, named the way DSH names them — the labels are the
     * parity claim — with the current state carried by `aria-checked` rather than by a character in the name.
     */
    assert.deepEqual(
      reading.viewItems.map((item) => item.label),
      ['Hide archived', 'All conversations (show archived)', 'Archived only'],
      `View options reads what DSH's reads\nsaw: ${JSON.stringify(reading.viewItems)}`,
    )
    assert.equal(
      reading.viewItems.filter((item) => item.checked === 'true').length,
      1,
      `exactly one state is marked current\nsaw: ${JSON.stringify(reading.viewItems.map((item) => item.checked))}`,
    )

    assert.equal(reading.cleared.treeHidden, false, 'clearing the query restores the tree')
    assert.equal(reading.cleared.resultsHidden, true, 'and puts the results away')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the four session shortcuts act on the selected session, and say so when there is none', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-shortcuts')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const made = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, made.stderr)
    const created = parseJson(made.stdout)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        const sessions = () => [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.querySelector(':scope > .row > .label')?.textContent)
        /** One press helper, so every chord is dispatched the same way a keyboard would send it. */
        const press = (key, mods) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
          document.dispatchEvent(event)
          return event.defaultPrevented
        }
        rows()[0].click(); await wait(700)
        rowFor('_tools_').click(); await wait(700)
        rowFor('some-tool').click(); await wait(800)

        /** Nothing is selected: the chords that need a session refuse, and say why. */
        const beforeSelect = { note: '', prevented: press('a', { altKey: true, metaKey: true }) }
        await wait(200)
        beforeSelect.note = document.getElementById('tree-note').textContent

        /** Search needs no session and focuses its field. */
        const preventedSearch = press('k', { altKey: true, metaKey: true })
        await wait(150)
        const searchFocused = document.activeElement !== null && document.activeElement.id === 'session-search'
        document.getElementById('session-search').value = ''
        document.getElementById('session-search').dispatchEvent(new Event('input', { bubbles: true }))
        document.activeElement.blur()
        await wait(100)

        /** Rename: the chord reaches the row the panel is showing. */
        const sessionRow = [...document.querySelectorAll('#tree li[data-kind="session"]')][0]
        sessionRow.querySelector(':scope > .row').click()
        await wait(1200)
        window.prompt = () => 'a name from a chord'
        press('g', { altKey: true, metaKey: true })
        await wait(1600)
        const renamed = sessions()

        /** Fork: a second row appears named after the first. */
        press('f', { shiftKey: true, metaKey: true })
        await wait(1800)
        const forked = sessions()

        /** Archive: the selected row leaves the list. */
        press('a', { altKey: true, metaKey: true })
        await wait(1800)
        const archived = sessions()

        return {
          beforeSelect,
          preventedSearch,
          searchFocused,
          renamed,
          forked,
          archived,
        }
      })().then((value) => JSON.stringify(value))`),
    )

    /** A shortcut that needs a session says so instead of doing nothing silently. */
    assert.equal(reading.beforeSelect.prevented, true, 'the chord is claimed even when it cannot act')
    assert.match(String(reading.beforeSelect.note), /select a session first/, 'and the row note explains what it needs')

    /** ⌥⌘K reaches the search box, which is DSH\'s own chord for it. */
    assert.equal(reading.preventedSearch, true, 'the search chord is claimed')
    assert.equal(reading.searchFocused, true, 'and puts the cursor in the search box')

    /** ⇧⌘G renames, ⇧⌘F forks, ⌥⌘A archives — each on the selected session. */
    assert.ok(reading.renamed.includes('a name from a chord'), `the rename chord renamed the row\nsaw: ${JSON.stringify(reading.renamed)}`)
    assert.ok(
      reading.forked.some((label) => label.startsWith('a name from a chord (')),
      `the fork chord forked the session\nsaw: ${JSON.stringify(reading.forked)}`,
    )
    assert.ok(
      !reading.archived.includes('a name from a chord'),
      `the archive chord put the selected session away\nsaw: ${JSON.stringify(reading.archived)}`,
    )
    assert.ok(reading.archived.length >= 1, 'while its fork is still in the list')

    /** And the store agrees: the archived session is archived, not gone. */
    const listed = await sessionsOf(h)
    const archivedMeta = listed.find((meta) => meta.id === created.session)
    assert.equal(archivedMeta?.archived, true, 'the shortcut wrote the same flag the menu does')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session log downloads as decoded JSONL, named after the session', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('session-log-download')
  let live
  try {
    await conventionsFixture(h)
    const made = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, made.stderr)
    const created = parseJson(made.stdout)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')

    /** A title, through the route the page's rename uses, so the filename is derived from a person's text. */
    const titled = await fetch(new URL(`/api/sessions/${created.session}/title`, live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a log worth downloading', folder: dirname(created.definition) }),
    })
    assert.equal(titled.status, 200, 'the session was given a title')

    /**
     * DSH's header menu offers `Download session log`, and this is its route: the bytes a person gets must be the log
     * **decoded** — one JSON object per line — because the log on disk is a sequence of zstd frames nobody can read.
     */
    const response = await fetch(new URL(`/api/sessions/${created.session}/log`, live.url), { headers: { cookie } })
    assert.equal(response.status, 200, 'the log is served')
    assert.match(String(response.headers.get('content-type')), /application\/x-ndjson/, 'as newline-delimited JSON')
    const disposition = String(response.headers.get('content-disposition'))
    assert.match(disposition, /attachment/, 'as a download rather than a page')
    assert.match(disposition, new RegExp(`filename="${created.session}\\.jsonl"`), `with the id as the ASCII fallback\nsaw: ${disposition}`)
    assert.match(disposition, /filename\*=UTF-8''a%20log%20worth%20downloading\.jsonl/, `and the title in the encoded parameter\nsaw: ${disposition}`)

    const body = await response.text()
    /** Decoded, not the disk's zstd frames: a frame begins with the magic bytes 0x28 0xb5 0x2f 0xfd, JSON does not. */
    assert.ok(body.startsWith('{"seq":'), `the file is decoded JSON, not compressed frames\nsaw: ${JSON.stringify(body.slice(0, 24))}`)
    const lines = body.trimEnd().split('\n')
    assert.ok(lines.length >= 1, `the log has its events\nsaw ${lines.length} line(s)`)
    const events = lines.map((line) => JSON.parse(line))
    assert.ok(events.every((event) => typeof event.type === 'string'), 'every line is an event with a type')
    assert.ok(events.some((event) => event.type === 'session/created'), 'including the event that started it')
    assert.ok(!body.includes('\u0000'), 'and none of the compressed frames leaked into the file')

    /** A session that does not exist is refused rather than answered with an empty file. */
    const missing = await fetch(new URL('/api/sessions/session-00000000-0000-4000-8000-000000000000/log', live.url), { headers: { cookie } })
    assert.equal(missing.status, 404, 'a missing session is a 404')
    const malformed = await fetch(new URL('/api/sessions/not-an-id/log', live.url), { headers: { cookie } })
    assert.equal(malformed.status, 400, 'and a name that is not a session id is a 400')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})
