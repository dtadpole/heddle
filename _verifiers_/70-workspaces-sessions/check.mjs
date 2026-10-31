/**
 * NOTE FOR WHOEVER EDITS THIS FILE: the in-page scripts are passed as **template literals**, so a backtick inside one of
 * them ends the string and the file stops parsing. That mistake has cost five debugging rounds; write quotes or plain
 * words in those comments, never backticks.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'

import { decodeTranscript } from '../../src/session/transcript.ts'
import { chatDouble, fixtureDir, heddleCommand, httpConfig, isolatedHome, isTitleRequest, parseJson, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'

/**
 * Whether `child` sits outside `parent`, **spelled independently of the implementation** (`src/paths.ts`
 * has its own `isUnder`).
 *
 * The verifier used to ask that function whether the implementation had kept a transcript out of the
 * repository — a check that agrees with the rule it is judging cannot catch the rule being wrong, and
 * this rule has a trap (`/a/b-sibling` shares every character of `/a/b`). The implementation's rule is
 * pinned by component tests in `test/paths.test.ts`; the verifier spells its comparison itself.
 */
function isOutside(parent, child) {
  const canonical = (value) => {
    const absolute = resolve(value)
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
  const from = canonical(parent)
  const to = canonical(child)
  return to !== from && !to.startsWith(from.endsWith(sep) ? from : from + sep)
}

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

/**
 * Whether the harness serves the Web UI — asked by every check here that starts `web`.
 *
 * A check that starts the server and probes only the commands would fail, not skip, on a build that answers
 * `workspaces` and `sessions` before it serves the page; that failure would be about `web`, not about this part.
 */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /^\s{2}web\b/m.test(help.stdout)
}

/** Whether the harness runs a turn from the command line — asked by every check here that drives `--turn`. */
async function supportsTurn() {
  const help = await runCli(['--help'])
  return /--turn/.test(help.stdout)
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

/**
 * A local chat endpoint that streams each answer as **several deltas**, one SSE frame per fragment, and keeps every
 * request body it was sent.
 *
 * The scripted endpoint cannot stand in here: it yields a step's whole text as one text-delta, so a session it wrote
 * holds one delta per answer and the defect below cannot appear. A provider splits an answer wherever its stream does,
 * and this double does the same on purpose.
 */
async function fragmentingChatDouble(answers) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      /** A new session's title request is not one of the turns this double answers in order (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      requests.push(body)
      const fragments = answers[Math.min(requests.length, answers.length) - 1]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const content of fragments) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/ds`,
    requests,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise())
        server.closeAllConnections()
      }),
  }
}

test('a resumed session sends an earlier streamed answer back as one piece of text, not one line per fragment', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * Live-testing draft developer-five-2, measured on both builds: an answer that streamed as several deltas was derived
   * from the log as one text part per delta, and the chat adapter joins text parts with a newline, so every later
   * request handed the model its own earlier answer broken wherever the stream split it ("value\n-\n6"). DSH assembles a
   * stream per block (dsh-llm BlockAssembler.push appends every text delta of a block to one partial), so the model
   * gets its answer back as it wrote it. The first answer here streams as four fragments; the second turn's request is
   * read off the wire.
   */
  const fragments = ['The word ', 'you asked ', 'me to remember is lo', 'om.']
  const double = await fragmentingChatDouble([fragments, ['noted']])
  const h = harness('whole-answer')
  const config = httpConfig({ home: h.home, baseUrl: double.baseUrl })
  const env = { HEDDLE_HOME: h.home, HEDDLE_CONFIG: config }
  try {
    const first = await runCli([...h.args, '--turn', 'remember the word loom'], { env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(id, 'the first run created a session')
    const deltas = readTranscript(join(h.home, 'sessions', id)).filter(
      (event) => event.type === 'assistant/chunk' && event.chunk?.type === 'text-delta',
    )
    assert.deepEqual(
      deltas.map((event) => event.chunk.text),
      fragments,
      'the answer reached the session as the four fragments it streamed in, one logged delta each (the log is unchanged)',
    )

    const second = await runCli([...h.args, '--turn', 'what was the word', '--resume', id], { env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)
    assert.equal(double.requests.length, 2, 'each turn made one model call')
    const sent = parseJson(double.requests[1])
    const answers = (sent?.messages ?? []).filter((message) => message.role === 'assistant')
    assert.deepEqual(
      answers.map((message) => message.content),
      [fragments.join('')],
      `the second request carries the first answer once, whole, with no line break where the stream split it\nsent: ${JSON.stringify(answers)}`,
    )
  } finally {
    await double.close()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the record is appended to, never rewritten', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

test('a letter-case variant of a registered folder is that workspace, and a session started there lists under it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('case')
  /**
   * One folder is one workspace however it is spelled. DSH stores `fs.realpath` of the path and compares strings
   * (`dsh-workspace/README.md:93`, "one record per canonical path"); the native `realpath` answers with the spelling
   * the disk stores, so on a case-insensitive volume — macOS by default — `proj` and `PROJ` are one record. The same
   * canon is why a symlink to a registered folder collides with it rather than becoming a second workspace: that is
   * DSH's rule too, not a gap. Skipped on a case-sensitive volume, where the two spellings are two folders.
   */
  const proj = join(h.work, 'proj')
  const variant = join(h.work, 'PROJ')
  try {
    mkdirSync(proj, { recursive: true })
    if (!skipUnless(context, existsSync(variant), 'this volume is case-sensitive, so the two spellings are two folders')) return
    const first = await runCli(adminArgs(h, ['workspace', 'add', proj, '--json']), { env: h.env, cwd: h.work })
    assert.equal(first.code, 0, `registering the folder worked\n${first.stdout}${first.stderr}`)
    assert.equal(parseJson(first.stdout).created, true, 'and created its workspace')

    const again = await runCli(adminArgs(h, ['workspace', 'add', variant, '--json']), { env: h.env, cwd: h.work })
    assert.equal(again.code, 0, `registering the other spelling is not an error\n${again.stdout}${again.stderr}`)
    const record = parseJson(again.stdout)
    assert.equal(record.created, false, `it reports the workspace already there\nsaw: ${JSON.stringify(record)}`)
    assert.equal(record.path, proj, 'under the spelling the disk stores')

    const created = await runCli(adminArgs(h, ['session', 'new', variant, '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `a session starts at the other spelling\n${created.stdout}${created.stderr}`)
    const session = parseJson(created.stdout).session

    const workspaces = await workspacesOf(h)
    const spellings = workspaces.filter((workspace) => String(workspace.path).toLowerCase() === proj.toLowerCase())
    assert.deepEqual(
      spellings.map((workspace) => workspace.path),
      [proj],
      `one folder is one workspace\nsaw: ${workspaces.map((workspace) => workspace.path).join(', ')}`,
    )
    assert.ok((spellings[0]?.sessions ?? []).includes(session), `and the session started at ${variant} lists under it`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the nearest registered root owns a session when roots nest', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

test('a symlink to a folder lists as a folder at its own path, and opening it lists its target, as DSH lists one', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  /**
   * DSH's workspace listing reports what a child resolves to and keeps it at its own path (dsh-api-workspace-files: a
   * symlink reports the type of its destination, a size only for a regular file, a child's path is the listing's joined
   * with its name; list follows a final directory link inside the root). Measured on both builds before this check
   * (live-testing draft developer-six-2): the link was a file of 0 bytes (TS) or of the folder entry's size (Rust) at
   * its target's path, so it could not be expanded and two rows shared one path.
   */
  const h = harness('symlink')
  try {
    entry(join(h.work, 'nest', 'a.txt'), 'hello\n')
    entry(join(h.work, 'plain.txt'), 'x\n')
    const { symlinkSync } = await import('node:fs')
    symlinkSync('nest', join(h.work, 'nest-link'))
    symlinkSync('plain.txt', join(h.work, 'file-link'))
    const added = await runCli(adminArgs(h, ['workspace', 'add', h.work]), { env: h.env, cwd: h.work })
    assert.equal(added.code, 0, `the fixture registered its own root\n${added.stdout}${added.stderr}`)
    const root = realpathSync(h.work)

    const { result, tree } = await treeAt(h, h.work)
    assert.equal(result.code, 0, `the tree ran\n${result.stdout}${result.stderr}`)
    const link = childOf(tree, 'nest-link')
    assert.ok(link, `the link is listed\nsaw: ${(tree.children ?? []).map((node) => node.label).join(', ')}`)
    assert.equal(link.kind, 'folder', `a link to a folder is a folder row\nsaw: ${JSON.stringify(link)}`)
    assert.equal(link.children, null, 'which can be expanded, like any folder nobody opened yet')
    assert.equal(link.bytes, undefined, 'and carries no size, as a folder does not')
    assert.equal(link.path, join(root, 'nest-link'), 'at its own path')
    const paths = (tree.children ?? []).map((node) => node.path)
    assert.equal(new Set(paths).size, paths.length, `no two rows share one path\nsaw: ${paths.join(', ')}`)
    const fileLink = childOf(tree, 'file-link')
    assert.equal(fileLink?.kind, 'file', 'a link to a file is a file row')
    assert.equal(fileLink?.bytes, 2, "with its target's size")

    const opened = await treeAt(h, link.path)
    assert.equal(opened.result.code, 0, `opening the link ran\n${opened.result.stdout}${opened.result.stderr}`)
    assert.deepEqual(
      (opened.tree.children ?? []).map((node) => `${node.kind}:${node.label}`),
      ['file:a.txt'],
      'and lists what its target holds',
    )
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a symlink that leads out of every root lists at its own path, and opening it is refused, through the Web API and the CLI', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  /**
   * The row of a link stays at the link's own path (the check above), so opening it asks for a path inside the root. What
   * refuses a link whose target no root owns is the containment check on the canonical path, the one the Web API and
   * the CLI make before they list anything ("the Web API's tree lists only what a workspace root holds"). DSH's list
   * confines the resolved path to the workspace root the same way (dsh-api-workspace-files list and confine,
   * workspace-file/outside-workspace). Judged here end to end: the row a person would click, then the click.
   */
  const h = harness('symlink-out')
  const root = fixtureDir('symlink-out-root')
  const outside = fixtureDir('symlink-out-target')
  let live
  try {
    entry(join(root, 'kept.txt'), 'inside\n')
    entry(join(outside, 'not-yours.txt'), 'outside\n')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, join(root, 'out-link'))
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      h.env,
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const call = async (path, init = {}) => {
      const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    }
    const added = await call('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `the root is registered (${JSON.stringify(added.body)})`)
    const treeOf = (path) => call(`/api/tree?path=${encodeURIComponent(path)}`)

    const level = await treeOf(root)
    assert.equal(level.status, 200, `the root lists (${JSON.stringify(level.body)})`)
    const link = childOf(level.body, 'out-link')
    assert.ok(link, `the link is listed\nsaw: ${(level.body.children ?? []).map((node) => node.label).join(', ')}`)
    assert.equal(link.kind, 'folder', `a link to a folder outside is still a folder row\nsaw: ${JSON.stringify(link)}`)
    assert.equal(link.path, join(realpathSync(root), 'out-link'), 'at its own path, inside the root')

    const opened = await treeOf(link.path)
    const listed = Array.isArray(opened.body?.children) ? opened.body.children.map((node) => node.label).join(', ') : ''
    assert.equal(opened.status, 400, `opening it through the Web API is refused, not listed (${opened.status}${listed ? `, listed: ${listed}` : ''})`)
    assert.deepEqual(opened.body, { error: `${realpathSync(outside)} is not under any workspace root` }, 'naming where the link lands')

    const cli = await treeAt(h, link.path, { cwd: root })
    assert.notEqual(cli.result.code, 0, `opening it through the CLI is refused too\n${cli.result.stdout}`)
    assert.match(`${cli.result.stdout}${cli.result.stderr}`, /not under any workspace root/, 'with the same rule')
    assert.doesNotMatch(cli.result.stdout, /not-yours\.txt/, 'and nothing of the target is printed')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
    removeDir(root)
    removeDir(outside)
  }
})

test('a file the 256 KiB cap cuts inside a character previews its whole characters, a literal U+FFFD is text, and only bytes that are not UTF-8 are refused', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  /**
   * Issue #78 (found by developer-two in both builds): the reader decoded the first 256 KiB lossily and refused any text
   * holding U+FFFD, so the preview answered 415 "is not UTF-8 text" for a valid file whose character the cap cut, and for
   * a valid file holding a literal U+FFFD. DSH decodes strictly and across chunk boundaries (dsh-fs-local
   * lib/index.js:451-470 with TextDecoder fatal at :454 and stream decoding at :342), refusing only content that is not
   * decodable UTF-8. Judged through both surfaces that call the reader: the preview route and the command line.
   */
  const h = harness('file-utf8-prefix')
  const CAP = 256 * 1024
  const notUtf8 = 'is not UTF-8 text, so it has no text to show'
  let live
  try {
    const added = await runCli(adminArgs(h, ['workspace', 'add', h.work]), { env: h.env, cwd: h.work })
    assert.equal(added.code, 0, `the fixture registered its root\n${added.stdout}${added.stderr}`)
    /** name, content, and the whole characters the preview keeps (undefined for a refusal). */
    const cases = [
      ['aligned.txt', `${'a'.repeat(CAP - 3)}中tail\n`, `${'a'.repeat(CAP - 3)}中`],
      ['accent-cut.txt', `${'a'.repeat(CAP - 1)}étail\n`, 'a'.repeat(CAP - 1)],
      ['wide-cut.txt', `${'a'.repeat(CAP - 1)}中tail\n`, 'a'.repeat(CAP - 1)],
      ['emoji-cut.txt', `${'a'.repeat(CAP - 2)}😀tail\n`, 'a'.repeat(CAP - 2)],
      ['replacement.txt', 'a literal \uFFFD is a character\n', 'a literal \uFFFD is a character\n'],
      ['invalid.txt', Buffer.from([...Buffer.from('valid, then '), 0xff, ...Buffer.from(' is not\n')]), undefined],
    ]
    for (const [name, content] of cases) entry(join(h.work, name), content)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    for (const [name, content, kept] of cases) {
      const path = join(h.work, name)
      const size = Buffer.byteLength(content)
      const response = await fetch(new URL(`/api/file?path=${encodeURIComponent(path)}`, live.url), { headers: { cookie } })
      const body = await response.json()
      const cli = await runCli(adminArgs(h, ['file', path, '--json']), { env: h.env, cwd: h.work })
      if (kept === undefined) {
        assert.equal(response.status, 415, `${name}: bytes that are not UTF-8 are refused (HTTP ${response.status})`)
        assert.ok(String(body.error).endsWith(`${realpathSync(path)} ${notUtf8}`), `${name}: with the reader's sentence\nsaw: ${body.error}`)
        assert.notEqual(cli.code, 0, `${name}: and refused on the command line`)
        assert.ok(cli.stderr.includes(notUtf8), `${name}: with the same sentence\nsaw: ${cli.stderr.slice(0, 300)}`)
        continue
      }
      const expected = { text: kept, truncated: size > CAP, bytes: size, kept: Buffer.byteLength(kept) }
      const seen = (reading) => ({ text: reading.text, truncated: reading.truncated, bytes: reading.bytes, kept: Buffer.byteLength(String(reading.text)) })
      assert.equal(response.status, 200, `${name}: the preview answers (HTTP ${response.status}: ${String(body.error ?? '').slice(0, 200)})`)
      assert.deepEqual(seen(body), expected, `${name}: the preview is the whole characters before the cap, and says when it is truncated`)
      assert.equal(cli.code, 0, `${name}: the command line reads it\n${cli.stderr.slice(0, 300)}`)
      assert.deepEqual(seen(parseJson(cli.stdout)), expected, `${name}: and gives the same reading`)
    }
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
    assert.ok(isOutside(h.work, body.log), `and the log is not in the repository\nsaw: ${body.log}`)

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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

test('a session interrupted mid-frame still reads, and its next turn lands', async (context) => {  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

test('a session one process is writing refuses a second writer, so its log never holds a seq twice', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * R-developer-eight-27, reproduced the way it was found: a running server held a session, the command line resumed
   * the same session with a turn, and both appended from their own in-memory count — the log held seqs 14 to 19
   * twice and each process showed a different history. DSH keeps one writer per session (a lock beside the log;
   * a second writer is refused with "session ... is already owned by an active write handle"), and so must this.
   *
   * The second half is the other order: a session the server has only **read** is written by the command line, and
   * the server's next write must continue after it rather than from the count it read before.
   */
  const h = harness('writer-lock')
  let live
  try {
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const webTurn = async (body) => {
      const response = await fetch(new URL('/api/turn', live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, text: await response.text() }
    }
    const said = (id) =>
      readTranscript(join(h.home, 'sessions', id))
        .filter((event) => event.type === 'message' && event.message?.role === 'user')
        .map((event) => event.message.content?.[0]?.text)
    const assertEverySeqOnce = (id, when) => {
      const seqs = readTranscript(join(h.home, 'sessions', id)).map((event) => event.seq)
      assert.deepEqual(seqs, seqs.map((_, index) => index), `${when}: every seq is written once, in order\nsaw: ${seqs.join(', ')}`)
    }

    /** The server starts the session with a turn of its own, so it is the session's writer. */
    const first = await webTurn({ prompt: 'remember the word loom', folder: h.work })
    assert.equal(first.status, 200, `the server's turn ran\n${first.text}`)
    assert.ok(!first.text.includes('event: error'), `and did not fail\n${first.text}`)
    const id = /"session":"(session-[^"]+)"/.exec(first.text)?.[1]
    assert.ok(id, `the turn names its session\n${first.text}`)
    const transcript = transcriptFile(join(h.home, 'sessions', id))
    const held = readFileSync(transcript)

    /** The command line resumes it while the server still runs: refused, in DSH's words, and nothing is written. */
    const cli = await runCli([...h.args, '--resume', id, '--turn', 'resumed from cli'], { env: h.env })
    assert.equal(cli.timedOut, false, `the refused turn returned\n${cli.stdout}${cli.stderr}`)
    assert.notEqual(cli.code, 0, `a second writer is refused while the server holds the session\n${cli.stdout}${cli.stderr}`)
    assert.ok(
      cli.stderr.includes(`session "${id}" is already owned by an active write handle`),
      `and the refusal says why\n${cli.stdout}${cli.stderr}`,
    )
    assert.ok(readFileSync(transcript).equals(held), 'and the refused writer appended nothing to the log')

    /** The server keeps writing the session it holds, from the log's own next seq. */
    const second = await webTurn({ session: id, prompt: 'resumed from web' })
    assert.equal(second.status, 200, `the server's next turn ran\n${second.text}`)
    assert.ok(!second.text.includes('event: error'), `and did not fail\n${second.text}`)
    assertEverySeqOnce(id, 'after a refused command-line turn and the next server turn')
    assert.deepEqual(said(id), ['remember the word loom', 'resumed from web'], 'the log holds one history: the server\'s two turns and nothing else')

    /** The other order: the command line writes a session the server has read but does not hold. */
    const started = await runCli([...h.args, '--turn', 'started on the command line', '--json'], { env: h.env })
    assert.equal(started.code, 0, `the command line started a session\n${started.stdout}${started.stderr}`)
    const other = parseJson(started.stdout)?.session
    assert.ok(typeof other === 'string' && other !== id, `a second session\n${started.stdout}`)
    const viewed = await fetch(new URL(`/api/sessions/${other}`, live.url), { headers: { cookie } })
    assert.equal(viewed.status, 200, 'the server reads the session')
    await viewed.text()
    const again = await runCli([...h.args, '--resume', other, '--turn', 'the command line again'], { env: h.env })
    assert.equal(again.code, 0, `reading does not hold a session, so the command line may still write it\n${again.stdout}${again.stderr}`)
    const continued = await webTurn({ session: other, prompt: 'the server continues it' })
    assert.equal(continued.status, 200, `the server's turn on it ran\n${continued.text}`)
    assert.ok(!continued.text.includes('event: error'), `and did not fail\n${continued.text}`)
    assertEverySeqOnce(other, 'after the server wrote a session the command line had written since the server read it')
    assert.deepEqual(
      said(other),
      ['started on the command line', 'the command line again', 'the server continues it'],
      'and the server\'s turn continued the history on disk rather than the one it had read',
    )
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a turn cut by a server restart reads as interrupted at once, and is closed in the log before the next turn', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * Issue #5, reproduced without a model: the scripted turn calls bash with a long sleep, and the server is killed
   * while the call runs (SIGKILL, the hardest form of a restart; the SIGTERM the issue used leaves the same log on both
   * builds). The log then ends at the call: no tool result, no answer record, no turn end. Before the fix the view drew
   * the call as running for good, after the restart and after every later turn.
   *
   * DSH closes such a turn when the session is next opened for writing, before anything else is appended: an
   * interrupted result for each open call, then the step's end and the turn's end (dsh-agent-loop, on attach for
   * writing; dsh-session openTurnClosers). Its cold read shows the same closers without writing them, so the page is
   * right from the first read after the restart (dsh-session-query readColdSessionLog).
   */
  const h = harness('turn-closers')
  const { script } = scriptedConfig({
    home: h.home,
    steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 20' } } }, { text: 'never reached' }],
  })
  const serverArgs = ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')]
  let live
  try {
    const made = await runCli(adminArgs(h, ['session', 'new', h.work, '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, `the session was created\n${made.stdout}${made.stderr}`)
    const id = parseJson(made.stdout)?.session
    assert.ok(typeof id === 'string', `the session has an id\n${made.stdout}`)
    const sessionDir = join(h.home, 'sessions', id)
    const connect = async () => {
      live = await startServer(serverArgs, { ...h.env, HOME: h.home })
      const handshake = await fetch(live.url, { redirect: 'manual' })
      return String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    }
    const isCall = (event) => event.type === 'assistant/chunk' && event.chunk?.type === 'tool-call' && event.chunk?.name === 'bash'

    /** The turn is started and not awaited: its request stays open while bash sleeps. */
    let cookie = await connect()
    const cut = fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: id, prompt: 'run the slow command, then say done' }),
    }).then((response) => response.text()).catch(() => '')
    let crashed = []
    for (let waited = 0; waited < 15_000; waited += 100) {
      crashed = readTranscript(sessionDir)
      if (crashed.some(isCall)) break
      await new Promise((done) => setTimeout(done, 100))
    }
    const callAt = crashed.findIndex(isCall)
    assert.ok(callAt >= 0, `the turn reached its bash call\n${crashed.map((event) => event.type).join(' ')}`)
    const callId = crashed[callAt].chunk.id
    live.kill()
    live = undefined
    await cut
    await new Promise((done) => setTimeout(done, 300))

    /** The fixture is the issue's log: it ends inside the turn, with the call unanswered. */
    crashed = readTranscript(sessionDir)
    const answered = (events) => events.some((event) => event.type === 'message' && event.message?.role === 'tool' && event.message.toolCallId === callId)
    assert.ok(!answered(crashed), `the killed server left the call unanswered\n${crashed.map((event) => event.type).join(' ')}`)
    assert.ok(!crashed.slice(callAt).some((event) => event.type === 'turn/completed'), 'and the turn without an end')
    const crashedBytes = readFileSync(transcriptFile(sessionDir))

    /** After the restart, the first read already shows the call interrupted and the turn ended, and writes nothing. */
    cookie = await connect()
    const view = async () => {
      const response = await fetch(new URL(`/api/sessions/${id}`, live.url), { headers: { cookie } })
      assert.equal(response.status, 200, 'the session is served')
      return (await response.json()).turns ?? []
    }
    const describe = (turns) => turns.map((turn) => `${turn.kind}:${turn.state ?? ''}`).join(' ')
    const first = await view()
    const row = first.find((turn) => turn.kind === 'tool' && turn.toolCallId === callId)
    assert.equal(row?.state, 'error', `after the restart the cut call is drawn as interrupted, not running\n${describe(first)}\n${JSON.stringify(row)}`)
    assert.match(String(row?.result ?? ''), /^error \(INTERRUPTED\)/, 'and its result says the turn ended before it answered')
    assert.ok(!first.some((turn) => turn.state === 'running'), `nothing is drawn as running\n${describe(first)}`)
    assert.ok(first.some((turn) => Array.isArray(turn.ended) && turn.ended.length > 0), `the turn is drawn as ended, with its reason\n${describe(first)}`)
    assert.ok(readFileSync(transcriptFile(sessionDir)).equals(crashedBytes), 'and reading the session wrote nothing to its log')

    /** The next turn opens the session for writing: the closers are appended first, then the turn. */
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'it was interrupted' }] }))
    const next = await fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: id, prompt: 'did the command finish?' }),
    })
    const stream = await next.text()
    assert.equal(next.status, 200, `the follow-up turn ran\n${stream}`)
    assert.ok(!stream.includes('event: error'), `and did not fail\n${stream}`)
    const after = readTranscript(sessionDir)
    assert.deepEqual(after.map((event) => event.seq), after.map((_, index) => index), 'every seq is written once, in order')
    const closers = after.slice(crashed.length, crashed.length + 3)
    assert.deepEqual(
      closers.map((event) => event.type),
      ['message', 'assistant/completed', 'turn/completed'],
      `the log is closed right after the cut turn, before anything else\n${after.slice(crashed.length).map((event) => event.type).join(' ')}`,
    )
    assert.equal(closers[0].message?.role, 'tool', 'the first closer answers the call')
    assert.equal(closers[0].message?.toolCallId, callId)
    assert.match((closers[0].message?.content ?? []).map((part) => part.text ?? '').join(''), /^error \(INTERRUPTED\)/)
    const asked = after.findIndex((event, index) => index >= crashed.length && event.type === 'message' && event.message?.role === 'user')
    assert.ok(asked >= crashed.length + 3, 'and the follow-up prompt comes after the closers')
    assert.equal(after.filter((event) => event.type === 'message' && event.message?.role === 'tool' && event.message.toolCallId === callId).length, 1, 'the call has one answer')

    const later = await view()
    assert.equal(later.find((turn) => turn.kind === 'tool' && turn.toolCallId === callId)?.state, 'error', `after a later turn the cut call is still drawn as interrupted\n${describe(later)}`)
    assert.ok(!later.some((turn) => turn.state === 'running'), `and nothing as running\n${describe(later)}`)
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a turn into a one-shot subagent\'s session is refused the way DSH refuses it, and the child is left as it was', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * DSH parity C23 (R-developer-eight-26). A delegated child is a one-shot record: DSH's generic session route leaves it to
   * subagent routing and refuses a prompt into it with session/agent-busy, the sentence 'session "<id>" is owned by
   * subagent routing' and the reason 'use subagent delivery for this child session' (dsh-api-session-controller
   * lib/index.js:128-142). Phase A measured POST /api/turn into one answering 200 in both builds and growing its log from
   * one turn to two. The child is made the way a person makes one, by a parent turn that delegates.
   */
  const home = isolatedHome('subagent-turn')
  const work = fixtureDir('subagent-turn-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } },
      { text: 'parent started the child' },
      { purpose: 'subagent', text: 'child answer' },
      { purpose: 'subagent-notice', text: 'parent read the notice' },
    ],
  })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  let live
  try {
    const run = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', root, '--turn', 'parent prompt'], { env, cwd: work })
    assert.equal(run.code, 0, `the delegating turn ran\n${run.stdout}${run.stderr}`)
    live = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', root], env)
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const sessions = async () => (await fetch(origin + '/api/sessions', { headers: { cookie } })).json()
    const before = await sessions()
    const child = before.find((meta) => meta.origin === 'subagent')
    assert.ok(child !== undefined, `the delegation made a subagent child\nsaw: ${JSON.stringify(before)}`)
    assert.equal(child.turns, 1, 'the child ran its one task')
    const eventsBefore = readTranscript(join(root, child.id)).length

    const response = await fetch(origin + '/api/turn', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: child.id, prompt: 'write into child' }),
    })
    const text = await response.text()
    assert.equal(response.status, 409, `the turn is refused\nsaw: ${response.status} ${text.slice(0, 300)}`)
    assert.deepEqual(
      JSON.parse(text),
      { error: `session "${child.id}" is owned by subagent routing`, code: 'session/agent-busy', reason: 'use subagent delivery for this child session' },
      'with DSH\'s code, sentence and reason',
    )
    const after = (await sessions()).find((meta) => meta.id === child.id)
    assert.equal(after?.turns, 1, 'the child still records one turn')
    assert.equal(readTranscript(join(root, child.id)).length, eventsBefore, 'and its log gained nothing')
  } finally {
    live?.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('a turn into an archived session is accepted and blocked before any model request, as DSH\'s gate blocks it', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * Issue #26. DSH's ArchivedSessionGate (dsh-api-session-controller lib/index.js:2508-2541) answers the agent's
   * pre-step with reject while its session is archived: the prompt is accepted, the turn opens, its claimed input is
   * dropped, no model request is made and the turn ends blocked (dsh-agent-loop lib/index.js:956-963). Measured before
   * this gate on both builds: POST /api/turn into an archived session asked the model, answered, and grew the session
   * from one turn to two while it stayed archived. The endpoint here is an HTTP double, so "no model request reached
   * the endpoint" is a count of what it received, not a reading of the log alone.
   */
  const home = isolatedHome('archived-turn')
  const work = fixtureDir('archived-turn-work')
  const root = join(home, 'sessions')
  const double = await chatDouble({ content: 'the endpoint answered' })
  const config = httpConfig({ home, baseUrl: double.baseUrl })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  const args = ['--config', join(repoRoot, 'cordis.yml'), '--session-root', root]
  /** What a turn must not leave in an archived session's log: an input message, a model call, an answer, a completion. */
  const answerTypes = new Set(['message', 'model/request', 'assistant/chunk', 'assistant/completed', 'turn/completed'])
  let live
  try {
    const first = await runCli([...args, '--turn', 'before the archive', '--json'], { env, cwd: work })
    assert.equal(first.code, 0, `a live session's turn ran\n${first.stdout}${first.stderr}`)
    const id = parseJson(first.stdout).session
    assert.equal(double.requests.length, 1, 'and asked the endpoint once')
    const transcript = () => readTranscript(join(root, id))

    live = await startServer(['web', '--host', '127.0.0.1', '--port', '0', ...args], env)
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = (path, body) =>
      fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const meta = async () => (await (await fetch(origin + '/api/sessions', { headers: { cookie } })).json()).find((one) => one.id === id)
    assert.equal((await post(`/api/sessions/${id}/flags`, { archived: true })).status, 200, 'the session is archived')
    const turnsBefore = (await meta())?.turns
    assert.equal(turnsBefore, 1, 'with its one turn')
    const eventsBefore = transcript().length

    const response = await post('/api/turn', { session: id, prompt: 'into the archive' })
    const text = await response.text()
    assert.equal(response.status, 200, `the turn is accepted, as DSH accepts the prompt\nsaw: ${response.status} ${text.slice(0, 300)}`)
    const doneLine = text.split('\n\n').find((frame) => frame.startsWith('event: done\n'))
    assert.ok(doneLine !== undefined, `the turn ended\nsaw: ${text.slice(0, 600)}`)
    const done = JSON.parse(doneLine.slice(doneLine.indexOf('data: ') + 'data: '.length))
    assert.equal(done.finishReason, 'blocked', `it ended blocked\nsaw: ${JSON.stringify(done)}`)
    assert.equal(done.rounds, 0, 'without a step')
    assert.equal(done.text, '', 'and without an answer')
    assert.ok(!text.includes('the endpoint answered'), 'the endpoint\'s answer never streamed')
    assert.equal(double.requests.length, 1, 'no model request reached the endpoint')
    const added = transcript().slice(eventsBefore)
    assert.deepEqual(added.filter((event) => answerTypes.has(event.type)).map((event) => event.type), [], 'no input, model call or answer was appended')
    assert.deepEqual(
      added.filter((event) => event.type === 'turn/failed').map((event) => event.reason),
      [{ kind: 'blocked' }],
      `the log records the turn as blocked, DSH's turn-end reason\nsaw: ${JSON.stringify(added)}`,
    )
    const inserted = added.find((event) => event.type === 'agent/inbox/spliced' && event.target === 'next-turn' && Array.isArray(event.inserted) && event.inserted.length === 1)
    assert.equal(inserted?.inserted[0]?.content?.[0]?.text, 'into the archive', 'the dropped prompt is recorded as claimed input, as DSH records it')
    const after = await meta()
    assert.equal(after?.turns, turnsBefore, 'the session records the same number of turns')
    assert.equal(after?.archived, true, 'and stays archived')

    /** The command line's --resume --turn into the same session meets the same gate. */
    live.kill()
    live = undefined
    const resumed = await runCli([...args, '--resume', id, '--turn', 'the command line into the archive', '--json'], { env, cwd: work })
    assert.equal(resumed.code, 0, `the command line's turn is accepted\n${resumed.stdout}${resumed.stderr}`)
    assert.equal(parseJson(resumed.stdout).finishReason, 'blocked', `and ends blocked\n${resumed.stdout}`)
    assert.equal(double.requests.length, 1, 'still without a model request')
    const afterCli = transcript().slice(eventsBefore)
    assert.deepEqual(afterCli.filter((event) => answerTypes.has(event.type)).map((event) => event.type), [], 'and without an answer')
    assert.equal(afterCli.filter((event) => event.type === 'turn/failed').length, 2, 'two blocked turns, one per caller')
    const listed = await runCli([...args, 'sessions', '--json'], { env, cwd: work })
    assert.equal(parseJson(listed.stdout).find((one) => one.id === id)?.turns, turnsBefore, 'the turn count is unchanged')
  } finally {
    live?.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})

test('a goal round into an archived session blocks its goal as DSH does (prompt-rejected), and a resume after the unarchive runs it', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * Issue #26, the goal half. A goal round is a turn, so the archived-session gate refuses its first step before any
   * model request. DSH's goal-round driver then blocks the goal with "prompt-rejected" and its own sentence
   * (dsh-goal-round-driver lib/index.js:326-333), so the goal is not run again by itself, and after an unarchive a
   * resume starts it. Measured before on both builds: the goal stayed active and armed, so the resume was refused as
   * "already active and armed".
   */
  const home = isolatedHome('archived-goal')
  const work = fixtureDir('archived-goal-work')
  const root = join(home, 'sessions')
  const double = await chatDouble({ content: 'the goal round answered' })
  const config = httpConfig({ home, baseUrl: double.baseUrl })
  const env = { HEDDLE_HOME: home, HEDDLE_CONFIG: config }
  const args = ['--config', join(repoRoot, 'cordis.yml'), '--session-root', root]
  let live
  try {
    const first = await runCli([...args, '--turn', 'before the archive', '--json'], { env, cwd: work })
    assert.equal(first.code, 0, `a live session's turn ran\n${first.stdout}${first.stderr}`)
    const id = parseJson(first.stdout).session
    assert.equal(double.requests.length, 1)
    const transcript = () => readTranscript(join(root, id))

    live = await startServer(['web', '--host', '127.0.0.1', '--port', '0', ...args], env)
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = (path, body) =>
      fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const goal = async () => (await (await fetch(`${origin}/api/goal?session=${id}`, { headers: { cookie } })).json()).goal
    const reasonOf = (view) => view?.blockedReason ?? view?.blocked_reason
    const waitFor = async (condition, what) => {
      for (const started = Date.now(); Date.now() - started < 15_000; ) {
        const value = await condition()
        if (value !== undefined) return value
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
      return assert.fail(`timed out waiting for ${what}; the goal is ${JSON.stringify(await goal())}`)
    }
    const goalRounds = () =>
      transcript().filter((event) => event.type === 'message' && event.message?.source?.kind === 'goal').map((event) => event.message.source.round)

    assert.equal((await post(`/api/sessions/${id}/flags`, { archived: true })).status, 200, 'the session is archived')
    const created = await post('/api/goal', { session: id, action: 'create', objective: 'finish the report', max_goal_rounds: 1 })
    assert.equal(created.status, 200, `the goal is created\n${await created.text()}`)

    const blocked = await waitFor(async () => {
      const current = await goal()
      return current !== undefined && current.phase !== 'active' ? current : undefined
    }, 'the refused round to block its goal (without DSH\'s prompt-rejected it stays active and armed)')
    assert.equal(blocked.phase, 'blocked')
    assert.deepEqual(reasonOf(blocked), { code: 'prompt-rejected', message: 'Goal round was rejected before entering its step.' }, 'with DSH\'s code and sentence')
    assert.equal(double.requests.length, 1, 'the refused round made no model request')
    assert.deepEqual(goalRounds(), [], 'and admitted no message')
    assert.deepEqual(transcript().filter((event) => event.type === 'turn/failed').map((event) => event.reason), [{ kind: 'blocked' }], 'one blocked turn, not started again')

    assert.equal((await post(`/api/sessions/${id}/flags`, { archived: false })).status, 200, 'the session is unarchived')
    const resumed = await post('/api/goal', { session: id, action: 'resume', goal_id: blocked.id, revision: blocked.revision })
    assert.equal(resumed.status, 200, `the blocked goal resumes\n${await resumed.text()}`)
    const settled = await waitFor(async () => {
      const current = await goal()
      return reasonOf(current)?.code === 'round-limit' ? current : undefined
    }, 'the resumed round to run to its cap')
    assert.equal(settled.phase, 'blocked')
    assert.deepEqual(goalRounds(), [1], 'the resume ran round 1')
    assert.equal(double.requests.length, 2, 'and asked the endpoint for it')
  } finally {
    live?.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})

/** Boot a server for the one browser check here, resolving once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
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
      }, 15_000).unref()
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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

    /**
     * The root is opened by clicking its **row**, which is the only control a folder has now — but only when it says
     * it is closed. The page opens the first workspace on a first visit (DSH does, measured 2026-10-17), so an
     * unconditional click here would close the branch it meant to open and the folders below would never appear.
     */
    await browser.evaluate(`(() => {
      const row = document.querySelector('#tree .row')
      if (row.closest('li').dataset.open === 'false') row.click()
      return true
    })()`)
    await browser.waitFor(`document.querySelectorAll('#tree li[data-kind="type"]').length > 0`, 20_000)

    /**
     * The owner's rule of 2026-10-11: clicking an **expandable folder** expands and closes it, and the
     * folder glyph on the left says which state it is in — a reader should not have to read the `+` / `−`
     * control, or aim at it, to know whether a folder is open.
     */
    const toggled = JSON.parse(
      await browser.evaluate(`(async () => {
        /** Levels are opened only if closed: the page may or may not have expanded a root on load. */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = [...document.querySelectorAll('#tree .row')].find((entry) => entry.querySelector('.label')?.textContent === label)
            if (row === undefined) { await new Promise((done) => setTimeout(done, 150)); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await new Promise((done) => setTimeout(done, 200))
            if (li.dataset.open === 'true') return true
          }
          return false
        }
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
        /** Only the root: the branch's own open/closed states are what this check measures. */
        await ensureOpen(document.querySelector('#tree .row .label')?.textContent ?? '')
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
    /**
     * The selection before the click: a first visit opens a fresh New session (#17, DSH's restoreSelection), whose row is
     * the selected one, so "chooses nothing" is that the selection does not move.
     */
    const selectedBefore = JSON.parse(
      await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#tree li[aria-selected="true"] > .row')].map((entry) => entry.querySelector('.label').textContent))`),
    )
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
    assert.deepEqual(openedInstance.selected, selectedBefore, 'and chooses nothing: a folder is navigation, not a selection')
    assert.ok(!openedInstance.selected.includes('some-tool'), 'the instance itself is not selected')

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
        /** The indentation is the row's **content** inset: the boxes agree (the paint is the panel's width). */
        const contentLeft = (label) => {
          const row = find(label)
          const box = row.getBoundingClientRect()
          return box.left + parseFloat(getComputedStyle(row).paddingLeft)
        }
        return {
          styles: lists.map((list) => getComputedStyle(list).listStyleType),
          indent: Math.round(contentLeft('some-tool') - contentLeft('_tools_')),
          boxIndent: Math.round(find('some-tool').getBoundingClientRect().left - find('_tools_').getBoundingClientRect().left),
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
     * And the indent is the **content's**, not the row's: the row boxes all start at the panel's edge, so a highlight does
     * not step inward with the tree. Measured before the change: the group carried the padding and the boxes differed by
     * the same 14 pixels as the text.
     */
    assert.equal(layout.boxIndent, 0, `the row boxes stay at the panel\'s edge (${layout.boxIndent}px)`)

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
    // Markdown is previewed as a document, not as raw source. Wait for its heading so a loading
    // placeholder or a correct rendered preview cannot be mistaken for missing file content.
    await browser.waitFor(`document.querySelector("#file-body h1")?.textContent === "_tools_"`, 20_000)
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
    assert.equal(fileView.body, '_tools_', 'the panel shows the rendered heading from the document that was opened')
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
          /**
           * Reveal the row's controls first: the tail swaps them in for the age on hover/focus, so a quiet row has no control
           * box at all and "the menu is to the right of the name" could not be judged from one.
           */
          /** The row is the tree item's one Tab stop since #92; its focus is what the focus-within rule reveals the controls on. */
          row.focus()
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
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

test('the Web API adds, renames and deletes a workspace the way DSH does', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * The owner's request of 29 Oct — "ensure add, remove, rename workspace all works … function parity" with DSH — judged
   * over the routes the page calls, on whichever build runs this part:
   *
   * - **add** registers an existing absolute folder, answers `created: false` for one already registered (a trailing
   *   slash is the same folder), nests a folder under the root above it, and refuses a missing, relative, absent or
   *   file path with `400`;
   * - **rename** by id or by path; a blank name is `400`, another workspace's name is `409 workspace/name-conflict`
   *   (DSH's rule), the current name is a no-op, an unknown workspace `404`;
   * - **delete** removes the registration even while sessions remain — they move to the root above, or out of every
   *   workspace (Ungrouped) — and an unknown workspace is `404`. The CLI keeps its refusal; the check above judges it.
   */
  const h = harness('web-crud')
  const top = fixtureDir('web-crud-top')
  const child = join(top, 'child')
  const loose = fixtureDir('web-crud-loose')
  const file = join(loose, 'a-file.txt')
  let live
  try {
    mkdirSync(child, { recursive: true })
    writeFileSync(file, 'not a folder\n')
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      h.env,
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const call = async (path, init = {}) => {
      const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    }
    const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
    const views = async () => (await call('/api/workspaces')).body.workspaces ?? []

    const added = await post('/api/workspaces', { path: top })
    assert.equal(added.status, 200, `a folder is added (${JSON.stringify(added.body)})`)
    assert.equal(added.body.created, true, 'and this call created it')
    assert.equal(added.body.record.path, realpathSync(top), 'under its canonical path')
    const again = await post('/api/workspaces', { path: `${top}/` })
    assert.equal(again.status, 200, 'adding it again is not an error')
    assert.equal(again.body.created, false, 'it reports the workspace that was already there')
    const nested = await post('/api/workspaces', { path: child })
    assert.equal(nested.status, 200, 'a folder inside it is added too')
    const byPath = Object.fromEntries((await views()).map((view) => [view.path, view]))
    assert.equal(byPath[realpathSync(child)]?.parent, byPath[realpathSync(top)]?.id, 'and nests under the root above it')
    for (const [what, body] of [
      ['no path', {}],
      ['a folder that does not exist', { path: join(loose, 'nowhere') }],
      ['a relative path', { path: 'not/absolute' }],
      ['a file', { path: file }],
    ]) {
      const refused = await post('/api/workspaces', body)
      assert.equal(refused.status, 400, `${what} is refused (${JSON.stringify(refused.body)})`)
      assert.equal(typeof refused.body.error, 'string', `with a sentence for ${what}`)
    }

    const topId = byPath[realpathSync(top)].id
    const renamed = await call(`/api/workspaces/${encodeURIComponent(topId)}`, { method: 'PATCH', body: JSON.stringify({ title: 'Top Renamed' }) })
    assert.equal(renamed.status, 200, `a workspace is renamed by id (${JSON.stringify(renamed.body)})`)
    assert.equal(renamed.body.title, 'Top Renamed')
    assert.equal(renamed.body.path, realpathSync(top), 'and its path does not move')
    const byItsPath = await call(`/api/workspaces/${encodeURIComponent(child)}`, { method: 'PATCH', body: JSON.stringify({ title: '  Child  ' }) })
    assert.equal(byItsPath.body.title, 'Child', 'or by path, trimmed')
    const clash = await call(`/api/workspaces/${encodeURIComponent(child)}`, { method: 'PATCH', body: JSON.stringify({ title: 'Top Renamed' }) })
    assert.equal(clash.status, 409, `another workspace's name is refused (${JSON.stringify(clash.body)})`)
    assert.equal(clash.body.code, 'workspace/name-conflict', "with DSH's code")
    assert.equal(clash.body.error, 'A workspace named “Top Renamed” already exists.', "and DSH's sentence")
    const same = await call(`/api/workspaces/${encodeURIComponent(topId)}`, { method: 'PATCH', body: JSON.stringify({ title: 'Top Renamed' }) })
    assert.equal(same.status, 200, 'confirming the current name is not a clash with itself')
    assert.equal(same.body.updatedAt, renamed.body.updatedAt, 'and changes nothing')
    const blank = await call(`/api/workspaces/${encodeURIComponent(topId)}`, { method: 'PATCH', body: JSON.stringify({ title: '   ' }) })
    assert.equal(blank.status, 400, 'a blank name is refused')
    const unknown = await call(`/api/workspaces/${encodeURIComponent(join(loose, 'nowhere'))}`, { method: 'PATCH', body: JSON.stringify({ title: 'x' }) })
    assert.equal(unknown.status, 404, 'an unknown workspace is not found')

    const inChild = await post('/api/sessions', { branch: child })
    assert.equal(inChild.status, 200, `a session starts in the child (${JSON.stringify(inChild.body)})`)
    const inTop = await post('/api/sessions', { branch: top })
    assert.equal(inTop.status, 200, `and one in the top (${JSON.stringify(inTop.body)})`)
    const childGone = await call(`/api/workspaces/${encodeURIComponent(child)}`, { method: 'DELETE' })
    assert.equal(childGone.status, 200, `a workspace holding a session is deleted (${JSON.stringify(childGone.body)})`)
    assert.equal(childGone.body.ownedSessions, 1, 'and it says how many sessions it held')
    assert.equal(childGone.body.adoptedBy, 'Top Renamed', 'and that the root above took them')
    const topGone = await call(`/api/workspaces/${encodeURIComponent(topId)}`, { method: 'DELETE' })
    assert.equal(topGone.status, 200, `a workspace with sessions and nothing above is deleted too (${JSON.stringify(topGone.body)})`)
    assert.equal(topGone.body.ownedSessions, 2)
    const left = await views()
    assert.ok(!left.some((view) => view.path === realpathSync(top) && view.origin !== 'auto'), 'it is no longer a workspace')
    const owned = new Set(left.filter((view) => view.origin !== 'auto').flatMap((view) => view.sessionIds ?? []))
    assert.ok(!owned.has(inTop.body.session) && !owned.has(inChild.body.session), 'and its sessions are Ungrouped')
    const sessions = (await call('/api/sessions')).body.map((meta) => meta.id)
    assert.ok(sessions.includes(inTop.body.session) && sessions.includes(inChild.body.session), 'but they still exist')
    assert.ok(existsSync(top), 'and so does the folder')
    const missing = await call(`/api/workspaces/${encodeURIComponent(join(loose, 'nowhere'))}`, { method: 'DELETE' })
    assert.equal(missing.status, 404, 'an unknown workspace is not found')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
    removeDir(top)
    removeDir(loose)
  }
})

test('a workspace added through the Web API with a ~ path is the folder under the home, stored canonical', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * GitHub issue #1. The route accepts a path that starts with `~` and expands it to the home folder; what it stores
   * is the canonical path of that folder, so `~/x`, its expanded spelling, a trailing slash and (on a
   * case-insensitive volume) a letter-case variant are one workspace. Measured on the TypeScript build: it checked
   * the expanded path and stored the raw string, which resolved against the server's working folder — a record at
   * `<server folder>/~/x`, a folder that does not exist, answered `200 created: true`. The Rust build stored the
   * real folder. heddle keeps this `~` rule on purpose (`rust/crates/heddle-config/INDEX.md` §7); DSH refuses a path
   * that is not fully qualified instead (dsh-workspace `realpathNormalize`), so this judges the two builds alike.
   *
   * `HOME` is the check's own scratch folder for the server, on either build, so nothing is read or written under a
   * real home.
   */
  const h = harness('web-tilde')
  const home = fixtureDir('web-tilde-home')
  const folder = join(home, 'tilde-probe')
  let live
  try {
    mkdirSync(folder, { recursive: true })
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: home },
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = async (body) => {
      const response = await fetch(`${origin}/api/workspaces`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'content-type': 'application/json' } })
      return { status: response.status, body: await response.json() }
    }
    const canonical = realpathSync(folder)

    const added = await post({ path: '~/tilde-probe', name: 'tilde-probe' })
    assert.equal(added.status, 200, `a ~ path is added (${JSON.stringify(added.body)})`)
    assert.equal(added.body.created, true, 'and this call created it')
    assert.equal(added.body.record.path, canonical, 'as the canonical path of the folder under the home, not one under the server folder')
    const views = (await (await fetch(`${origin}/api/workspaces`, { headers: { cookie } })).json()).workspaces ?? []
    assert.deepEqual(views.map((view) => view.path), [canonical], `the listing holds that folder and nothing else\nsaw: ${JSON.stringify(views)}`)

    for (const [what, path] of [
      ['its expanded spelling', folder],
      ['a trailing slash after ~', '~/tilde-probe/'],
      ...(existsSync(join(home, 'TILDE-PROBE')) ? [['a letter-case variant', '~/TILDE-PROBE']] : []),
    ]) {
      const again = await post({ path })
      assert.equal(again.status, 200, `${what} is not an error (${JSON.stringify(again.body)})`)
      assert.equal(again.body.created, false, `${what} is the workspace already there`)
      assert.equal(again.body.record.id, added.body.record.id, `${what} names the same record`)
    }

    const missing = await post({ path: '~/nowhere' })
    assert.equal(missing.status, 400, `a ~ path that does not exist is refused (${JSON.stringify(missing.body)})`)
    assert.equal(missing.body.error, '~/nowhere does not exist', 'naming the path as it was written')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
    removeDir(home)
  }
})

test('a session title is cleaned as DSH cleans it, at creation and on rename, and one with nothing visible is refused', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * DSH cleans an accepted title (dsh-session-title normalizeSessionTitle, lib/index.js:10-54): escape sequences,
   * non-whitespace controls and directional or invisible characters removed, whitespace collapsed to one line, at most
   * maxTitleBytes UTF-8 bytes on a code point, 80 in its shipped profile (dsh-base cordis.patch.yml:60-65); a title with
   * nothing visible left is refused, session/title-invalid (dsh-api-session-controller lib/index.js:827-840). Measured
   * on both builds before this check (live-testing draft developer-six-1): every title was stored as sent, and three
   * spaces cleared the title with a 200.
   */
  const h = harness('title-clean')
  let live
  try {
    const added = await runCli(adminArgs(h, ['workspace', 'add', h.work]), { env: h.env, cwd: h.work })
    assert.equal(added.code, 0, `the fixture registered its own root\n${added.stdout}${added.stderr}`)
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      h.env,
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = async (path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
      return { status: response.status, body: parsed }
    }
    const stored = async (id) => {
      const response = await fetch(`${origin}/api/sessions`, { headers: { cookie } })
      return (await response.json()).find((meta) => meta.id === id)?.title
    }

    const made = await post('/api/sessions', { branch: h.work, title: 'made\u001b[31m red\u001b[0m\n\there \u202e' })
    assert.equal(made.status, 200, `a session is created with a title (${JSON.stringify(made.body)})`)
    const id = made.body.session
    assert.equal(await stored(id), 'made red here', 'and the title is stored cleaned')

    for (const [what, sent, kept] of [
      ['300 ASCII letters', 'a'.repeat(300), 'a'.repeat(80)],
      ['60 CJK characters', '\u5b57'.repeat(60), '\u5b57'.repeat(26)],
      ['an ANSI colour sequence', 'a\u001b[31mred\u001b[0m b', 'ared b'],
      ['a newline and a tab', 'line1\n\tline2', 'line1 line2'],
      ['a right-to-left override', 'abc\u202edcba', 'abcdcba'],
      ['a zero-width space', 'zero\u200bwidth', 'zerowidth'],
      ['NUL and BEL', 'nul\u0000ctl\u0007x', 'nulctlx'],
    ]) {
      const renamed = await post(`/api/sessions/${id}/title`, { title: sent })
      assert.equal(renamed.status, 200, `${what}: the rename is accepted`)
      assert.equal(renamed.body.title, kept, `${what}: the answer carries the cleaned title`)
      assert.equal(await stored(id), kept, `${what}: and the store holds it`)
    }

    for (const [what, sent] of [
      ['three spaces', '   '],
      ['only invisible and control characters', '\u200b\u0007\u202e'],
    ]) {
      const refused = await post(`/api/sessions/${id}/title`, { title: sent })
      assert.equal(refused.status, 400, `${what}: refused rather than clearing the title (${JSON.stringify(refused.body)})`)
      assert.equal(refused.body.code, 'session/title-invalid', `${what}: with DSH's code`)
      assert.equal(refused.body.error, 'session title must contain visible characters', `${what}: and DSH's sentence`)
      assert.equal(await stored(id), 'nulctlx', `${what}: and the title is left as it was`)
    }
    const unknown = await post('/api/sessions/session-00000000-0000-0000-0000-000000000000/title', { title: '   ' })
    assert.equal(unknown.status, 404, 'an unknown session is still not found first')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session title of only control or escape characters is refused on rename, as a blank one is', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * DSH cleans a title before it judges it (dsh-session-title rename, lib/index.js:295-299), so a title that is only a
   * terminal sequence and whitespace - a clear-screen and a tab, an empty window-title command, a C1 introducer - has
   * nothing visible left and takes the path three spaces take: 400 session/title-invalid with DSH's sentence
   * (dsh-api-session-controller lib/index.js:827-840), the title left alone. It must neither clear the title nor store
   * the sequence, which the CLI's session list would print to a terminal. Measured on origin/main c9b9cc75 through both
   * builds: each rename answered 200 and stored the sequence as sent less its surrounding whitespace.
   */
  const h = harness('title-controls')
  let live
  try {
    const added = await runCli(adminArgs(h, ['workspace', 'add', h.work]), { env: h.env, cwd: h.work })
    assert.equal(added.code, 0, `the fixture registered its own root\n${added.stdout}${added.stderr}`)
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      h.env,
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = async (path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
      return { status: response.status, body: parsed }
    }
    const stored = async (id) => {
      const response = await fetch(`${origin}/api/sessions`, { headers: { cookie } })
      return (await response.json()).find((meta) => meta.id === id)?.title
    }

    const made = await post('/api/sessions', { branch: h.work, title: 'kept title' })
    assert.equal(made.status, 200, `a session is created with a title (${JSON.stringify(made.body)})`)
    const id = made.body.session
    assert.equal(await stored(id), 'kept title', 'and it holds that title')

    for (const [what, sent] of [
      ['a clear-screen sequence and a tab', '\u001b[2J\t'],
      ['an empty window-title command', '\u001b]0;\u0007'],
      ['a C1 control sequence, a reverse index and a line break', '\u009b31m\u001bM\r\n'],
    ]) {
      const refused = await post(`/api/sessions/${id}/title`, { title: sent })
      assert.equal(refused.status, 400, `${what}: refused as three spaces are (${JSON.stringify(refused.body)})`)
      assert.equal(refused.body.code, 'session/title-invalid', `${what}: with DSH's code`)
      assert.equal(refused.body.error, 'session title must contain visible characters', `${what}: and DSH's sentence`)
      assert.equal(await stored(id), 'kept title', `${what}: and the title is left as it was`)
    }
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a workspace moved before another keeps its place across a restart, as DSH workspace/insertBefore does', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * DSH's drag-to-reorder of workspaces (C37) stores the order with the host: workspace/insertBefore takes the moved
   * workspace and an optional anchor, lands it before the anchor or last without one, and answers the complete order
   * (dsh-workspace lib/index.js:473-499; dsh-api-workspace-controller lib/index.js:262-269). A workspace or anchor it
   * does not hold is workspace/not-found with the sentence Workspace "id" not found (index.js:358-360); a new workspace
   * still goes first (dsh-workspace lib/index.js:402). Judged over the route the page's drop calls, then again after
   * the server restarts, in the command line's listing, and in the record file, whose shape must not change so the
   * other build keeps reading it.
   */
  const h = harness('web-reorder')
  const folders = ['one', 'two', 'three'].map((name) => fixtureDir(`web-reorder-${name}`))
  const late = fixtureDir('web-reorder-four')
  let live
  try {
    const boot = async () => {
      live = await startServer(
        ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
        h.env,
      )
      const origin = new URL(live.url).origin
      const handshake = await fetch(live.url, { redirect: 'manual' })
      const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
      return async (path, init = {}) => {
        const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
        const text = await response.text()
        let body
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        return { status: response.status, body }
      }
    }
    let call = await boot()
    const move = (body) => call('/api/workspaces/insertBefore', { method: 'POST', body: JSON.stringify(body) })
    const ids = {}
    for (const [index, folder] of folders.entries()) {
      const added = await call('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
      assert.equal(added.status, 200, `a folder is added (${JSON.stringify(added.body)})`)
      ids[['one', 'two', 'three'][index]] = added.body.record.id
    }
    const named = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]))
    const order = (list) => list.map((id) => named[id]).filter((name) => name !== undefined)
    const listed = async () => order(((await call('/api/workspaces')).body.workspaces ?? []).map((view) => view.id))
    assert.deepEqual(await listed(), ['three', 'two', 'one'], 'a new workspace goes first')

    const first = await move({ workspaceId: ids.one, beforeWorkspaceId: ids.three })
    assert.equal(first.status, 200, `a workspace is moved before another (${JSON.stringify(first.body)})`)
    assert.deepEqual(order(first.body.workspaceIds ?? []), ['one', 'three', 'two'], 'and the answer is the complete order')
    assert.deepEqual(await listed(), ['one', 'three', 'two'], 'which the workspace list now reads')
    const last = await move({ workspaceId: ids.three })
    assert.equal(last.status, 200, `without an anchor it goes last (${JSON.stringify(last.body)})`)
    assert.deepEqual(await listed(), ['one', 'two', 'three'])
    const itself = await move({ workspaceId: ids.two, beforeWorkspaceId: ids.two })
    assert.equal(itself.status, 200, 'itself as the anchor is not an error')
    assert.deepEqual(order(itself.body.workspaceIds ?? []), ['one', 'two', 'three'], 'and moves nothing')

    for (const [what, body, missingId] of [
      ['an unknown workspace', { workspaceId: 'w-nowhere', beforeWorkspaceId: ids.one }, 'w-nowhere'],
      ['an unknown anchor', { workspaceId: ids.one, beforeWorkspaceId: 'w-nowhere' }, 'w-nowhere'],
    ]) {
      const refused = await move(body)
      assert.equal(refused.status, 404, `${what} is not found (${JSON.stringify(refused.body)})`)
      assert.equal(refused.body.code, 'workspace/not-found', `with DSH's code for ${what}`)
      assert.equal(refused.body.error, `Workspace "${missingId}" not found`, `and DSH's sentence for ${what}`)
    }
    const nameless = await move({})
    assert.equal(nameless.status, 400, `a move that names no workspace is refused (${JSON.stringify(nameless.body)})`)
    assert.deepEqual(await listed(), ['one', 'two', 'three'], 'and no refusal moved anything')

    live.kill()
    live = undefined
    call = await boot()
    assert.deepEqual(await listed(), ['one', 'two', 'three'], 'the order is the host\'s: it holds across a restart')
    const cli = await workspacesOf(h)
    assert.deepEqual(order(cli.map((record) => record.id)), ['one', 'two', 'three'], 'and the command line lists it too')

    const file = JSON.parse(readFileSync(join(h.home, 'workspaces.json'), 'utf8'))
    assert.deepEqual(Object.keys(file), ['version', 'workspaceIds', 'workspaces'], 'the record file keeps its keys')
    assert.deepEqual(order(file.workspaceIds), ['one', 'two', 'three'], 'and keeps the order in workspaceIds, where both builds read it')

    const added = await call('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: late }) })
    assert.equal(added.status, 200, `a fourth folder is added (${JSON.stringify(added.body)})`)
    const views = ((await call('/api/workspaces')).body.workspaces ?? []).map((view) => view.id)
    assert.equal(views[0], added.body.record.id, 'a new workspace still goes first')
    assert.deepEqual(order(views), ['one', 'two', 'three'], 'before the moved order, which stays as it was')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
    for (const folder of [...folders, late]) removeDir(folder)
  }
})

test("the Web API's tree lists only what a workspace root holds, and refuses a path outside every root as the CLI does", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * The CLI refuses a tree outside every root (the check above, "a folder outside every root is refused rather than
   * walked"); this judges the route the page calls. A folder no root owns, a link inside a root that leads to it, and a
   * dot-dot walk out of a root are each refused before anything is listed: "400" with web.ts's sentence naming the
   * canonical path, which is where a link or a dot-dot walk lands. DSH confines a listing the same way: it resolves the
   * path and refuses a directory its workspace root does not contain (dsh-api-workspace-files list and confine,
   * workspace-file/outside-workspace). A folder inside the root still lists.
   */
  const h = harness('tree-fence')
  const root = fixtureDir('tree-fence-root')
  const outside = fixtureDir('tree-fence-outside')
  let live
  try {
    entry(join(root, 'inner', 'kept.txt'), 'inside\n')
    entry(join(outside, 'not-yours.txt'), 'outside\n')
    mkdirSync(join(outside, 'a-folder'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, join(root, 'way-out'))
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      h.env,
    )
    const origin = new URL(live.url).origin
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const call = async (path, init = {}) => {
      const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    }
    const added = await call('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: root }) })
    assert.equal(added.status, 200, `the root is registered (${JSON.stringify(added.body)})`)
    const treeOf = (path) => call(`/api/tree?path=${encodeURIComponent(path)}`)

    const sentence = `${realpathSync(outside)} is not under any workspace root`
    for (const [what, path] of [
      ['a folder outside every root', outside],
      ['a link inside the root that leads out of it', join(root, 'way-out')],
      // Spelled by hand: join() would fold the dot-dot away before the server saw it.
      ['a dot-dot walk out of the root', `${root}${sep}..${sep}${outside.split(sep).pop()}`],
    ]) {
      const refused = await treeOf(path)
      const listed = Array.isArray(refused.body?.children) ? refused.body.children.map((node) => node.label).join(', ') : ''
      assert.equal(refused.status, 400, `${what} is refused, not listed (${refused.status}${listed ? `, listed: ${listed}` : ''})`)
      assert.deepEqual(refused.body, { error: sentence }, `and ${what} gets the sentence that names the rule and the canonical path`)
    }

    const inside = await treeOf(join(root, 'inner'))
    assert.equal(inside.status, 200, `a folder inside the root still lists (${JSON.stringify(inside.body)})`)
    assert.deepEqual(
      (inside.body.children ?? []).map((node) => `${node.kind}:${node.label}`),
      ['file:kept.txt'],
      'with what it holds',
    )
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
    removeDir(root)
    removeDir(outside)
  }
})

test('first use creates or reuses default-workspace under the heddle home, once, the way DSH initializes its default', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * DSH's workspace/initializeDefault (dsh-workspace, dsh-api-workspace-controller): an empty install — no workspace,
   * no session — gets a workspace over a folder named default-workspace, created when missing and reused when present;
   * a repeated call answers the same workspace; deleting it turns first use off for good, and the folder stays; any
   * install that is not empty gets nothing, which is not an error. No session is started. DSH's folder is under
   * Documents/deepseek-harness; heddle's is under its own home, so HOME is a fixture here and its Documents must stay
   * absent.
   */
  const fresh = harness('first-use')
  const busy = harness('first-use-busy')
  const userHome = fixtureDir('first-use-user')
  const chosen = fixtureDir('first-use-chosen')
  const live = []
  try {
    const serve = async (h) => {
      const server = await startServer(
        ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
        { ...h.env, HOME: userHome },
      )
      live.push(server)
      const origin = new URL(server.url).origin
      const handshake = await fetch(server.url, { redirect: 'manual' })
      const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
      return async (path, init = {}) => {
        const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
        const text = await response.text()
        let body
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        return { status: response.status, body }
      }
    }
    const call = await serve(fresh)
    const folder = join(fresh.home, 'default-workspace')
    const first = await call('/api/workspaces/default', { method: 'POST' })
    assert.equal(first.status, 200, `an empty install asks for its default workspace (${JSON.stringify(first.body)})`)
    assert.ok(first.body.workspace !== null && typeof first.body.workspace === 'object', `and gets one (${JSON.stringify(first.body)})`)
    assert.ok(existsSync(folder), 'its folder is made under the heddle home')
    assert.equal(first.body.workspace.path, realpathSync(folder), 'and the workspace is that folder')
    assert.equal(first.body.workspace.title, 'default-workspace', "titled after the folder, as DSH stores it")
    assert.equal(first.body.workspace.origin, 'added', 'a workspace the tree draws')
    assert.equal(existsSync(join(userHome, 'Documents')), false, "nothing is made in the user's Documents")
    const listed = (await call('/api/workspaces')).body.workspaces ?? []
    assert.deepEqual(listed.map((view) => view.id), [first.body.workspace.id], 'it is the one workspace')
    assert.deepEqual((await call('/api/sessions')).body, [], 'and no session was started')

    const again = await call('/api/workspaces/default', { method: 'POST' })
    assert.equal(again.body.workspace?.id, first.body.workspace.id, 'a repeated call reuses it')
    assert.equal(((await call('/api/workspaces')).body.workspaces ?? []).length, 1, 'rather than making a second')

    const deleted = await call(`/api/workspaces/${encodeURIComponent(first.body.workspace.id)}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200, 'the default workspace can be deleted')
    const after = await call('/api/workspaces/default', { method: 'POST' })
    assert.equal(after.status, 200)
    assert.equal(after.body.workspace, null, 'and once deleted it is not given back')
    assert.deepEqual((await call('/api/workspaces')).body.workspaces ?? [], [], 'the list stays empty')
    assert.ok(existsSync(folder), 'while its folder stays')

    const other = await serve(busy)
    assert.equal((await other('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: chosen }) })).status, 200)
    const notFirst = await other('/api/workspaces/default', { method: 'POST' })
    assert.equal(notFirst.status, 200, 'an install that is not empty is not refused')
    assert.equal(notFirst.body.workspace, null, 'it gets no default workspace')
    assert.equal(existsSync(join(busy.home, 'default-workspace')), false, 'and no folder')
  } finally {
    for (const server of live) server.kill()
    for (const h of [fresh, busy]) {
      removeDir(h.home)
      removeDir(h.work)
    }
    removeDir(userHome)
    removeDir(chosen)
  }
})

test('New session here, on an instance row, starts a session and writes its definition', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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
      const chosen = document.querySelector('#tree li[aria-selected="true"]')
      return JSON.stringify({
        rows,
        branchOpen: reopened.parentElement.dataset.open === 'true',
        selectedKind: chosen?.dataset.kind ?? null,
        selected: chosen?.querySelector(':scope > .row')?.querySelector('.label')?.textContent ?? null,
        selectedDefinition: chosen?.querySelector(':scope > .row')?.dataset.definition ?? null,
        selectedTooltip: chosen?.querySelector(':scope > .row')?.getAttribute('title') ?? null,
      })
    })()`)
    const outcome = JSON.parse(clicked)
    assert.equal(outcome.error, undefined, `the menu opened and the item was there\\nsaw: ${clicked}`)
    /**
     * And the act leaves a **visible** result. Measured: the first version created the session correctly and
     * re-rendered the tree, and the owner reported that nothing happened — the branch the session appeared in
     * was closed, so the new row sat inside a closed folder. Opening the branch and selecting the new row is
     * the fix, and this is what pins it.
     */
    assert.equal(outcome.branchOpen, true, 'the branch is open when the tree comes back')
    /**
     * Since the left column became DSH's workspace tree (owner goal, 2026-10-28), a session is drawn once, as a session
     * row of its **workspace**, rather than inside the folder it works in; its definition folder is its `data-definition`.
     * So the visible result is the new session's row, selected, reading DSH's `New Session` (dsh-client-ui-workspace
     * lib/client.js:1801-1804, :4876; #24) rather than the folder's clock name, which only `data-definition` carries: the
     * folder is an internal path with the home directory in it, so it is never the row's tooltip (#109).
     */
    assert.equal(outcome.selectedKind, 'session', `the new session is the selected row\nsaw: ${JSON.stringify(outcome)}`)
    assert.equal(outcome.selected, 'New Session', `it reads New Session, not its folder's name (#24)\nsaw: ${JSON.stringify(outcome)}`)
    const name = basename(String(outcome.selectedDefinition))
    assert.ok(!outcome.rows.includes('session:' + name), 'and it is drawn once, under its workspace, not again inside the folder')
    assert.match(name, /^session-\d{8}-\d{4}$/, `its definition folder is named for the clock, as the convention requires\nsaw: ${name}`)

    const definition = join(h.work, '_tools_', 'some-tool', '_sessions_', name, 'session.json')
    assert.ok(existsSync(definition), `and its definition is on disk at ${definition}`)
    const fields = JSON.parse(readFileSync(definition, 'utf8'))
    assert.equal(fields.cwd, join(h.work, '_tools_', 'some-tool'), 'the definition names the folder the session is bound to')
    assert.equal(outcome.selectedDefinition, join(h.work, '_tools_', 'some-tool', '_sessions_', name), 'and the row carries its definition folder in data-definition')
    assert.equal(outcome.selectedTooltip, 'New Session', 'while its tooltip is its title, never that folder (#109)')
    /**
     * And the **tree** says which conversation the row is, which is what makes clicking it open that
     * conversation rather than only expand a folder. Before this the node carried `session: null`, so a row
     * that named no session looked exactly like one that did.
     */
    const drawn = await treeAt(h, join(h.work, '_tools_', 'some-tool'))
    const sessionNode = (drawn.tree.children ?? []).find((node) => node.kind === 'session')
    assert.equal(sessionNode?.session?.id, fields.id, 'the row names the session its definition names')

    assert.ok(isOutside(h.work, String(fields.log)), `while the transcript stays outside the repository\\nsaw: ${fields.log}`)
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

/**
 * A server of the blank-session checks below: a scratch home, the work folder registered as a workspace, and a caller that
 * holds the cookie the launch URL mints.
 */
async function blankSessionServer(h) {
  const live = await startServer(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
    { ...h.env, HOME: h.home },
  )
  const origin = new URL(live.url).origin
  const handshake = await fetch(live.url, { redirect: 'manual' })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  const call = async (path, init = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { cookie, 'content-type': 'application/json' } })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) })
  const added = await post('/api/workspaces', { path: h.work })
  assert.equal(added.status, 200, `the folder is a workspace (${JSON.stringify(added.body)})`)
  return { live, call, post, branch: realpathSync(h.work) }
}

test('a New session request never lands in an empty session another client made, even one it names', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * DSH's sidebar New session and its chord mint a fresh Session on every press (startSession with no options, then
   * connectBlank with no reuse: dsh-client-ui-workspace lib/client.js:1403-1406 and 1520); the older blank is only hidden
   * (sessionVisible, :964-966). On a shared server an empty session in the list can be another client's: the coordinator's
   * request of 2026-10-29 reports a turn landing in one. So the session route makes a new session for every request, and a
   * request that names a listed empty session (what an earlier page sent) is not handed that session.
   */
  const h = harness('blank-two-clients-api')
  let server
  try {
    server = await blankSessionServer(h)
    const { post, call, branch } = server
    const first = await post('/api/sessions', { branch })
    assert.equal(first.status, 200, `client A's New session starts a session (${JSON.stringify(first.body)})`)
    const plain = await post('/api/sessions', { branch })
    assert.equal(plain.status, 200, `client B's New session answers (${JSON.stringify(plain.body)})`)
    assert.notEqual(plain.body.session, first.body.session, 'and is a session of its own')
    const naming = await post('/api/sessions', { branch, session: first.body.session })
    assert.equal(naming.status, 200, `a New session naming A's empty session still answers (${JSON.stringify(naming.body)})`)
    assert.notEqual(naming.body.session, first.body.session, "and is not handed A's session")
    assert.notEqual(naming.body.definition, first.body.definition, 'nor its definition')
    const listed = (await call('/api/sessions')).body.filter((meta) => meta.cwd === branch)
    assert.equal(new Set(listed.map((meta) => meta.id)).size, 3, `three requests, three sessions\nsaw: ${JSON.stringify(listed.map((meta) => meta.id))}`)
    assert.equal(listed.find((meta) => meta.id === first.body.session)?.turns ?? 0, 0, "and A's session is as A left it")
  } finally {
    server?.live.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('two clients pressing New session in the same folder get two different sessions, and each sees only its own blank', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The coordinator's case (2026-10-29): on a shared server the page's New session reopened an empty session another client
   * had made, and a turn landed in it. DSH mints a fresh Session on every press of New session or its chord
   * (dsh-client-ui-workspace lib/client.js:1403-1406, 1520) and shows a blank row only while it is the open session
   * (sessionVisible, :959-966). Two browsers are two clients: each presses the page's own New session control.
   */
  const h = harness('blank-two-clients')
  const elsewhere = fixtureDir('blank-two-clients-elsewhere')
  let server
  let clientA
  let clientB
  try {
    server = await blankSessionServer(h)
    const { live, call, branch } = server
    /** One press of the panel's New session; resolves with the selected session before and after, and the session rows. */
    const press = `(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const selected = () => document.querySelector('#tree li[data-kind="session"][aria-selected="true"]')?.dataset.sessionId ?? null
      for (let attempt = 0; attempt < 60 && document.querySelector('#tree li[data-kind="workspace"]') === null; attempt += 1) await wait(150)
      await wait(300)
      const before = selected()
      document.getElementById('new-session').click()
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await wait(150)
        const now = selected()
        if (now !== null && now !== before) break
      }
      await wait(700)
      return JSON.stringify({ before, after: selected(), rows: [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.dataset.sessionId), note: document.getElementById('tree-note')?.textContent ?? '' })
    })()`
    const rows = `JSON.stringify([...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.dataset.sessionId))`

    clientA = await openBrowser()
    await clientA.goto(live.url)
    await clientA.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    const a = JSON.parse(await clientA.evaluate(press, 20_000))
    assert.ok(typeof a.after === 'string' && a.after !== a.before, `client A's New session opens a session\nsaw: ${JSON.stringify(a)}`)

    clientB = await openBrowser()
    await clientB.goto(live.url)
    await clientB.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    const b = JSON.parse(await clientB.evaluate(press, 20_000))
    assert.ok(typeof b.after === 'string', `client B's New session opens a session\nsaw: ${JSON.stringify(b)}`)
    assert.notEqual(b.after, a.after, `client B's New session is not client A's session\nA: ${JSON.stringify(a)}\nB: ${JSON.stringify(b)}`)
    const again = JSON.parse(await clientB.evaluate(press, 20_000))
    assert.ok(typeof again.after === 'string' && again.after !== b.after && again.after !== a.after, `a second press makes another, as DSH's does\nsaw: ${JSON.stringify(again)}`)

    const listed = (await call('/api/sessions')).body.filter((meta) => meta.cwd === branch)
    const ids = new Set(listed.map((meta) => meta.id))
    assert.ok([a.after, b.after, again.after].every((id) => ids.has(id)), `the server holds all three sessions\nsaw: ${JSON.stringify([...ids])}`)
    assert.equal(listed.find((meta) => meta.id === a.after)?.turns ?? 0, 0, "and client A's is still empty, waiting for A")

    /**
     * Each client's rows: only its own open blank, never the other's nor an older one of its own. A turn elsewhere makes both
     * pages redraw their trees from the server, so the rows below are drawn from the same list.
     */
    const turn = await server.post('/api/turn', { prompt: 'a turn somewhere else, so both trees redraw', folder: elsewhere })
    assert.equal(turn.status, 200, `a turn elsewhere runs (${String(JSON.stringify(turn.body)).slice(0, 300)})`)
    await new Promise((done) => setTimeout(done, 1500))
    const rowsA = JSON.parse(await clientA.evaluate(rows))
    const rowsB = JSON.parse(await clientB.evaluate(rows))
    assert.ok(rowsA.includes(a.after), `client A still sees its own blank\nsaw: ${JSON.stringify(rowsA)}`)
    assert.ok(!rowsA.includes(b.after) && !rowsA.includes(again.after), `and none of client B's\nsaw: ${JSON.stringify(rowsA)}`)
    assert.deepEqual(
      rowsB.filter((id) => [a.after, b.after, again.after].includes(id)),
      [again.after],
      `client B sees its open blank only: not A's, not its own older one\nsaw: ${JSON.stringify(rowsB)}`,
    )
  } finally {
    await clientA?.close()
    await clientB?.close()
    server?.live.kill()
    removeDir(h.home)
    removeDir(h.work)
    removeDir(elsewhere)
  }
})

test('the panel follows the selection: a session offers two views, a file one, and a folder changes nothing', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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
    /** The page opens no session on its own (#17), so the session these rules are about is the one it is told to open. */
    await browser.gotoSession(live.url, parseJson(created.stdout).session)
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
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
    /**
     * A first turn, so the session is not a blank: DSH's blank row offers no menu at all (`!row.blank &&`,
     * dsh-client-ui-workspace lib/client.js:2317-2323, #79), and this is the menu's check. The turn names it automatically.
     */
    const turn = await runCli(adminArgs(h, ['--turn', 'a session to rename from its menu']), { env: h.env, cwd: join(h.work, '_tools_', 'some-tool') })
    assert.equal(turn.code, 0, turn.stderr)
    const auto = (await sessionsOf(h)).find((meta) => meta.id === made.session)?.title

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    /** The page opens no session on its own (#17); this one is opened, so its row is the session row drawn. */
    await browser.gotoSession(live.url, made.session)
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
        const item = [...document.querySelectorAll('#tree .menu:not([hidden]) button')].find((button) => button.textContent === 'Rename')
        if (item === undefined) return { error: 'no rename item', items }
        /** DSH's Rename session dialog, filled the way a person types: the field, its input event, then Rename. */
        item.click(); await wait(250)
        const dialog = document.getElementById('session-rename')
        const input = document.getElementById('session-rename-input')
        const confirm = document.getElementById('session-rename-confirm')
        if (dialog === null || !dialog.open) return { error: 'Rename opened no dialog', items }
        const draft = { value: input.value, confirm: confirm.disabled ? 'disabled' : 'enabled' }
        input.value = 'a session with a name'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        confirm.click(); await wait(1800)
        const after = rows().find((entry) => entry.parentElement.dataset.kind === 'session')
        return { label, items, draft, closed: !dialog.open, renamed: after.querySelector('.label').textContent, folder: after.dataset.definition ?? null, tooltip: after.getAttribute('title') }
      })().then((value) => JSON.stringify(value))`, 30_000),
    )

    assert.equal(reading.error, undefined, `the session row offers its menu\nsaw: ${JSON.stringify(reading)}`)
    /**
     * DSH's names, verbatim — that is the parity claim, so the check names every item rather than just the one it clicks.
     * A menu that drifts back to `Pin` / `Rename…` / `Fork` / `Archive` is a menu nobody who knows DSH recognises. DSH's
     * menu ends with `Copy Session ID` (row C20; judged by 80's check-session-id.mjs).
     */
    assert.deepEqual(
      reading.items,
      ['Pin session', 'Rename', 'Fork session', 'Archive session', 'Copy Session ID'],
      `the menu reads what DSH's reads\nsaw: ${reading.items.join(', ')}`,
    )
    /**
     * Its first prompt named it, so the row reads that title (DSH's `displayTitle`, dsh-client-ui-workspace
     * lib/client.js:1801-1804), not its folder's clock name (#24).
     */
    assert.equal(reading.label, auto, `the row reads the title its first prompt gave it\nsaw: ${JSON.stringify(reading)}`)
    /** DSH: the dialog starts with the stored title, and Rename waits only for a non-blank draft, an unchanged one included. */
    assert.deepEqual(reading.draft, { value: auto, confirm: 'enabled' }, `the dialog starts from the stored title\nsaw: ${JSON.stringify(reading.draft)}`)
    assert.equal(reading.closed, true, 'Rename closes the dialog once the server accepted the name')
    assert.equal(reading.renamed, 'a session with a name', 'after the rename the row shows the name it was given')
    const folderName = basename(dirname(String(made.definition)))
    assert.match(folderName, /^session-\d{8}-\d{4}$/, 'the definition folder is named for the clock')
    assert.equal(reading.folder, join(h.work, '_tools_', 'some-tool', '_sessions_', folderName), 'and stays reachable in data-definition, because it is the identity')
    assert.equal(reading.tooltip, 'a session with a name', 'while the tooltip is the new name, never the folder (#109)')

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

test("a double-click on a session's title opens DSH's Rename session dialog, prefilled, where an unchanged title pins and a blank one is refused", async (context) => {
  /**
   * DSH (`dsh-client-ui-workspace`, `RenameSession.js` and the session row's `onDoubleClick`): a double-click on a row's
   * title raises the same rename request as the menu and the chord. The dialog is `Rename session`, its field `Session
   * name` starts with the stored title and is selected, `Rename` waits only for a non-blank draft — an unchanged title is
   * NOT refused, and confirming it records the automatic title as the person's own — Enter confirms, Cancel writes nothing.
   * The press is trusted pointer input, two clicks with `clickCount` 1 then 2, because that is the gesture a person makes.
   */
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-rename-dialog')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const created = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(created.code, 0, `the session was created\n${created.stdout}${created.stderr}`)
    const made = parseJson(created.stdout)
    /** The first prompt names the session automatically; the definition carries no title until a person gives one. */
    const turn = await runCli(adminArgs(h, ['--turn', 'name me from my first prompt']), { env: h.env, cwd: join(h.work, '_tools_', 'some-tool') })
    assert.equal(turn.code, 0, turn.stderr)
    const auto = (await sessionsOf(h)).find((meta) => meta.id === made.session)?.title
    assert.equal(auto, 'name me from my first prompt', 'the first prompt is the automatic title')
    const definitionFile = join(String(made.definition).replace('/session.json', ''), 'session.json')
    assert.equal(JSON.parse(readFileSync(definitionFile, 'utf8')).title, undefined, 'and the definition has no title yet')

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const opened = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (document.querySelector('#tree li[data-kind="session"] > .row > .label') !== null) break
          await wait(150)
        }
        return JSON.stringify({ sessions: [...document.querySelectorAll('#tree li[data-kind="session"] > .row > .label')].map((label) => label.textContent) })
      })()`, 30_000),
    )
    assert.ok(opened.sessions.includes(auto), `the session row reads its automatic title\nsaw: ${JSON.stringify(opened)}`)

    /** Two trusted presses on the title, the second with `clickCount: 2`, which is what makes the browser fire `dblclick`. */
    const doubleClickTitle = async () => {
      const at = JSON.parse(
        await browser.evaluate(`(() => {
          const label = [...document.querySelectorAll('#tree li[data-kind="session"] > .row > .label')].find((entry) => entry.closest('li').dataset.rowKey === ${JSON.stringify('session:' + made.session)})
          if (label === undefined) return JSON.stringify({ error: 'no title' })
          const rect = label.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(rect.left + Math.min(24, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) })
        })()`),
      )
      assert.equal(at.error, undefined, `the session row has a title to press\nsaw: ${JSON.stringify(at)}`)
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
      for (const clickCount of [1, 2]) {
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount })
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount })
      }
      await browser.waitFor(`document.getElementById('session-rename')?.open === true`, 5_000)
    }
    const dialogState = `JSON.stringify((() => {
      const dialog = document.getElementById('session-rename')
      const input = document.getElementById('session-rename-input')
      return {
        open: dialog.open,
        heading: document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent,
        field: input.getAttribute('aria-label'),
        value: input.value,
        focused: document.activeElement === input,
        selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
        confirm: document.getElementById('session-rename-confirm').disabled ? 'disabled' : 'enabled',
      }
    })())`
    const type = (value) => browser.evaluate(`(() => { const input = document.getElementById('session-rename-input'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)

    await doubleClickTitle()
    const first = JSON.parse(await browser.evaluate(dialogState))
    assert.deepEqual(
      first,
      { open: true, heading: 'Rename session', field: 'Session name', value: auto, focused: true, selected: true, confirm: 'enabled' },
      "the double-click opens DSH's dialog, the field holding the stored title, selected, and Rename ready for it unchanged",
    )
    await type('   ')
    assert.equal(JSON.parse(await browser.evaluate(dialogState)).confirm, 'disabled', 'a blank name cannot be confirmed')
    await type(auto)
    assert.equal(JSON.parse(await browser.evaluate(dialogState)).confirm, 'enabled', 'the unchanged name can')
    await browser.evaluate(`document.getElementById('session-rename-confirm').click()`)
    await browser.waitFor(`document.getElementById('session-rename').open === false`, 10_000)
    assert.equal((await sessionsOf(h)).find((meta) => meta.id === made.session)?.title, auto, 'confirming it unchanged keeps the title')
    assert.equal(JSON.parse(readFileSync(definitionFile, 'utf8')).title, auto, 'and records it in the definition as a name a person chose')

    /** Cancel writes nothing. */
    await doubleClickTitle()
    await type('a name nobody confirmed')
    await browser.evaluate(`[...document.querySelectorAll('#session-rename [data-ws-close]')].find((button) => button.textContent === 'Cancel').click()`)
    await browser.waitFor(`document.getElementById('session-rename').open === false`, 5_000)
    assert.equal((await sessionsOf(h)).find((meta) => meta.id === made.session)?.title, auto, 'Cancel leaves the title alone')

    /** Enter confirms a new name, and the row follows. */
    await doubleClickTitle()
    await type('  renamed by a double-click  ')
    await browser.evaluate(`document.getElementById('session-rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
    await browser.waitFor(
      `document.getElementById('session-rename').open === false && [...document.querySelectorAll('#tree li[data-kind="session"] > .row > .label')].some((label) => label.textContent === 'renamed by a double-click')`,
      10_000,
    )
    assert.equal((await sessionsOf(h)).find((meta) => meta.id === made.session)?.title, 'renamed by a double-click', 'Enter renames, trimmed as DSH sends it')
    assert.equal(JSON.parse(readFileSync(definitionFile, 'utf8')).title, 'renamed by a double-click', 'and the definition follows')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a session's first prompt is titled by the session's own model, not by the cut prompt", async (context) => {
  /**
   * R-developer-eight-12 (DSH parity C6). DSH mounts dsh-session-title with its first-prompt model provider in the base
   * profile: on a session's first prompt the fallback name (the prompt's leading words) appears at once, then the session's
   * own route is asked for a title (purpose session-title, the turn's endpoint and model) and the answer replaces the
   * fallback. Heddle titled a session with the prompt cut to 48 characters and asked nothing. The scripted endpoint answers
   * the title call with its session-title step, so the generated title is known here; the turn takes the untagged step.
   * The title lands without delaying the turn, so it is read until it arrives rather than once.
   */
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  const h = harness('auto-title')
  const generated = 'Northern revenue year on year'
  const prompt = 'Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.'
  scriptedConfig({ home: h.home, steps: [{ purpose: 'session-title', text: `**${generated}**\nA title for your request.` }, { text: 'a scripted answer' }] })
  const folder = join(h.work, 'ws-title')
  mkdirSync(folder, { recursive: true })
  let live
  try {
    const made = await runCli(adminArgs(h, ['session', 'new', folder, '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, `the session was created\n${made.stdout}${made.stderr}`)
    const created = parseJson(made.stdout)
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const turn = await fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: created.session, prompt }),
    })
    const stream = await turn.text()
    assert.equal(turn.status, 200, `the first turn ran\n${stream}`)
    assert.match(stream, /a scripted answer/, 'the turn was answered by the turn step, not the title step')

    const titleNow = async () => {
      const response = await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })
      const listed = await response.json()
      return listed.find((meta) => meta.id === created.session)?.title
    }
    let title = await titleNow()
    for (let attempt = 0; attempt < 40 && title !== generated; attempt += 1) {
      await new Promise((done) => setTimeout(done, 250))
      title = await titleNow()
    }
    assert.notEqual(title, 'Please summarise the quarterly revenue figures…', 'the title is not the first prompt cut short')
    assert.equal(title, generated, `the first line of the model's answer, its emphasis removed, is the session's title\nsaw: ${JSON.stringify(title)}`)
    assert.equal((await sessionsOf(h)).find((meta) => meta.id === created.session)?.title, generated, 'and the store holds it')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a conversation started through the turn route is titled by the session's own model too", async (context) => {
  /**
   * #68, the twin of the check above for a session no blank row opened first: `POST /api/turn {prompt, folder, new: true}`,
   * a turn with no session and no folder (the page's send with nothing selected), and the CLI's `--new --turn`. DSH
   * writes no title when a session is created; dsh-session-title writes the fallback from the first eligible human
   * message (lib/index.js:396-403, 620-648) and asks the first-prompt provider only for a session with no title yet
   * (:387). Measured before on both builds: the turn route and the CLI opened the session titled with the prompt cut to
   * 60 characters, so no title call started and `Please summarise the quarterly revenue figures for the north` stayed.
   * The CLI is judged with a title step that fails, because a one-shot process may end before an answer lands: what it
   * leaves is the fallback the first message wrote, cut at a word.
   */
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  const h = harness('turn-route-title')
  const generated = 'Northern revenue year on year'
  const prompt = 'Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.'
  const fallback = 'Please summarise the quarterly revenue figures…'
  scriptedConfig({ home: h.home, steps: [{ purpose: 'session-title', text: `**${generated}**\nA title for your request.` }, { text: 'a scripted answer' }] })
  const folder = join(h.work, 'ws-turn-title')
  mkdirSync(folder, { recursive: true })
  let live
  try {
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const listed = async () => (await (await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })).json())
    const turnOpens = async (body) => {
      const before = new Set((await listed()).map((meta) => meta.id))
      const turn = await fetch(new URL('/api/turn', live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const stream = await turn.text()
      assert.equal(turn.status, 200, `the turn ran\n${stream}`)
      assert.match(stream, /a scripted answer/, 'the turn was answered by the turn step, not the title step')
      const made = (await listed()).filter((meta) => !before.has(meta.id))
      assert.equal(made.length, 1, `the turn opened one new session\n${JSON.stringify(made)}`)
      return made[0].id
    }
    const titleSettles = async (id) => {
      let title
      for (let attempt = 0; attempt < 40 && title !== generated; attempt += 1) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, 250))
        title = (await listed()).find((meta) => meta.id === id)?.title
      }
      return title
    }

    const fresh = await turnOpens({ prompt, folder, new: true })
    const freshTitle = await titleSettles(fresh)
    assert.notEqual(freshTitle, prompt.slice(0, 60), 'the title is not the prompt cut mid-word at 60 characters')
    assert.equal(freshTitle, generated, `new: true in a folder: the model's title replaces the fallback\nsaw: ${JSON.stringify(freshTitle)}`)

    const loose = await turnOpens({ prompt })
    const looseTitle = await titleSettles(loose)
    assert.equal(looseTitle, generated, `no session and no folder: the same\nsaw: ${JSON.stringify(looseTitle)}`)

    scriptedConfig({ home: h.home, steps: [{ purpose: 'session-title', error: { message: 'the title model is down' } }, { text: 'a scripted answer' }] })
    const cli = await runCli(adminArgs(h, ['--new', '--turn', prompt, '--json']), { env: h.env, cwd: folder })
    assert.equal(cli.code, 0, `the CLI turn ran\n${cli.stdout}${cli.stderr}`)
    const made = parseJson(cli.stdout)
    const cliTitle = (await sessionsOf(h)).find((meta) => meta.id === made.session)?.title
    assert.equal(cliTitle, fallback, `--new --turn: the first message wrote the fallback at a word, which a failed call leaves\nsaw: ${JSON.stringify(cliTitle)}`)
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is pinned and archived in the store, and the tree follows both', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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
    /**
     * Archiving **drops the pin**: the two flags are mutually exclusive in the reference, and this check used to
     * assert the opposite until the store learned the rule. The pin is gone with the archive, not restored by it.
     */
    assert.equal(back?.pinned, undefined, 'and the pin went with the archive')

    /** And pinning an archived session is refused, which is the same rule seen from the other side. */
    const refusedPin = await commit(older.session, { pinned: true })
    assert.equal(refusedPin.status, 409, 'an archived session cannot be pinned')
    assert.equal((await refusedPin.json()).code, 'archived', 'and the refusal names the reason')

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
    await commit(older.session, { archived: false })
    const restored = await listed(false)
    assert.ok(restored.some((node) => node.label === older.name), 'unarchiving brings it back')
    assert.equal(restored.find((node) => node.label === older.name)?.pinned, undefined, 'still unpinned, since the archive dropped it')
    /** And a pin after unarchiving is accepted and carries its time, which is the order among several pins. */
    assert.equal((await commit(older.session, { pinned: true })).status, 200, 'a session can be pinned again once it is back')
    const rePinned = (await listed(false)).find((node) => node.label === older.name)
    assert.match(String(rePinned?.pinnedAt), /^\d{4}-\d{2}-\d{2}T/, 'with the time it was pinned')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session forks into a new one named after it, with its conversation and its own definition', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
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

    /** The child records the session it was cut from — the provenance a reader needs to tell two continuations apart. */
    const afterFirst = await sessionsOf(h)
    assert.equal(afterFirst.find((meta) => meta.id === forked.session)?.parentSession, made.session, 'the fork records its parent')

    /**
     * Forking a **fork** increments the ordinal in place rather than appending another one: DSH's `increasedForkTitle`
     * turns `x (1)` into `x (2)`, and the version here used to produce `x (1) (1)`.
     */
    const second = await (
      await fetch(new URL(`/api/sessions/${forked.session}/fork`, live.url), { method: 'POST', headers: { cookie } })
    ).json()
    const afterSecond = await sessionsOf(h)
    assert.equal(afterSecond.find((meta) => meta.id === second.session)?.title, `${title} (2)`, `a fork of a fork increments the ordinal in place\nsaw: ${JSON.stringify(afterSecond.map((meta) => [meta.title, meta.id === second.session]))}`)
    assert.equal(afterSecond.find((meta) => meta.id === second.session)?.parentSession, forked.session, 'and records the fork it came from')

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

test("a fork is named from its source's title alone: a second fork of T is T (1) again (#67)", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork-title')
  let live
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    await runCli(adminArgs(h, ['--turn', 'a conversation worth forking']), { env: h.env, cwd: branch })

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const post = (path, body) =>
      fetch(new URL(path, live.url), {
        method: 'POST',
        headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    const fork = async (id) => {
      const response = await post(`/api/sessions/${id}/fork`)
      assert.equal(response.status, 200, `${id} forks\n${await response.clone().text()}`)
      return (await response.json()).session
    }
    const titleOf = async (id) => (await sessionsOf(h)).find((meta) => meta.id === id)?.title
    assert.equal((await post(`/api/sessions/${made.session}/title`, { title: 'T' })).status, 200, 'the source is named T')

    /**
     * DSH's table in #67, read from its code: `increasedForkTitle(sourceTitle)` (`dsh-api-session-controller`
     * lib/client.js:3714-3720, applied at :4003) looks at the source's title and nothing else. Measured on both builds
     * before the fix: T (1), T (2), T (3), T (4), because every number another session held was skipped.
     */
    const first = await fork(made.session)
    const second = await fork(made.session)
    const ofFirst = await fork(first)
    assert.equal((await post(`/api/sessions/${ofFirst}/flags`, { archived: true })).status, 200, 'the fork of the first fork is archived')
    const ofArchived = await fork(ofFirst)
    const seen = { first: await titleOf(first), second: await titleOf(second), ofFirst: await titleOf(ofFirst), ofArchived: await titleOf(ofArchived) }
    assert.deepEqual(
      seen,
      { first: 'T (1)', second: 'T (1)', ofFirst: 'T (2)', ofArchived: 'T (3)' },
      `fork T, fork T again, fork the first fork, fork the archived T (2): DSH names them T (1), T (1), T (2), T (3)\nsaw: ${JSON.stringify(seen)}`,
    )
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

/**
 * Fork a session through the server and read both conversations as the chat draws them.
 *
 * The rows are compared on what a person reads — the kind, the text, a call's name and its result — so the claim is
 * the one DSH makes: a fork is seeded with its source's own events (dsh-session fork.js buildForkSeed, cut at the last
 * completed turn by the session controller), so the branch shows the source's turns as they were.
 */
async function forkAndRead(h, source) {
  const live = await startServer(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
    { ...h.env, HOME: h.home },
  )
  try {
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const response = await fetch(new URL(`/api/sessions/${source}/fork`, live.url), { method: 'POST', headers: { cookie } })
    assert.equal(response.status, 200, `the session forks\n${await response.clone().text()}`)
    const forked = await response.json()
    const rows = async (id) =>
      ((await (await fetch(new URL(`/api/sessions/${id}`, live.url), { headers: { cookie } })).json()).turns ?? []).map((turn) => ({
        kind: turn.kind,
        text: turn.text,
        ...(turn.name !== undefined ? { name: turn.name } : {}),
        ...(turn.result !== undefined ? { result: turn.result } : {}),
      }))
    return { fork: forked.session, source: await rows(source), forked: await rows(forked.session) }
  } finally {
    live.kill()
  }
}

test("a fork of a reasoning turn shows the reasoning as its own row, the answer alone, and the call by name (#52)", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork-reasoning')
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    /** One turn of two rounds: reasoning and a tool call, then the answer — the shape a thinking model streams. */
    scriptedConfig({
      home: h.home,
      steps: [{ reasoning: '17 × 23 = 391.', toolCall: { name: 'bash', arguments: { command: 'echo FORKTOOL-77' } } }, { text: '391' }],
    })
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    const turn = await runCli(adminArgs(h, ['--resume', made.session, '--turn', 'What is 17 times 23? Think it through, then reply with the number only.']), { env: h.env, cwd: branch })
    assert.equal(turn.code, 0, `the turn ran\n${turn.stdout}${turn.stderr}`)

    const read = await forkAndRead(h, made.session)
    const kinds = read.source.map((row) => row.kind)
    assert.deepEqual(kinds, ['user', 'reasoning', 'tool', 'assistant'], `the source shows a reasoning row, a call and an answer\nsaw: ${JSON.stringify(read.source)}`)
    /**
     * Measured on both builds before the fix: the fork drew one answer row "17 × 23 = 391.391" with no reasoning row,
     * and the call as an empty answer row plus a tool row with no name or command.
     */
    assert.deepEqual(read.forked, read.source, `the fork shows the same rows\nsource: ${JSON.stringify(read.source)}\nfork:   ${JSON.stringify(read.forked)}`)
    assert.equal(read.forked.find((row) => row.kind === 'assistant')?.text, '391', 'so its answer is the answer alone')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a fork of a compacted session shows every turn of its source, not only the ones after the summary (#55)', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork-compacted')
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const steps = [
      { reasoning: 'thinking about the part', text: `part answer ${'x'.repeat(2000)}` },
      { purpose: 'compaction', text: 'the briefing: the code word is WALRUS-9' },
    ]
    scriptedConfig({ home: h.home, steps })
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    const say = async (prompt) => {
      const turn = await runCli(adminArgs(h, ['--resume', made.session, '--turn', prompt]), { env: h.env, cwd: branch })
      assert.equal(turn.code, 0, `the turn ran\n${turn.stdout}${turn.stderr}`)
    }
    const first = 'Remember the code word WALRUS-9. Reply with only: noted.'
    await say(first)
    /**
     * The window is set from what the first request measured, so the compaction lands a couple of turns later whatever
     * the profile's tools and prompt weigh: the trigger is 80% of the endpoint's window, a little above the first request.
     */
    const measured = readTranscript(join(h.home, 'sessions', made.session)).find((event) => event.type === 'model/request')?.estimatedTokens
    assert.ok(typeof measured === 'number' && measured > 0, 'the first request recorded what it weighed')
    writeFileSync(h.config, `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(h.home, 'script.json'), model: 'scripted', contextWindow: Math.ceil((measured + 1300) / 0.8) }] })}\n`)
    for (const part of [1, 2, 3, 4]) await say(`Write about bridges, part ${part} ${'y'.repeat(1500)}`)
    const events = readTranscript(join(h.home, 'sessions', made.session))
    assert.ok(
      events.some((event) => event.type === 'compaction/end'),
      `the source was compacted, which is what this check is about\nrequests: ${JSON.stringify(events.filter((event) => event.type === 'model/request').map((event) => [event.estimatedTokens, event.thresholdTokens]))}`,
    )

    const read = await forkAndRead(h, made.session)
    assert.equal(read.source[0]?.text, first, 'the source still shows its first turn')
    /** Measured on both builds before the fix: the source showed 15 rows and the fork 4, starting at part 3. */
    assert.equal(read.forked[0]?.text, first, `the fork starts where its source started\nfork: ${JSON.stringify(read.forked.map((row) => [row.kind, row.text.slice(0, 40)]))}`)
    assert.deepEqual(read.forked, read.source, `and shows the same rows (${read.source.length} in the source, ${read.forked.length} in the fork)`)
    const copied = readTranscript(join(h.home, 'sessions', read.fork))
    assert.ok(copied.some((event) => event.type === 'compaction/end'), "the fork's log carries the compaction where it happened")
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a fork shows its source's turns and no more: the runtime-context note stays a note", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork-notes')
  let live
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    for (const prompt of ['the first question', 'the second question']) {
      const turn = await runCli(adminArgs(h, ['--turn', prompt]), { env: h.env, cwd: branch })
      assert.equal(turn.code, 0, `the turn ran\n${turn.stdout}${turn.stderr}`)
    }
    /**
     * The loop writes DSH's runtime-context snapshot into the source's log as a harness note. Without one the check
     * would prove nothing, so its presence is asserted first.
     */
    const isSnapshot = (event) => event.type === 'context/note' && event.origin === 'runtime-context'
    assert.ok(readTranscript(join(h.home, 'sessions', made.session)).some(isSnapshot), 'the source holds a runtime-context note')

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const response = await fetch(new URL(`/api/sessions/${made.session}/fork`, live.url), { method: 'POST', headers: { cookie } })
    assert.equal(response.status, 200, `the session forks\n${await response.clone().text()}`)
    const forked = await response.json()

    /**
     * DSH's fork seeds the child with the source's own events (dsh-session fork.js buildForkSeed), so the snapshot is
     * still a snapshot there and the child's chat shows exactly the source's prompts. Measured in phase A on both builds
     * (R-developer-eight-15): the child drew a "Current runtime context..." user bubble and counted one turn more.
     */
    const prompts = async (id) => {
      const detail = await (await fetch(new URL(`/api/sessions/${id}`, live.url), { headers: { cookie } })).json()
      return (detail.turns ?? []).filter((turn) => turn.kind === 'user').map((turn) => turn.text)
    }
    const fromSource = await prompts(made.session)
    assert.deepEqual(fromSource, ['the first question', 'the second question'], 'the source shows its two prompts')
    assert.deepEqual(await prompts(forked.session), fromSource, 'and the fork shows the same two, with no runtime-context bubble')

    const listed = await sessionsOf(h)
    assert.equal(
      listed.find((meta) => meta.id === forked.session)?.turns,
      listed.find((meta) => meta.id === made.session)?.turns,
      `the fork counts as many turns as its source\nsaw: ${JSON.stringify(listed.map((meta) => [meta.id === forked.session ? 'fork' : meta.id === made.session ? 'source' : 'other', meta.turns]))}`,
    )

    const copied = readTranscript(join(h.home, 'sessions', forked.session))
    assert.ok(copied.some(isSnapshot), "the fork's log carries the snapshot as a runtime-context note")
    assert.ok(
      !copied.some((event) => event.type === 'message' && JSON.stringify(event.message ?? {}).includes('Current runtime context')),
      'and no message carries it',
    )
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a fork at a chosen turn ends after that turn, and refuses a cut the reference refuses', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, await supportsFolderTree(), TREE_CAPABILITY)) return
  const h = harness('session-fork-at')
  let live
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    const asked = ['turn one', 'turn two', 'turn three']
    for (const prompt of asked) {
      const turn = await runCli(adminArgs(h, ['--turn', prompt]), { env: h.env, cwd: branch })
      assert.equal(turn.code, 0, `the turn ran\n${turn.stdout}${turn.stderr}`)
    }
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const detail = async (id) => (await fetch(new URL(`/api/sessions/${id}`, live.url), { headers: { cookie } })).json()
    const fork = (id, body) =>
      fetch(new URL(`/api/sessions/${id}/fork`, live.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

    /**
     * DSH's chat footer branches with atSeq set to the seq that ended the turn (dsh-client-ui-chat TurnTailNodeView and
     * forkAt; the cut is inclusive, dsh-api-session-controller session/fork). The transcript carries that seq on each
     * completed turn's closing answer, which is what the page's Branch action sends. Phase A (R-developer-eight-16):
     * atSeq was ignored and the child held every turn.
     */
    const source = await detail(made.session)
    const ends = (source.turns ?? []).filter((turn) => Number.isSafeInteger(turn.forkSeq)).map((turn) => turn.forkSeq)
    const ended = (await readTranscript(join(h.home, 'sessions', made.session))).filter((event) => event.type === 'turn/completed').map((event) => event.seq)
    assert.deepEqual(ends, ended, `each completed turn's answer carries its turn/completed seq\nsaw: ${JSON.stringify(source.turns)}`.slice(0, 600))

    const atTwo = await fork(made.session, { atSeq: ends[1] })
    assert.equal(atTwo.status, 200, `a fork at the second turn's end is made\n${await atTwo.clone().text()}`)
    const child = (await atTwo.json()).session
    const prompts = ((await detail(child)).turns ?? []).filter((turn) => turn.kind === 'user').map((turn) => turn.text)
    assert.deepEqual(prompts, asked.slice(0, 2), 'the child ends after turn two')
    const listed = await sessionsOf(h)
    const title = listed.find((meta) => meta.id === made.session)?.title ?? ''
    assert.equal(listed.find((meta) => meta.id === child)?.title, `${title} (1)`, 'it is titled after its source, as a row fork is')
    assert.equal(listed.find((meta) => meta.id === child)?.parentSession, made.session, 'and records its parent')

    /** DSH's two refusals, in its words: a value that is not a non-negative safe integer, and a seq the source lacks. */
    for (const bad of [-1, 1.5, 'two']) {
      const refused = await fork(made.session, { atSeq: bad })
      assert.equal(refused.status, 400, `atSeq ${JSON.stringify(bad)} is a bad request`)
      assert.equal((await refused.json()).error, 'atSeq must be a non-negative safe integer')
    }
    const last = ended.length === 0 ? -1 : Math.max(...(await readTranscript(join(h.home, 'sessions', made.session))).map((event) => event.seq))
    const missing = await fork(made.session, { atSeq: 99999 })
    assert.equal(missing.status, 409, 'a seq the source does not have is refused')
    assert.equal((await missing.json()).error, `event 99999 does not exist in session "${made.session}" (last seq: ${last})`)

    /** Without atSeq the fork still cuts at the last completed turn. */
    const whole = await fork(made.session, {})
    assert.equal(whole.status, 200, 'a fork without atSeq is made')
    const all = ((await detail((await whole.json()).session)).turns ?? []).filter((turn) => turn.kind === 'user').map((turn) => turn.text)
    assert.deepEqual(all, asked, 'and holds every completed turn')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a session row's controls appear on hover, and a search replaces the tree with named hits", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
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
    /**
     * Park the pointer in the conversation panel before reading the quiet row: the browser keeps its last pointer position, and a
     * row under it is already hovered — where the age is deliberately not rendered, so the resting rule could not be read.
     */
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 })

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        /** Capture uncaught page errors: a render that throws is otherwise indistinguishable from missing data. */
        window.__probeErrors = []
        window.addEventListener('error', (event) => window.__probeErrors.push(String(event.message)))
        window.addEventListener('unhandledrejection', (event) => window.__probeErrors.push(String(event.reason)))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        /** The page and its first tree fetch are asynchronous; wait for a row before clicking one. */
        for (let attempt = 0; attempt < 20 && document.querySelectorAll('#tree .row').length === 0; attempt += 1) await wait(150)
        const firstRow = document.querySelectorAll('#tree .row')[0]
        if (firstRow === undefined) return { error: 'the tree drew no rows' }
        firstRow.click(); await wait(700)
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
        /**
         * Open a level only if it is closed. A blind click toggles: the tree may already have a level open (this UI
         * remembers its expansion set in localStorage, and the page may have restored it), and clicking an open branch
         * closes it — which is how an earlier probe "lost" the session rows and blamed the UI.
         */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row !== undefined) {
              const li = row.parentElement
              if (li !== null && li.dataset.open !== 'true') row.click()
              await wait(250)
              if (li !== null && li.dataset.open === 'true') return true
              continue
            }
            await wait(150)
          }
          return false
        }
        await ensureOpen(rows()[0].querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        for (let attempt = 0; attempt < 25 && document.querySelectorAll('#tree li[data-kind="session"]').length === 0; attempt += 1) await wait(200)
        const sessions = [...document.querySelectorAll('#tree li[data-kind="session"]')]
        if (sessions.length === 0) {
          return {
            error: 'no session rows in the tree',
            labels: [...document.querySelectorAll('#tree .row .label')].map((label) => label.textContent),
            kinds: [...document.querySelectorAll('#tree li')].map((li) => li.dataset.kind),
            note: document.getElementById('tree-note')?.textContent ?? null,

            toolFound: rowFor('some-tool') !== undefined,
            pageErrors: window.__probeErrors,
            api: await (async () => {
              const path = rowFor('some-tool')?.dataset.path
              if (path === undefined) return null
              try {
                const body = await (await fetch('/api/tree?path=' + encodeURIComponent(path))).json()
                return { children: (body.children ?? []).map((child) => ({ kind: child.kind, label: child.label, hasSession: child.session !== undefined })) }
              } catch (error) {
                return { error: String(error) }
              }
            })(),
          }
        }
        const controls = sessions.map((li) => ({
          label: li.querySelector(':scope > .row > .label')?.textContent,
          slots: [...li.querySelectorAll(':scope > .row .row-tools > *')].map((child) => child.className),
          buttons: [...li.querySelectorAll(':scope > .row .session-actions button')].map((b) => b.getAttribute('aria-label')),
          /**
           * Not hovered yet: DSH keeps the row quiet until the pointer arrives. The tail swaps its children by **display** now
           * (age/marker out, controls in, all in one right-aligned flow), so the quiet state is read as "not rendered".
           */
          quiet: li.querySelector(':scope > .row .row-tools') === null ? null : getComputedStyle(li.querySelector(':scope > .row .row-tools')).display,
        }))
        /**
         * A pointer cannot be moved from script, so the rule is read through its **other half**: the same selector
         * also answers the focus-within selector, and focusing a control in the row is what a keyboard user does.
         */
        const target = sessions.find((li) => li.querySelector(':scope > .row .session-actions button') !== null) ?? sessions[0]
        /**
         * Focus the **row**, not one of its controls: the controls are not rendered until the row is focused, so a control cannot
         * be the thing that receives focus first. A row is a focusable treeitem, which is the keyboard path a person takes.
         */
        /** The row element, the tree item's one Tab stop since #92 (the item itself is no longer focusable). */
        target.querySelector(':scope > .row').focus()
        await wait(200)
        const focused = {
          display: getComputedStyle(target.querySelector(':scope > .row .row-tools')).display,
          ageDisplay: (() => { const age = target.querySelector(':scope > .row .age'); return age === null ? null : getComputedStyle(age).display })(),
          buttons: [...target.querySelectorAll(':scope > .row .session-actions button')].map((b) => b.getAttribute('aria-label')),
        }

        /**
         * The right-hand slot, measured the way it was measured in DSH: the age ends 8px inside the row, and the
         * controls sit in that same slot rather than beside it.
         */
        /** The row was focused earlier in this probe, and focus reveals the controls and hides the age; blur to read the quiet state. */
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        await wait(80)
        const quiet = target.querySelector(':scope > .row .age')
        const rowRect = target.querySelector(':scope > .row').getBoundingClientRect()
        const ageRect = quiet === null ? null : quiet.getBoundingClientRect()
        /**
         * The pinned marker is a slot in the row's right tail, and the empty-selector rule collapses it on every unpinned
         * row — the dynamic form of the fixed slot the owner reported. So an unpinned row's slot is in the DOM and 0 wide,
         * which is the property that gives the right side its space back.
         */
        const slotNode = target.querySelector(':scope > .row .pin-slot')
        const slotRect = slotNode?.getBoundingClientRect() ?? null
        const ageSlot = {
          rowRight: Math.round(rowRect.right),
          ageRight: ageRect === null ? null : Math.round(ageRect.right),
          slot: slotRect === null ? null : [Math.round(slotRect.width), Math.round(rowRect.right - slotRect.right)],
        }

        /** And a selection is DSH's: the same surface as a hover, no bar, no bold. */
        target.querySelector(':scope > .row').click(); await wait(1200)
        /**
         * Read from the tree as it is now: opening the session redraws the tree (leaving the first visit's New session takes
         * its row away, #17), so the element clicked may no longer be in the document, and a detached row's computed style
         * is empty.
         */
        const selectedLi = document.querySelector('#tree li[data-kind="session"][data-session-id="' + CSS.escape(target.dataset.sessionId) + '"]') ?? target
        const selectedRow = selectedLi.querySelector(':scope > .row')
        const selected = {
          background: getComputedStyle(selectedRow).backgroundColor,
          shadow: getComputedStyle(selectedRow).boxShadow,
          weight: getComputedStyle(selectedRow.querySelector('.label')).fontWeight,
        }
        const quietBackground = (() => {
          const other = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li !== selectedLi && li.dataset.sessionId !== target.dataset.sessionId)
          return other === undefined ? null : getComputedStyle(other.querySelector(':scope > .row')).backgroundColor
        })()

        /** DSH's View options control, where the archive filter lives: one control, three states, the current one marked. */
        const viewButton = document.querySelector('#view-options button')
        viewButton.click(); await wait(250)
        /**
         * The chrome's own ARIA, named after DSH's own controls: its tabs are role=tab inside a role=tablist with one
         * selected and a roving tabindex, its access control is named "Access mode, current <value>", and its model seat
         * "Select model, current <value>". A control named after its kind alone hides the value it is showing.
         */
        const chrome = {
          tablist: document.querySelector('#views')?.getAttribute('role') ?? null,
          tabs: [...document.querySelectorAll('#views button[role="tab"]')].map((tab) => ({
            selected: tab.getAttribute('aria-selected'),
            tabindex: tab.tabIndex,
          })),
          access: document.querySelector('#access')?.getAttribute('aria-label') ?? null,
          model: document.querySelector('#model-trigger')?.getAttribute('aria-label') ?? null,
          /** How each clickable thing announces itself to a mouse. */
          cursors: {
            row: (() => { const row = document.querySelector('#tree li[data-kind="session"] > .row'); return row === null ? null : getComputedStyle(row).cursor })(),
            rowControls: [...document.querySelectorAll('#tree li[data-kind="session"] .row-tools button')].slice(0, 2).map((button) => getComputedStyle(button).cursor),
            headerMenus: ['#session-more button', '#view-options button'].map((selector) => {
              const button = document.querySelector(selector)
              return button === null ? null : getComputedStyle(button).cursor
            }),
            tabs: [...document.querySelectorAll('#views button')].map((button) => getComputedStyle(button).cursor),
          },
          /** The view ring's own shape, and the user turn's alignment: both are visual parity claims. */
          ring: [...document.querySelectorAll('#views button')].map((button) => {
            const style = getComputedStyle(button)
            return { background: style.backgroundColor, radius: style.borderRadius, size: style.fontSize, weight: style.fontWeight, colour: style.color }
          }),
          ringGap: document.getElementById('views') === null ? null : getComputedStyle(document.getElementById('views')).gap,
          ringUnderline: (() => {
            const tab = [...document.querySelectorAll('#views button')].find((button) => button.getAttribute('aria-selected') === 'true')
            if (tab === undefined) return { height: null, background: null, bottom: null }
            const after = getComputedStyle(tab, '::after')
            return { height: after.height, background: after.backgroundColor, bottom: after.bottom }
          })(),
          rowHeights: {
            session: (() => { const row = document.querySelector('#tree li[data-kind="session"] > .row'); return row === null ? null : Math.round(row.getBoundingClientRect().height) })(),
            workspace: (() => { const row = document.querySelector('#tree li[data-kind="workspace"] > .row'); return row === null ? null : Math.round(row.getBoundingClientRect().height) })(),
          },
          /**
           * The live state, measured on the **element the stylesheet targets**: the owner's implementation moved the shimmer off
           * the answer's pseudo-element band and onto the **words of a running process row's title** — the rule on
           * details.turn with a running state, its summary title, a 105-degree clipped-text gradient named heddle-row-shimmer. A
           * synthetic row is attached for the measurement and removed after it, so the claim is about the rule rather than about
           * whichever turns a fixture happens to contain.
           */
          live: (() => {
            const log = document.getElementById('log')
            if (log === null) return { error: 'no log to measure' }
            const probe = document.createElement('details')
            probe.className = 'turn'
            probe.dataset.state = 'running'
            probe.style.position = 'absolute'
            probe.style.visibility = 'hidden'
            const summary = document.createElement('summary')
            const title = document.createElement('span')
            title.className = 'title'
            title.textContent = 'a running row'
            summary.append(title)
            probe.append(summary)
            log.append(probe)
            const running = getComputedStyle(title)
            const snapshot = {
              animationName: running.animationName,
              animationDuration: running.animationDuration,
              clip: running.webkitBackgroundClip || running.backgroundClip,
              backgroundImage: running.backgroundImage,
            }
            probe.remove()
            /**
             * And the band is gone from the answer body: the reference's shimmer is for a text label, and a first pass here copied
             * its mask as a full-row overlay, which the owner saw as a flashing ribbon across the answer.
             */
            const answer = document.querySelector('#log .turn.assistant')
            const band = answer === null ? null : getComputedStyle(answer, '::before')
            return {
              animationName: snapshot.animationName,
              duration: snapshot.animationDuration,
              clip: snapshot.clip,
              mask: snapshot.backgroundImage,
              answerBandAnimation: band === null ? null : band.animationName,
              rulePresent: [...document.styleSheets].some((sheet) => {
                try { return [...sheet.cssRules].some((rule) => (rule.cssText || '').includes('shimmer')) } catch (error) { return false }
              }),
            }
          })(),
          userTurn: (() => {
            const turn = document.querySelector('#log .turn.user')
            if (turn === null) return { alignSelf: null, radius: null, background: null, maxWidth: null, turnWidth: null, turnRight: null, logWidth: null, logRight: null, contentRight: null }
            /**
             * The bubble is the element that carries the shape; the turn wrapper only positions it. Measured on 2026-10-17:
             * reading the wrapper reported a 0px radius while the bubble itself is 20px, so the probe reads the bubble.
             */
            const bubble = turn.querySelector('.bubble') ?? turn
            const style = getComputedStyle(bubble)
            const log = document.getElementById('log')
            const logRect = log === null ? null : log.getBoundingClientRect()
            const logPaddingRight = log === null ? 0 : parseFloat(getComputedStyle(log).paddingRight)
            const turnRect = bubble.getBoundingClientRect()
            return {
              alignSelf: getComputedStyle(turn).alignSelf,
              radius: style.borderRadius,
              background: style.backgroundColor,
              maxWidth: style.maxWidth,
              turnWidth: Math.round(turnRect.width),
              turnRight: Math.round(turnRect.right),
              logWidth: logRect === null ? null : Math.round(logRect.width),
              logRight: logRect === null ? null : Math.round(logRect.right),
              contentRight: logRect === null ? null : Math.round(logRect.right - logPaddingRight),
            }
          })(),
        }

        /**
         * The menu's own box, surface and glyphs. Measured bug: it was absolutely placed inside a scrolling sidebar and
         * its left half was clipped by that overflow, which reads as a transparent menu with text over the rows behind
         * it. A menu is now placed in viewport coordinates, opaque, and every item carries a mark.
         */
        const openViewMenu = document.querySelector('#view-options .menu:not([hidden])')
        const viewMenuBox = openViewMenu === null ? null : openViewMenu.getBoundingClientRect()
        const menuChrome = openViewMenu === null ? null : {
          position: getComputedStyle(openViewMenu).position,
          background: getComputedStyle(openViewMenu).backgroundColor,
          insideViewport:
            viewMenuBox.x >= 0 &&
            viewMenuBox.y >= 0 &&
            viewMenuBox.right <= window.innerWidth &&
            viewMenuBox.bottom <= window.innerHeight,
          itemGlyphs: [...openViewMenu.querySelectorAll('button')].map((button) => button.querySelector('svg') !== null),
        }

        /** A long name must never reach the controls: the row's right-hand slot reserves the space. */
        const longNameRow = (() => {
          const li = document.querySelector('#tree li[data-kind="session"]')
          if (li === null) return { error: 'no session row' }
          const row = li.querySelector(':scope > .row')
          const label = row?.querySelector('.label')
          /**
           * The **tail** is the measure, not the controls: the controls are not rendered until the row is hovered or focused, so
           * their box is 0 while the row is quiet. The tail always occupies its width, and the label must stop before it.
           */
          const tail = row?.querySelector('.row-right')
          if (label === null || label === undefined || tail === null || tail === undefined) return { error: 'no label or tail' }
          const original = label.textContent
          label.textContent = 'a session whose name is long enough to reach the right edge of the row and keep going'
          void label.offsetWidth
          const labelRight = Math.round(label.getBoundingClientRect().right)
          const toolsLeft = Math.round(tail.getBoundingClientRect().left)
          label.textContent = original
          return { labelRight, toolsLeft, overlaps: labelRight > toolsLeft }
        })()

        const viewItems = [...document.querySelectorAll('#view-options .menu:not([hidden]) > *')].map((b) => ({
          heading: b.tagName === 'BUTTON' ? null : b.textContent.trim(),
          label: b.tagName === 'BUTTON' ? b.textContent.trim() : null,
          checked: b.getAttribute('aria-checked'),
        })).filter((item) => item.heading !== null || item.label !== null)
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
        return { controls, focused, ageSlot, selected, quietBackground, aria: ariaShape(), chrome, viewItems, search, cleared, menuChrome, longNameRow }
      })().then((value) => JSON.stringify(value))`, 30_000),
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
    /** A probe that could not reach the UI returns an explicit error instead of an object with holes. */
    assert.equal(reading.error, undefined, `the probe reached the tree and a session\nsaw: ${JSON.stringify(reading)}`)
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
      assert.equal(row.quiet, 'none', 'and they are not rendered while the row is quiet')
    }
    for (const row of withoutControls) {
      assert.equal(row.quiet, null, `a row that stands for no session draws no controls (${row.label})`)
    }
    assert.ok(
      reading.focused.display !== 'none',
      `focusing the row reveals them, which is the same rule the pointer gets\nsaw display ${reading.focused.display}`,
    )

    /**
     * The two rules the owner saw missing, judged as measurements rather than as impressions: the age is the row's
     * rightmost thing when the row is quiet, and the controls take the age's place when it is not.
     */
    assert.ok(reading.ageSlot.ageRight !== null, 'the row carries an age to place')
    /**
     * **No pin slot is reserved.** The mark became a badge beside the name (cycle: the owner's report that a fixed asset
     * on every row wasted the right-hand space), so an unpinned row's right slot holds only the age and the controls, and
     * the age ends exactly at the row's content inset — 8px inside its box, the reference's row rule.
     */
    const expectedGap = await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree li[data-kind="session"] > .row')][0]
      return Math.round(parseFloat(getComputedStyle(row).paddingRight))
    })()`)
    assert.ok(
      reading.ageSlot.slot === null || reading.ageSlot.slot[0] === 0,
      `an unpinned row draws no pin mark and reserves no visible slot\nsaw: ${JSON.stringify(reading.ageSlot)}`,
    )
    assert.equal(
      Math.round(reading.ageSlot.rowRight - reading.ageSlot.ageRight),
      expectedGap,
      `and its age ends at the content edge, ${expectedGap}px inside the row`,
    )
    assert.notEqual(reading.focused.display, 'none', 'and they are rendered once focus arrives')
    assert.equal(reading.focused.ageDisplay, 'none', 'while the age steps aside — the two swap in place, never overlap')

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

    /** The chrome's names, read from DSH's own controls: tabs say which is selected, and the two seats say their value. */
    assert.equal(reading.chrome.tablist, 'tablist', 'the view ring is a tablist')
    assert.equal(reading.chrome.tabs.filter((tab) => tab.selected === 'true').length, 1, 'with exactly one selected tab')
    assert.equal(reading.chrome.tabs.filter((tab) => tab.tabindex === 0).length, 1, 'and one reachable by Tab')
    assert.match(String(reading.chrome.access), /^Access mode, current: /, `the access control names its value\nsaw: ${reading.chrome.access}`)
    assert.match(String(reading.chrome.model), /^Select model, current /, `and so does the model seat\nsaw: ${reading.chrome.model}`)

    /**
     * **Cursor affordance**, the difference the owner felt with a mouse: a row was a hand while every control inside it
     * kept the platform arrow. Each of these is a thing a person clicks, so each must say so.
     */
    assert.equal(reading.chrome.cursors.row, 'pointer', 'a row is a hand')
    assert.deepEqual(reading.chrome.cursors.rowControls, ['pointer', 'pointer'], `so are the controls inside it\nsaw: ${JSON.stringify(reading.chrome.cursors.rowControls)}`)
    assert.deepEqual(reading.chrome.cursors.headerMenus, ['pointer', 'pointer'], `and both header menus\nsaw: ${JSON.stringify(reading.chrome.cursors.headerMenus)}`)
    assert.deepEqual(reading.chrome.cursors.tabs, ['pointer', 'pointer'], 'and the tabs')

    /**
     * **A menu is a floating, opaque, glyph-bearing surface.** The owner's two reports — "the dropdown is transparent" and
     * "the items have no icons" — were one clipping bug and one missing mark.
     */
    assert.equal(reading.menuChrome.position, 'fixed', `a menu floats in viewport coordinates\nsaw: ${JSON.stringify(reading.menuChrome)}`)
    assert.equal(reading.menuChrome.insideViewport, true, 'and is entirely on screen')
    assert.equal(reading.menuChrome.background, 'rgb(35, 35, 36)', 'with an opaque surface')
    /**
     * Eight items since C17 added DSH's `Manual` (dsh-client-ui-workspace/lib/client.js:2914-2918, with its chevrons
     * glyph): Workspace Tree, Workspace, In one list, Manual, Last updated, and the archive trio.
     */
    assert.deepEqual(reading.menuChrome.itemGlyphs, [true, true, true, true, true, true, true, true], `and a glyph on every item\nsaw: ${JSON.stringify(reading.menuChrome.itemGlyphs)}`)

    /** **A session's glyph is a conversation**, not a folder: the reference's bubble artwork, distinct from the folder path. */
    const glyphs = JSON.parse(
      await browser.evaluate(`(() => {
        const session = document.querySelector('#tree li[data-kind="session"] .icon svg path')
        const folder = document.querySelector('#tree li[data-kind="workspace"] .icon svg path') ?? document.querySelector('#tree li[data-kind="type"] .icon svg path')
        return JSON.stringify({
          session: session === null ? null : (session.getAttribute('d') ?? '').slice(0, 16),
          folder: folder === null ? null : (folder.getAttribute('d') ?? '').slice(0, 16),
          sessionPaths: document.querySelectorAll('#tree li[data-kind="session"] .icon svg path').length,
        })
      })()`),
    )
    assert.equal(glyphs.session, 'M2.37091 11.2501', `a session row draws the reference bubble glyph\nsaw: ${JSON.stringify(glyphs)}`)
    assert.notEqual(glyphs.folder, glyphs.session, 'and it is not the folder mark')
    assert.ok(glyphs.sessionPaths > 0, 'the bubble is drawn once per session row')

    /** **A long name ellipsizes before the controls**, never underneath them. */
    assert.equal(reading.longNameRow.overlaps, false, `a long name stops before the controls\nsaw: ${JSON.stringify(reading.longNameRow)}`)
    assert.ok(reading.longNameRow.toolsLeft - reading.longNameRow.labelRight >= 0, 'with at least no overlap between them')

    /**
     * **The view ring's shape**, measured from DSH's tablist: plain text, no background or border or radius, 13px at
     * weight 500, the selected tab told apart by colour alone. A tinted rounded box is a segmented control, not this ring.
     */
    assert.deepEqual(reading.chrome.ring, [
      { background: 'rgba(0, 0, 0, 0)', radius: '0px', size: '13px', weight: '500', colour: 'rgb(122, 170, 255)' },
      { background: 'rgba(0, 0, 0, 0)', radius: '0px', size: '13px', weight: '500', colour: 'rgb(173, 178, 184)' },
    ], `the ring draws DSH's plain tabs\nsaw: ${JSON.stringify(reading.chrome.ring)}`)

    /**
     * **The ring's measured geometry**: a 36px gap between DSH's tabs, and the selected tab marked by a 2px accent
     * underline drawn by `::after` — the part a first pass missed because it read only the element's own border.
     */
    assert.equal(reading.chrome.ringGap, '36px', `the tabs sit 36px apart\nsaw: ${reading.chrome.ringGap}`)
    assert.equal(reading.chrome.ringUnderline.height, '2px', `the selected tab is underlined\nsaw: ${JSON.stringify(reading.chrome.ringUnderline)}`)
    assert.equal(reading.chrome.ringUnderline.background, 'rgb(122, 170, 255)', 'in the accent colour')
    assert.equal(reading.chrome.ringUnderline.bottom, '-1px', 'one pixel below the padding box, as DSH draws it')

    /** **Two row heights**, measured: DSH's workspace rows are 34px and its session rows 32px. */
    assert.equal(reading.chrome.rowHeights.session, 32, `a session row is 32px\nsaw: ${JSON.stringify(reading.chrome.rowHeights)}`)
    assert.equal(reading.chrome.rowHeights.workspace, 34, 'while a workspace row is 34px')

    /**
     * **The live state**, measured from DSH's own stylesheets: a row that is still arriving carries a masked shimmer sweep
     * (`mask-image: linear-gradient(105deg, ...)` driven by a `shimmer-sweep` keyframe), not only a caret. The runtime sets
     * `data-state="running"` while deltas land; the same attribute is set here to measure the state it produces.
     */
    assert.match(String(reading.chrome.live.animationName), /heddle-row-shimmer/, `a running row shimmers its words\nsaw: ${JSON.stringify(reading.chrome.live)}`)
    assert.equal(reading.chrome.live.duration, '1.5s', 'for a slow sweep with its delay')
    assert.equal(reading.chrome.live.clip, 'text', 'clipped to the glyphs rather than painted as a band')
    assert.notEqual(reading.chrome.live.mask, 'none', 'over a 105-degree gradient of the words')
    assert.equal(reading.chrome.live.answerBandAnimation, 'none', 'and the answer body itself carries no band')
    assert.equal(reading.chrome.live.rulePresent, true, 'the shimmer rule is in the sheet')

    /**
     * **The user's turn**, measured from DSH's own chat on 2026-10-17: a right-aligned bubble that hugs its text — its box
     * measured 484px inside a 689px column, flush with the column's right edge — on a 20px radius over rgb(44,44,46). An
     * earlier pass of this audit claimed the opposite (full width, left-aligned) from a screenshot; the box measurement
     * settled it, so this pins the measured shape rather than a memory of one.
     */
    assert.equal(reading.chrome.userTurn.alignSelf, 'flex-end', `a user turn sits at the column's right\nsaw: ${JSON.stringify(reading.chrome.userTurn)}`)
    assert.equal(reading.chrome.userTurn.radius, '20px', 'with a 20px radius')
    assert.equal(reading.chrome.userTurn.background, 'rgb(44, 44, 46)', "on DSH's bubble surface")
    /** `width: fit-content` resolves to a used pixel width, so the hug is judged by box against box. */
    assert.ok(reading.chrome.userTurn.turnWidth < reading.chrome.userTurn.logWidth, `and hugs its text rather than filling the column\nsaw: ${JSON.stringify(reading.chrome.userTurn)}`)
    /** The column carries padding, so "flush right" means flush with its **content** edge, which is what DSH's box was. */
    assert.ok(
      Math.abs(reading.chrome.userTurn.turnRight - reading.chrome.userTurn.contentRight) <= 2,
      `flush with the column's content edge\nsaw: ${JSON.stringify(reading.chrome.userTurn)}`,
    )

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
    /**
     * DSH's View options, read from its own menu on 2026-10-17, is four groups: a `WorkSpace` heading, the grouping pair,
     * the ordering pair, and the archive trio. This UI carries the heading, the grouping pair, the ordering pair
     * (`Manual` / `Last updated`, since C17) and the archive trio, in DSH's order — asserted as the list, because the
     * order is the claim.
     */
    assert.deepEqual(
      reading.viewItems.filter((item) => item.label !== null).map((item) => item.label),
      /**
       * The grouping is DSH's three since the workspace tree (owner goal, 2026-10-28; DSH 0.2.1's `SessionGroupBy` is
       * `workspace-tree | workspace | flat`): `Workspace Tree`, `Workspace` (sibling sections) and `In one list`.
       */
      ['Workspace Tree', 'Workspace', 'In one list', 'Manual', 'Last updated', 'Hide archived', 'All conversations (show archived)', 'Archived only'],
      `View options reads what DSH's reads\nsaw: ${JSON.stringify(reading.viewItems)}`,
    )
    assert.deepEqual(
      reading.viewItems.filter((item) => item.heading !== null).map((item) => item.heading),
      ['WorkSpace'],
      `with DSH's group heading above the grouping pair\nsaw: ${JSON.stringify(reading.viewItems.map((item) => item.heading))}`,
    )
    /**
     * One current state per group: a grouping, an order, and an archive filter. `WorkSpace` is a heading and carries no
     * state, so the three marked items are the three groups DSH has.
     */
    assert.equal(
      reading.viewItems.filter((item) => item.checked === 'true').length,
      3,
      `one current state per group\nsaw: ${JSON.stringify(reading.viewItems.map((item) => [item.label, item.checked]))}`,
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-shortcuts')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const made = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, made.stderr)
    const created = parseJson(made.stdout)
    /**
     * The session the chords act on needs a **completed turn**, because a fork is cut at one: a session whose question
     * was recorded and whose answer never arrived now answers `409` rather than forking a half-finished turn. Without
     * this the fork chord is refused and the check reads that refusal as a missing chord.
     */
    const turn = await runCli(adminArgs(h, ['--turn', 'a turn worth forking']), { env: h.env, cwd: join(h.work, '_tools_', 'some-tool') })
    assert.equal(turn.code, 0, turn.stderr)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, created.session)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((entry) => entry.querySelector('.label')?.textContent === label)
        const sessions = () => [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.querySelector(':scope > .row > .label')?.textContent)
        /**
         * The archive chord goes through the same confirmation the menu does when a turn is running, and a headless browser
         * dismisses a native dialog by default. The confirmation itself is judged elsewhere; here it is stubbed to accept.
         */
        window.confirm = () => true
        /**
         * A chord's effect is read when it has happened, not after a fixed sleep: each one is a server round-trip and a tree
         * re-render, which under load outlast any fixed wait. Bounded, so a chord that does nothing still fails below.
         */
        const until = async (done, ms) => {
          const end = Date.now() + ms
          while (Date.now() < end) {
            if (done()) return true
            await wait(100)
          }
          return done()
        }
        /** One press helper, so every chord is dispatched the same way a keyboard would send it. */
        const press = (key, mods) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
          document.dispatchEvent(event)
          return event.defaultPrevented
        }
        /** Open a level only if it is closed: a blind click closes what the page may already have opened. */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        /**
         * In the workspace tree (owner goal, 2026-10-28) the session the page opens at start is drawn as its workspace's
         * row and is selected from the first paint, so "nothing is selected" is reached the way a reader reaches it: by
         * showing a file, which takes the selection.
         */
        const fileRow = rows().find((row) => row.closest('li')?.dataset.kind === 'file')
        fileRow?.click()
        await until(() => document.querySelector('#tree li[aria-selected="true"]')?.dataset.kind === 'file', 3000)

        /** Nothing is selected: the chords that need a session refuse, and say why. */
        const beforeSelect = { note: '', prevented: press('a', { altKey: true, metaKey: true }) }
        await until(() => /select a session first/.test(document.getElementById('tree-note').textContent), 3000)
        beforeSelect.note = document.getElementById('tree-note').textContent

        /** Search needs no session and focuses its field. */
        const preventedSearch = press('k', { altKey: true, metaKey: true })
        await until(() => document.activeElement?.id === 'session-search', 3000)
        const searchFocused = document.activeElement !== null && document.activeElement.id === 'session-search'
        document.getElementById('session-search').value = ''
        document.getElementById('session-search').dispatchEvent(new Event('input', { bubbles: true }))
        document.activeElement.blur()
        await wait(100)

        /** Rename: the chord reaches the row the panel is showing. */
        const sessionRow = [...document.querySelectorAll('#tree li[data-kind="session"]')][0]
        sessionRow.querySelector(':scope > .row').click()
        await wait(1200)
        /** The chord opens DSH's Rename session dialog; it is answered the way a person answers it. */
        press('g', { altKey: true, metaKey: true })
        await until(() => document.getElementById('session-rename')?.open === true, 3000)
        const renameInput = document.getElementById('session-rename-input')
        if (renameInput !== null) {
          renameInput.value = 'a name from a chord'
          renameInput.dispatchEvent(new Event('input', { bubbles: true }))
          document.getElementById('session-rename-confirm').click()
        }
        await until(() => sessions().includes('a name from a chord'), 8000)
        const renamed = sessions()

        /** Fork: a second row appears named after the first. */
        press('f', { shiftKey: true, metaKey: true })
        await until(() => sessions().some((label) => label?.startsWith('a name from a chord (')), 8000)
        const forked = sessions()

        /**
         * Archive: the selected row leaves the list. The session is **re-selected** first, because the fork chord re-reads the
         * tree and a re-render is not an interaction — the chord's contract is "the selected session", so the test selects.
         */
        rows().find((row) => row.querySelector('.label')?.textContent === 'a name from a chord')?.click()
        await wait(800)
        press('a', { altKey: true, metaKey: true })
        await until(() => !sessions().includes('a name from a chord'), 8000)
        const archived = sessions()
        const archiveNote = document.getElementById('tree-note')?.textContent ?? ''

        return {
          beforeSelect,
          preventedSearch,
          searchFocused,
          renamed,
          forked,
          archived,
          archiveNote,
        }
      })().then((value) => JSON.stringify(value))`, 60_000),
      // One script drives every chord; its own bounded waits can reach ~40 s on a slow machine, past the protocol's 10 s
      // default for a single call — measured as "'Runtime.evaluate' did not answer within 10000ms" in a lane run.
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
      `the archive chord put the selected session away\nsaw: ${JSON.stringify(reading.archived)} note: ${JSON.stringify(reading.archiveNote)}`,
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
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
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

/**
 * Content search (R-developer-eight-19): DSH's `session.search`, which finds a phrase **inside** the conversation and
 * not only in a session's name (dsh-api-session-controller lib/index.js:2010-2123; ranking and snippet in
 * dsh-session-query-sqlite lib/index.js:325-367 and :818-834).
 *
 * Five sessions, each answered by the scripted endpoint with its own text — the script is read on every call, so
 * rewriting it between `--new` turns gives each session its answer. Only the answers hold the phrase.
 */
test('content search finds a phrase inside an answer, ranked and quoted the way DSH answers it', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  const h = harness('content-search')
  let live
  try {
    mkdirSync(h.work, { recursive: true })
    const answers = [
      ['first', 'The quokka ledger is balanced.'],
      ['second', 'A quokka ledger here, another QUOKKA LEDGER there, and a long tail of words after both of them.'],
      ['third', 'The Qu\u00f6kka-Ledger is balanced.'],
      ['fourth', 'quokkaledger, or the quokka and its ledger.'],
      ['fifth', `${'x'.repeat(150)} quokka ledger ${'y'.repeat(150)}`],
    ]
    const ids = {}
    for (const [name, text] of answers) {
      writeFileSync(join(h.home, 'script.json'), `${JSON.stringify({ steps: [{ text }] })}\n`)
      const known = new Set((await sessionsOf(h)).map((meta) => meta.id))
      const turn = await runCli([...h.args, '--new', '--turn', `tell me about the ${name} one`], { env: h.env, cwd: h.work })
      assert.equal(turn.code, 0, `the ${name} turn ran\n${turn.stdout}${turn.stderr}`)
      const made = (await sessionsOf(h)).map((meta) => meta.id).filter((id) => !known.has(id))
      assert.equal(made.length, 1, `the ${name} turn made one session`)
      ids[name] = made[0]
    }

    live = await startServer(['web', '--host', '127.0.0.1', '--port', '0', ...h.args], { ...h.env, HOME: h.home })
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    const search = async (query) => {
      const url = new URL('/api/sessions/search', live.url)
      if (query !== undefined) url.searchParams.set('q', query)
      const response = await fetch(url, { headers: { cookie } })
      return { status: response.status, body: await response.json() }
    }

    const found = await search('Quokka Ledger')
    assert.equal(found.status, 200, `the search is served\n${JSON.stringify(found.body)}`)
    /**
     * DSH's order: the most highlighted phrase groups first (the second answer holds two), then the shortest message,
     * then the latest — the third answer is as long as the first and newer, because `Quökka-Ledger` is the same two
     * tokens folded — and the long fifth last. `quokkaledger` is one token and `the quokka and its ledger` no phrase,
     * so the fourth session is not a hit at all.
     */
    assert.deepEqual(
      found.body.items.map((item) => item.sessionId),
      [ids.second, ids.third, ids.first, ids.fifth],
      `the hits are in DSH's order\n${JSON.stringify(found.body, null, 2)}\nids: ${JSON.stringify(ids)}`,
    )
    assert.equal(found.body.hasMore, false, 'and there is no more')
    assert.deepEqual(
      found.body.items.map((item) => item.snippet),
      [
        answers[1][1],
        answers[2][1],
        answers[0][1],
        `\u2026${'x'.repeat(79)} quokka ledger ${'y'.repeat(144)}\u2026`,
      ],
      'each hit quotes its message, and a long one is cut to 240 code points with the match a third of the way in',
    )
    assert.equal(Array.from(found.body.items[3].snippet).length, 240)

    assert.deepEqual((await search('quokkaled')).body, { items: [], hasMore: false }, 'a fragment of a token is not a match')
    assert.deepEqual((await search('!!!')).body, { items: [], hasMore: false }, 'a query with no word finds nothing')
    for (const [query, sentence] of [
      [undefined, 'session search query must not be empty'],
      ['   ', 'session search query must not be empty'],
      ['q'.repeat(501), 'session search query must contain at most 500 UTF-16 code units'],
      ['a\u0000b', 'session search query must not contain NUL'],
    ]) {
      const refused = await search(query)
      assert.deepEqual([refused.status, refused.body.error], [400, sentence], `DSH's refusal for ${JSON.stringify(query?.slice(0, 12))}`)
    }
    const one = await fetch(new URL(`/api/sessions/${ids.first}`, live.url), { headers: { cookie } })
    assert.equal(one.status, 200, 'and a session id is still a session')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('View options groups the sessions the two ways DSH offers: the tree, or one list', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-grouping')
  let live
  let browser
  try {
    await conventionsFixture(h)
    /**
     * Two conversations, each with a turn. Empty ones would not do: DSH draws a blank session as a row only while it is
     * the open one (sessionVisible, dsh-client-ui-workspace lib/client.js:959-966), in the tree and in the list alike, and
     * this page follows it, so two blanks would be one row whichever grouping is chosen. What is judged here is the grouping.
     */
    for (const name of ['one', 'two']) {
      const made = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', name), '--json']), { env: h.env, cwd: h.work })
      assert.equal(made.code, 0, made.stderr)
      const turn = await runCli(adminArgs(h, ['--turn', `a conversation in ${name}`]), { env: h.env, cwd: join(h.work, '_tools_', name) })
      assert.equal(turn.code, 0, turn.stderr)
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
        /** Levels are opened only if closed: the page may or may not have expanded a root on load. */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rows().find((entry) => entry.querySelector('.label')?.textContent === label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        const openMenu = async () => { document.querySelector('#view-options button').click(); await wait(250) }
        const choose = async (label) => {
          await openMenu()
          const button = [...document.querySelectorAll('#view-options .menu:not([hidden]) button')].find((item) => (item.textContent || '').trim() === label)
          if (button === undefined) { document.dispatchEvent(new MouseEvent('click', { bubbles: true })); return false }
          button.click(); await wait(1500)
          return true
        }
        /**
         * A tree first: the workspaces are drawn, which is the grouping this UI had before the choice existed. The
         * sessions live under a type folder, so the tree is opened two levels before they are counted.
         */
        const rowFor = (label) => rows().find((row) => row.querySelector('.label')?.textContent === label)
        await ensureOpen(document.querySelector('#tree .row .label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        const inTree = { workspaces: document.querySelectorAll('#tree li[data-kind="workspace"]').length, sessions: document.querySelectorAll('#tree li[data-kind="session"]').length }
        const choseList = await choose('In one list')
        const inList = {
          workspaces: document.querySelectorAll('#tree li[data-kind="workspace"]').length,
          sessions: document.querySelectorAll('#tree li[data-kind="session"]').length,
          place: document.querySelector('#tree li[data-kind="session"] > .row > .age')?.textContent ?? null,
          expanded: document.querySelectorAll('#tree li[aria-expanded]').length,
        }
        const choseTree = await choose('Workspace Tree')
        const back = { workspaces: document.querySelectorAll('#tree li[data-kind="workspace"]').length }
        return JSON.stringify({ inTree, choseList, inList, choseTree, back, persisted: localStorage.getItem('heddle.tree.grouping.v1') })
      })().then((value) => JSON.stringify(value))`),
    )
    const result = JSON.parse(reading)

    /** The tree before the choice: workspaces and their sessions, which is what `Workspace Tree` means. */
    assert.ok(result.inTree.workspaces >= 1, `the tree draws its workspaces\nsaw: ${JSON.stringify(result.inTree)}`)
    assert.ok(result.inTree.sessions >= 2, 'and the sessions under them')

    /** `In one list`: no folders at all, one flat column of sessions, each with where it lives and its age. */
    assert.equal(result.choseList, true, 'the list option is offered and chosen')
    assert.equal(result.inList.workspaces, 0, `a flat list draws no workspace rows\nsaw: ${JSON.stringify(result.inList)}`)
    assert.ok(result.inList.sessions >= 2, 'only the sessions, all of them')
    assert.ok(result.inList.expanded === 0, 'and nothing claims to expand')
    assert.match(String(result.inList.place), / · /, `a flat row says where its session lives and when\nsaw: ${result.inList.place}`)

    /** And the choice is reversible: the tree comes back, and the choice is remembered. */
    assert.equal(result.choseTree, true, 'the tree option is offered and chosen')
    assert.ok(result.back.workspaces >= 1, `the tree is back\nsaw: ${JSON.stringify(result.back)}`)
    assert.equal(result.persisted, 'tree', 'and the choice is remembered')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a running session says so before its name, and a workspace row offers the one act its name is for', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-running-mark')
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
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, created.session)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((row) => row.querySelector('.label')?.textContent === label)
        /** The root's children arrive after a fetch, so each level is awaited rather than assumed. */
        const rowWhen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const found = rowFor(label)
            if (found !== undefined) return found
            await wait(200)
          }
          return null
        }
        /** Levels are opened only if closed: the page may or may not have expanded a root on load. */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        /** The tree can be mid-repaint when the script starts, so the root itself is awaited too. */
        for (let attempt = 0; attempt < 40 && rows().length === 0; attempt += 1) await wait(200)
        const rootRow = rows()[0]
        if (rootRow === undefined) return JSON.stringify({
          error: 'no tree rows',
          note: document.getElementById('tree-note')?.textContent ?? null,
          treeLength: document.getElementById('tree')?.innerHTML.length ?? null,
          ready: document.readyState,
          url: location.href,
          rowsHtml: document.getElementById('tree')?.innerHTML.slice(0, 300) ?? null,
        })
        await ensureOpen(rootRow.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')

        /**
         * A workspace row's controls: the menu first, then the one act its name is for. Read from DSH's own rows, whose
         * pair is "Workspace actions for <name>" and "New session in <name>".
         */
        const workspaceRow = [...document.querySelectorAll('#tree li[data-kind="workspace"]')].map((li) => li.querySelector(':scope > .row')).find((row) => row !== null)
        const workspaceControls = workspaceRow === null ? [] : [...workspaceRow.querySelectorAll('.row-tools button')].map((button) => button.getAttribute('aria-label'))
        const workspaceSlots = workspaceRow === null ? [] : [...workspaceRow.querySelectorAll('.row-tools > *')].map((child) => child.className)

        /**
         * The running mark. The stream is what sets it in a live UI (model/request adds, turn/completed removes); the paint
         * function is called here directly with the same set, because a scripted turn can finish faster than a check can look
         * for it. The mark is the reference StateDot ongoing spinner, not a word.
         */
        const sessionLi = [...document.querySelectorAll('#tree li[data-kind="session"]')][0]
        const sessionRow = sessionLi.querySelector(':scope > .row')
        const before = sessionRow.querySelector(':scope > .status-dot') === null ? null : 'already there'
        runningSessions.add(${JSON.stringify(created.session)})
        paintRunningMarks(); await wait(200)
        const painted = sessionRow.querySelector(':scope > .status-dot')
        const motion = painted === null ? null : painted.querySelector('.spinner-motion')
        const arc = painted === null ? null : painted.querySelector('.spinner-arc')
        const track = painted === null ? null : painted.querySelector('.spinner-track')
        const whileRunning = {
          state: painted === null ? null : painted.dataset.state,
          label: painted === null ? null : painted.getAttribute('aria-label'),
          beforeLabel: painted !== null && painted.nextElementSibling !== null && painted.nextElementSibling.classList.contains('label'),
          colour: painted === null ? null : getComputedStyle(painted).color,
          spin: motion === null ? null : getComputedStyle(motion).animationName,
          spinDuration: motion === null ? null : getComputedStyle(motion).animationDuration,
          spinTiming: motion === null ? null : getComputedStyle(motion).animationTimingFunction,
          dash: arc === null ? null : getComputedStyle(arc).animationName,
          dashArray: arc === null ? null : getComputedStyle(arc).strokeDasharray,
          trackOpacity: track === null ? null : getComputedStyle(track).opacity,
          rings: painted === null ? null : painted.querySelectorAll('circle').length,
        }
        runningSessions.delete(${JSON.stringify(created.session)})
        paintRunningMarks(); await wait(200)
        const after = sessionRow.querySelector(':scope > .status-dot') === null ? null : 'still there'
        return JSON.stringify({
          workspaceControls,
          workspaceSlots,
          before,
          whileRunning,
          after,
          debug: {
            rows: rows().length,
            kinds: [...document.querySelectorAll('#tree li')].map((li) => li.dataset.kind),
            sessionLi: sessionLi === undefined ? null : 'ok',
            seam: typeof runningSessions,
            workspaceRowFound: workspaceRow !== null,
          },
        })
      })().then((value) => JSON.stringify(value))`),
    )
    const result = JSON.parse(reading)

    /** The workspace row's two controls, in DSH's order: the menu, then `New session in <name>`. */
    assert.deepEqual(result.workspaceSlots, ['menu-wrap', 'session-actions'], `the menu leads the workspace row's controls\nsaw: ${JSON.stringify(result)}`)
    assert.ok(
      result.workspaceControls.some((label) => /^New session in /.test(String(label))),
      `and the one act is to start a session there\nsaw: ${JSON.stringify(result.workspaceControls)}`,
    )

    /** The running mark: absent while quiet, `Running` before the name while the set says so, gone again after. */
    assert.equal(result.before, null, 'a quiet row carries no state word')
    /**
     * The mark is DSH's **spinner**: `StateDot`'s ongoing state — two rings, the track at a quarter opacity and an arc whose
     * dash breathes, the whole glyph rotating 360° in 1.5 s linear — placed before the name and removed when the turn ends.
     */
    assert.equal(result.whileRunning.state, 'ongoing', `a running session carries the ongoing state\nsaw: ${JSON.stringify(result.whileRunning)}`)
    assert.equal(result.whileRunning.label, 'Running', 'labelled for a reader who cannot see it')
    assert.equal(result.whileRunning.beforeLabel, true, 'placed before its name')
    assert.equal(result.whileRunning.rings, 2, 'drawn as a track and an arc')
    assert.equal(result.whileRunning.spin, 'heddle-spin', `the glyph rotates\nsaw: ${JSON.stringify(result.whileRunning)}`)
    assert.equal(result.whileRunning.spinDuration, '1.5s', 'over the reference 1.5 s period')
    assert.equal(result.whileRunning.spinTiming, 'linear', 'linearly')
    assert.equal(result.whileRunning.dash, 'heddle-dash', 'while the arc dash breathes')
    assert.match(String(result.whileRunning.dashArray), /px/, 'on a stroke-dasharray, not a painted band')
    assert.equal(result.whileRunning.trackOpacity, '0.25', 'with the quiet track at a quarter opacity')
    assert.match(String(result.whileRunning.colour), /173, 178, 184/, `in DSH's muted body colour\nsaw: ${result.whileRunning.colour}`)
    assert.equal(result.after, null, 'and the spinner leaves when the session stops')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the interactive inventory is cursor-bearing, hit-testable, unclipped and glyph-complete', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-inventory')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const made = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, made.stderr)
    const second = await runCli(adminArgs(h, ['session', 'new', join(h.work, '_tools_', 'some-tool'), '--json']), { env: h.env, cwd: h.work })
    assert.equal(second.code, 0, second.stderr)
    const pinnedId = parseJson(made.stdout).session
    const archivedId = parseJson(second.stdout).session

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    /** Pin one session and archive the other through the same routes the menu calls, before the page is read. */
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const flag = (id, body) =>
      fetch(new URL(`/api/sessions/${id}/flags`, live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    assert.equal((await flag(pinnedId, { pinned: true })).status, 200, 'the first session is pinned')
    assert.equal((await flag(archivedId, { archived: true })).status, 200, 'the second is archived')

    browser = await openBrowser()
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, pinnedId)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    const reading = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rowFor = (label) => [...document.querySelectorAll('#tree .row')].find((row) => row.querySelector('.label')?.textContent === label)
        /** Levels are opened only if closed: a blind click closes one the page had already opened. */
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        for (let attempt = 0; attempt < 30 && document.querySelectorAll('#tree .row').length === 0; attempt += 1) await wait(150)
        const first = document.querySelector('#tree .row')
        if (first === null) return JSON.stringify({ error: 'the tree drew no rows' })
        await ensureOpen(first.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')

        /**
         * The inventory probe from \`_skills_/ui-parity-audit\`: every element a person can point at, with the four things
         * this UI has got wrong before — its cursor, whether a hit-test at its centre lands on it, whether an ancestor
         * clips it, and (for menus) whether every item carries a mark.
         */
        /**
         * Whether an ancestor **clips** the element's box.
         *
         * A **scroll container** is exempt: the tree is a scrolling list, and a row below its visible box is reachable by
         * scrolling rather than clipped away. The defect this judges is a box that an overflow-hidden ancestor cuts with no
         * way to reach the rest, which is not what a scrollbar is for. Measured on 2026-10-17: a fixture with enough rows to
         * scroll reported its last summary as clipped, and the check had to learn the difference.
         */
        const clips = (element) => {
          const rect = element.getBoundingClientRect()
          let current = element.parentElement
          while (current !== null) {
            const style = getComputedStyle(current)
            const scrolls =
              /auto|scroll/.test(style.overflowX + style.overflowY) &&
              (current.scrollHeight > current.clientHeight + 1 || current.scrollWidth > current.clientWidth + 1)
            /**
             * A scroll container ends the walk: its content is reachable by scrolling, so the element's position outside
             * the visible box is not a clip — and every ancestor **above** the scroller is measuring the scroller's own
             * box, not the element's, which is how a scrolled-to-the-fold summary was reported as clipped by the panel
             * behind its list.
             */
            if (scrolls) return false
            if (/hidden|clip/.test(style.overflowX + style.overflowY)) {
              const outer = current.getBoundingClientRect()
              if (rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1) return true
            }
            current = current.parentElement
          }
          return false
        }
        const inventory = () => [...document.querySelectorAll(
          'button, a[href], summary, input, textarea, [role="tab"], [role="treeitem"], [tabindex]:not([tabindex="-1"])',
        )].filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).map((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          /**
           * Whether the element's centre is inside every scrollport it lives in.
           *
           * Measured on 2026-10-17, after the panel's list became its own scroll region: rows below the fold reported
           * their centre landing on the newly anchored Settings foot, because elementFromPoint answers for the pixel
           * where they *would* be, not for the row a reader can see. A control scrolled out of its list is not covered
           * by what is on top of the list — it is simply not on screen.
           */
          const centreVisible = (() => {
            const x = rect.left + rect.width / 2
            const y = rect.top + rect.height / 2
            let node = element.parentElement
            while (node !== null) {
              const containerStyle = getComputedStyle(node)
              if (/auto|scroll/.test(containerStyle.overflowX + containerStyle.overflowY)) {
                const box = node.getBoundingClientRect()
                if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false
              }
              node = node.parentElement
            }
            return true
          })()
          const centre = centreVisible ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
          const disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true'
          const typing = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
          /** A separator resizes; a control marked data-inert reports a state rather than acting. */
          const separator = element.getAttribute('role') === 'separator'
          const inert = element.getAttribute('data-inert') === 'true'
          return {
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            name: (element.getAttribute('aria-label') ?? (element.textContent || '').trim()).slice(0, 40),
            cursor: style.cursor,
            expectedCursor: disabled || inert ? 'default' : separator ? 'col-resize' : typing ? 'text' : 'pointer',
            hitTest: centre === null ? null : centre === element || element.contains(centre),
            centreVisible,
            atCentre: centre === null ? null : {
              tag: centre.tagName.toLowerCase(),
              id: centre.id,
              cls: String(centre.className).slice(0, 40),
              label: centre.getAttribute('aria-label'),
            },
            clipped: clips(element),
            disabled,
            /** A control the UI reveals on hover is deliberately not hit-testable while it is invisible. */
            interactive: style.pointerEvents !== 'none' && Number(style.opacity) > 0.05 && style.visibility !== 'hidden',
          }
        })

        /** Open each menu this page draws, one at a time, and read its own box and its items' marks. */
        const menuReport = async (triggerSelector, scope) => {
          const trigger = document.querySelector(triggerSelector)
          if (trigger === null) return { error: 'no trigger ' + triggerSelector }
          trigger.click(); await wait(250)
          const menu = document.querySelector(scope + ' .menu:not([hidden])')
          if (menu === null) return { error: 'did not open' }
          const rect = menu.getBoundingClientRect()
          const style = getComputedStyle(menu)
          const items = [...menu.querySelectorAll('button')]
          const box = (element) => { const own = element.getBoundingClientRect(); return [Math.round(own.width), Math.round(own.height)] }
          const report = {
            position: style.position,
            background: style.backgroundColor,
            insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
            menuBox: [Math.round(rect.width), Math.round(rect.height)],
            items: items.map((item) => ({
              label: (item.textContent || '').trim().slice(0, 30),
              glyph: item.querySelector('svg') !== null,
              glyphBox: item.querySelector('svg') === null ? null : box(item.querySelector('svg')),
              box: box(item),
              /** A label that overflows its item is how a squashed item announces itself. */
              clipped: item.scrollWidth > item.clientWidth + 1,
            })),
          }
          document.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(150)
          return report
        }
        const menus = {
          viewOptions: await menuReport('#view-options button', '#view-options'),
          sessionHeader: await menuReport('#session-more button', '#session-head'),
        }
        if (document.querySelector('#tree .row .menu-wrap > button') !== null) {
          menus.sessionRow = await menuReport('#tree li[data-kind="session"] .menu-wrap > button', '#tree')
        }

        /** The row's action buttons: DSH's 20px square box on the row's own surface, with no patch behind them. */
        const rowControls = (() => {
          const li = document.querySelector('#tree li[data-kind="session"]')
          if (li === null) return null
          /** The tail hides the controls until the row is hovered or focused; reveal them the keyboard way. */
          li.querySelector(':scope > .row')?.focus()
          const tools = li.querySelector('.row-tools')
          const buttons = [...(tools?.querySelectorAll(':scope > .menu-wrap > button, :scope > .session-actions > button') ?? [])]
          const iconButtons = ['#sidebar-search', '#add-workspace', '#session-more button', '#view-options button']
            .map((selector) => document.querySelector(selector))
            .filter((button) => button !== null)
            .map((button) => {
              const rect = button.getBoundingClientRect()
              const style = getComputedStyle(button)
              return {
                selector: button.id || button.parentElement?.id || 'icon',
                box: [Math.round(rect.width), Math.round(rect.height)],
                computed: [style.width, style.height],
                display: style.display,
                rules: [...document.styleSheets].flatMap((sheet) => {
                  try { return [...sheet.cssRules] } catch (error) { return [] }
                }).filter((rule) => (rule.selectorText ?? '').includes('sidebar-search')).map((rule) => rule.cssText.slice(0, 100)),
                ancestors: (() => {
                  const chain = []
                  let current = button.parentElement
                  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
                    const chainStyle = getComputedStyle(current)
                    chain.push({ tag: current.tagName.toLowerCase(), id: current.id, width: Math.round(current.getBoundingClientRect().width), transform: chainStyle.transform })
                    current = current.parentElement
                  }
                  return chain
                })(),
              }
            })
          return {
            toolsBackground: tools === null ? null : getComputedStyle(tools).backgroundColor,
            boxes: buttons.map((button) => [Math.round(button.getBoundingClientRect().width), Math.round(button.getBoundingClientRect().height)]),
            backgrounds: buttons.map((button) => getComputedStyle(button).backgroundColor),
            iconButtons,
          }
        })()

        /** A long name must not reach the controls: the row's right-hand slot reserves its width. */
        const longName = (() => {
          const li = document.querySelector('#tree li[data-kind="session"]')
          if (li === null) return null
          const row = li.querySelector(':scope > .row')
          const label = row.querySelector('.label')
          const tools = row.querySelector('.row-tools')
          const original = label.textContent
          label.textContent = 'a session whose name is long enough to reach the right edge of the row and keep going'
          void label.offsetWidth
          const labelRight = Math.round(label.getBoundingClientRect().right)
          const toolsLeft = Math.round(tools.getBoundingClientRect().left)
          label.textContent = original
          return { labelRight, toolsLeft, overlaps: labelRight > toolsLeft }
        })()

        /**
         * The two flag rules the reference states: a pinned row carries a **rest-state mark**, and an archived row offers no
         * pin at all — not in its quick controls and not in its menu. Both are read from the drawn tree.
         */
        const flagStates = (async () => {
          /** Archived rows are hidden by default; the filter is switched on first so the rule can be read. */
          document.querySelector('#view-options .menu-wrap > button')?.click()
          const showArchived = [...document.querySelectorAll('#view-options .menu button')].find((button) => (button.textContent || '').trim() === 'All conversations (show archived)')
          showArchived?.click()
          document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          /** The filter re-reads the tree asynchronously; the archived rows appear after that fetch. */
          await wait(1200)
          const sessionRows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          const pinnedRow = sessionRows.find((li) => li.dataset.pinned === 'true')
          const pinnedGlyph = pinnedRow === undefined ? null : pinnedRow.querySelector(':scope > .row .pin-slot svg')
          const pinnedMark = pinnedGlyph === null || pinnedGlyph === undefined ? null : pinnedGlyph.getBoundingClientRect()
          /**
           * The pointer's resting place can hover the row, and focus reveals the controls — both legitimately hide the mark.
           * The glyph is still judged by its own 14px artwork, and its drawn size when it is actually drawn.
           */
          const pinnedSlot = pinnedRow === undefined ? null : pinnedRow.querySelector(':scope > .row .pin-slot')
          const pinnedDisplay = pinnedSlot === null ? null : getComputedStyle(pinnedSlot).display
          const pinnedArtwork = pinnedGlyph === null || pinnedGlyph === undefined ? null : Number(pinnedGlyph.getAttribute('width'))
          /** An archived row is one the row itself says archived; the tree draws it only when the archive filter shows it. */
          const archivedRows = sessionRows.filter((li) => li.querySelector(':scope > .row .label')?.textContent?.includes('archived') !== true)
          return {
            archivedRows: sessionRows.filter((li) => li.getAttribute('data-archived') === 'true').length,
            pinnedMark: pinnedMark === null ? null : [Math.round(pinnedMark.width), Math.round(pinnedMark.height)],
            pinnedDisplay,
            pinnedArtwork,
            archivedPinControls: (() => {
              const archived = sessionRows.find((li) => li.getAttribute('data-archived') === 'true')
              if (archived === undefined) return null
              return {
                quick: [...archived.querySelectorAll(':scope > .row .session-actions button')].map((button) => button.getAttribute('aria-label')),
                menu: [...archived.querySelectorAll(':scope > .row .menu button')].map((button) => (button.textContent || '').trim()),
              }
            })(),
            archivedRows: archivedRows.length,
          }
        })()

        return JSON.stringify({ inventory: inventory(), menus, rowControls, longName, flagStates: await flagStates, pageErrors: window.__probeErrors ?? [] })
      })().then((value) => JSON.stringify(value))`, 30_000),
    )
    const result = JSON.parse(reading)
    assert.equal(result.error, undefined, `the probe reached the page\nsaw: ${JSON.stringify(result)}`)

    /** Every enabled, non-typing control announces itself to a mouse as a hand; a disabled one keeps the arrow. */
    const wrongCursors = result.inventory.filter((item) => item.cursor !== item.expectedCursor)
    assert.deepEqual(wrongCursors, [], `every interactive element has the cursor its state promises\nsaw: ${JSON.stringify(wrongCursors)}`)

    /**
     * Nothing a person can actually click is covered by another layer at its own centre.
     *
     * Only elements whose centre is on screen in their own scrollport are judged: a row scrolled out of the workspaces
     * region has no on-screen centre, and asking what is at the pixel it would occupy is a question about the footer.
     */
    const covered = result.inventory.filter((item) => item.interactive === true && item.hitTest === false && item.centreVisible !== false)
    assert.deepEqual(covered, [], `no enabled control is covered at its centre\nsaw: ${JSON.stringify(covered)}`)

    /** Nothing a person can click is cut by an ancestor's overflow. */
    const clipped = result.inventory.filter((item) => item.clipped === true)
    assert.deepEqual(clipped, [], `no interactive element is clipped by an ancestor\nsaw: ${JSON.stringify(clipped)}`)

    /** Every menu floats in viewport coordinates, stays on screen, is opaque and marks each item. */
    for (const [name, menu] of Object.entries(result.menus)) {
      assert.equal(menu.error, undefined, `the ${name} menu opens\nsaw: ${JSON.stringify(menu)}`)
      assert.equal(menu.position, 'fixed', `the ${name} menu floats in viewport coordinates\nsaw: ${JSON.stringify(menu)}`)
      assert.equal(menu.insideViewport, true, `the ${name} menu is wholly on screen`)
      assert.equal(menu.background, 'rgb(35, 35, 36)', `the ${name} menu has an opaque surface`)
      assert.ok(menu.items.length > 0, `the ${name} menu has items`)
      assert.ok(menu.items.every((item) => item.glyph === true), `every ${name} item carries a glyph\nsaw: ${JSON.stringify(menu.items)}`)
      /**
       * An opened menu is measured **item by item**: DSH's own `._item` is full width, `min-height: 34px`, with a 16px
       * glyph. The squashed menu this cycle fixed measured 20×16 per item — one descendant selector had also sized the
       * items — and no closed-state assertion could have seen it.
       */
      for (const item of menu.items) {
        assert.ok(item.box[1] >= 34, `the ${name} item is at least DSH's 34px tall\nsaw: ${JSON.stringify(item)}`)
        assert.ok(item.box[0] > 100, `and fills the menu's width\nsaw: ${JSON.stringify(item)}`)
        assert.equal(item.clipped, false, `with its label unclipped\nsaw: ${JSON.stringify(item)}`)
        assert.deepEqual(item.glyphBox, [16, 16], `and a 16px glyph, as DSH's items have\nsaw: ${JSON.stringify(item)}`)
      }
    }

    /** The row's controls are DSH's `._actionButton`: 20×16, no background. */
    assert.deepEqual(result.rowControls.boxes, [[20, 16], [20, 16], [20, 16]], `each row control is DSH's 20x16 action button\nsaw: ${JSON.stringify(result.rowControls.boxes)}`)
    assert.equal(result.rowControls.toolsBackground, 'rgba(0, 0, 0, 0)', `the controls draw no patch of their own\nsaw: ${result.rowControls.toolsBackground}`)
    assert.deepEqual(result.rowControls.backgrounds, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], 'and each button is transparent')

    /** The panel's icon buttons are DSH's `._iconButton`: 28×28. */
    assert.ok(result.rowControls.iconButtons.length >= 3, `the panel's icon buttons are measurable\nsaw: ${JSON.stringify(result.rowControls.iconButtons)}`)
    for (const button of result.rowControls.iconButtons) {
      assert.deepEqual(button.box, [28, 28], `an icon button is DSH's 28x28\nsaw: ${JSON.stringify(button)}`)
    }

    /** A pinned row says so at rest; an archived row offers no pin, because the store would refuse it. */
    assert.equal(result.flagStates.pinnedArtwork, 14, `a pinned row carries the reference's 14px pin artwork\nsaw: ${JSON.stringify(result.flagStates)}`)
    /** When the mark is actually drawn — not hidden by hover or focus — it measures its artwork size. */
    if (result.flagStates.pinnedDisplay !== 'none') {
      assert.deepEqual(result.flagStates.pinnedMark, [14, 14], `and draws it at 14px\nsaw: ${JSON.stringify(result.flagStates)}`)
    }
    assert.ok(result.flagStates.archivedRows >= 1, `the archived row is drawn once the filter shows it\nsaw: ${JSON.stringify(result.flagStates)}`)
    assert.notEqual(result.flagStates.archivedPinControls, null, 'and its controls are readable')
    {
      assert.ok(
        result.flagStates.archivedPinControls.quick.every((label) => !String(label).includes('Pin session')),
        `an archived row's quick controls offer no pin\nsaw: ${JSON.stringify(result.flagStates.archivedPinControls)}`,
      )
      assert.ok(
        result.flagStates.archivedPinControls.menu.every((label) => !label.includes('Pin session')),
        `nor does its menu\nsaw: ${JSON.stringify(result.flagStates.archivedPinControls)}`,
      )
    }

    /** A long name ellipsizes before the controls, never underneath them. */
    assert.equal(result.longName.overlaps, false, `a long name stops before the controls\nsaw: ${JSON.stringify(result.longName)}`)

    /** And the page threw nothing while all of that was measured. */
    assert.deepEqual(result.pageErrors, [], `the page reported no errors\nsaw: ${JSON.stringify(result.pageErrors)}`)
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('pin, archive and fork refuse what the reference refuses, and record their provenance', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  const h = harness('session-actions')
  let live
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = []
    for (let index = 0; index < 2; index += 1) {
      const one = await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })
      assert.equal(one.code, 0, one.stderr)
      made.push(parseJson(one.stdout).session)
    }
    const given = await runCli(adminArgs(h, ['--turn', 'a turn worth forking']), { env: h.env, cwd: branch })
    assert.equal(given.code, 0, given.stderr)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    const call = (path, body) =>
      fetch(new URL(path, live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const metas = async () => (await (await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })).json())

    /** Pin records its time, so several pinned sessions order by the pin rather than by their names. */
    /** Which session the `--turn` landed on is a property of the data, not of creation order: read it. */
    const initial = await metas()
    const withTurn = initial.find((meta) => made.includes(meta.id) && meta.turns >= 1)?.id
    const withoutTurn = initial.find((meta) => made.includes(meta.id) && meta.turns === 0)?.id
    assert.ok(withTurn !== undefined && withoutTurn !== undefined, `one session has a turn and one does not\nsaw: ${JSON.stringify(initial.filter((meta) => made.includes(meta.id)))}`)
    const pinned = await call(`/api/sessions/${withTurn}/flags`, { pinned: true })
    assert.equal(pinned.status, 200, 'the pin is accepted')
    const pinnedMeta = (await metas()).find((meta) => meta.id === withTurn)
    assert.equal(pinnedMeta?.pinned, true, 'and recorded')
    assert.match(String(pinnedMeta?.pinnedAt), /^\d{4}-\d{2}-\d{2}T/, 'with the time it was pinned')

    /** Archiving drops the pin in the same write — the two flags are exclusive. */
    const archived = await call(`/api/sessions/${withTurn}/flags`, { archived: true })
    assert.equal(archived.status, 200, 'the archive is accepted')
    const archivedMeta = (await metas()).find((meta) => meta.id === withTurn)
    assert.equal(archivedMeta?.archived, true, 'and recorded')
    assert.equal(archivedMeta?.pinned, undefined, 'with the pin removed')

    /** Pinning an archived session is refused with a reason a caller can act on. */
    const refused = await call(`/api/sessions/${withTurn}/flags`, { pinned: true })
    assert.equal(refused.status, 409, 'an archived session cannot be pinned')
    assert.equal((await refused.json()).code, 'archived', 'and says why')

    /** A fork is cut at the last completed turn: the untouched session has none, so it is refused. */
    const noTurn = await call(`/api/sessions/${withoutTurn}/fork`, {})
    assert.equal(noTurn.status, 409, 'a session with no completed turn cannot be forked')
    assert.equal((await noTurn.json()).code, 'unavailable', 'and says why')

    /** A session with a turn forks, and the child records its parent — the provenance the reference keeps. */
    const forked = await call(`/api/sessions/${withTurn}/fork`, {})
    assert.equal(forked.status, 200, `a session with a completed turn forks\n${await forked.clone().text()}`)
    const child = (await forked.json()).session
    const childMeta = (await metas()).find((meta) => meta.id === child)
    assert.equal(childMeta?.parentSession, withTurn, `the child records the session it was cut from\nsaw: ${JSON.stringify(childMeta)}`)
    assert.ok(childMeta?.title !== undefined, 'and is named, so two rows with one title cannot be confused')
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('archiving a session with running work is refused with the work named, and stop: true stops it and archives', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  /**
   * R-developer-eight-13. DSH refuses a plain `workspace/archiveSession` while the session has work in flight and names that
   * work by family (`dsh-workspace` `archiveSession` → `workspace/session-active`, `details.activity`): `{kind: 'turn'}`
   * for its own running turn (`dsh-agent`), `{kind: 'subagent', items}` for running subagent descendants (`dsh-subagent`,
   * by lineage) — and a subagent still working under an idle parent counts. With `stopActivity` the archive is written and
   * the work is stopped. The sidebar's stop-and-archive dialog lists exactly what the refusal names, so the refusal has to
   * name it; heddle's used to carry only `running: <count>` and let an idle parent with a working child archive unasked.
   */
  const h = harness('archive-running')
  let live
  const pending = []
  try {
    const script = join(h.home, 'script.json')
    const setScript = (steps) => writeFileSync(script, `${JSON.stringify({ steps }, null, 2)}\n`)
    const sleepStep = { toolCall: { name: 'bash', arguments: { command: 'sleep 40', timeoutMs: 60000 } } }
    setScript([sleepStep, { text: 'slept' }])
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    const post = (path, body) =>
      fetch(new URL(path, live.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const metas = async () => (await (await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })).json())
    const until = async (probe, ms = 15_000) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const value = await probe()
        if (value) return value
        await new Promise((done) => setTimeout(done, 200))
      }
      return undefined
    }

    /** Its own turn: a bash step that sleeps keeps the turn running while the archive is asked for. */
    const stream = post('/api/turn', { prompt: 'start a long job', folder: h.work }).then((response) => response.text())
    pending.push(stream)
    const running = await until(async () => (await metas()).find((meta) => meta.running === true))
    assert.ok(running, 'the turn is running')
    const refused = await post(`/api/sessions/${running.id}/flags`, { archived: true })
    assert.equal(refused.status, 409, 'a running session is not archived quietly')
    const refusal = await refused.json()
    assert.equal(refusal.code, 'active', `and the refusal says why\n${JSON.stringify(refusal)}`)
    assert.deepEqual(refusal.activity, [{ kind: 'turn' }], `and names the work, DSH's activity list\n${JSON.stringify(refusal)}`)
    const untouched = (await metas()).find((meta) => meta.id === running.id)
    assert.equal(untouched?.running, true, 'the refusal stops nothing')
    assert.notEqual(untouched?.archived, true, 'and archives nothing')
    const stopped = await post(`/api/sessions/${running.id}/flags`, { archived: true, stop: true })
    assert.equal(stopped.status, 200, 'stop: true is the caller agreeing to stop it')
    assert.equal((await stopped.json()).archived, true, 'and the session is archived')
    await stream
    const after = (await metas()).find((meta) => meta.id === running.id)
    assert.equal(after?.running, false, `and its turn has stopped\n${JSON.stringify(after)}`)

    /**
     * A subagent still working under a parent whose own turn has ended: the parent is idle, the work is not, and the
     * refusal names the child. The child's bash step sleeps; the parent's turn starts it and ends.
     */
    setScript([
      { toolCall: { name: 'delegate', arguments: { prompt: 'look things up slowly' } } },
      { text: 'the child is working' },
      { purpose: 'subagent', ...sleepStep },
      { purpose: 'subagent', text: 'the child is done' },
    ])
    const parentTurn = await (await post('/api/turn', { prompt: 'delegate a slow job', folder: h.work })).text()
    const parent = /"session":"(session-[^"]+)"/.exec(parentTurn)?.[1]
    assert.ok(parent, `the parent turn names its session\n${parentTurn.slice(0, 400)}`)
    const child = await until(async () => (await metas()).find((meta) => meta.parentSession === parent && meta.origin === 'subagent'))
    assert.ok(child, 'the parent started a subagent')
    const childRefused = await post(`/api/sessions/${parent}/flags`, { archived: true })
    assert.equal(childRefused.status, 409, 'an idle parent whose subagent still works is not archived quietly')
    const childRefusal = await childRefused.json()
    assert.deepEqual(
      (childRefusal.activity ?? []).map((entry) => [entry.kind, (entry.items ?? []).map((item) => item.id)]),
      [['subagent', [child.id]]],
      `and the refusal names the running subagent, not a turn\n${JSON.stringify(childRefusal)}`,
    )
    const childStopped = await post(`/api/sessions/${parent}/flags`, { archived: true, stop: true })
    assert.equal(childStopped.status, 200, 'stop: true archives the parent')
    const childEnded = await until(() => readTranscript(join(h.home, 'sessions', child.id)).some((event) => event.type === 'turn/completed'))
    assert.ok(childEnded, "and the stop reached the subagent: its turn ended long before its 40-second step would have")
  } finally {
    live?.kill()
    await Promise.allSettled(pending)
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a clipped session title crawls on hover and returns on leave', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-title-marquee')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const long = await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })
    assert.equal(long.code, 0, long.stderr)
    const longRecord = parseJson(long.stdout)
    const longId = longRecord.session
    const short = await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })
    assert.equal(short.code, 0, short.stderr)
    const shortRecord = parseJson(short.stdout)
    const shortId = shortRecord.session

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    /** Titles through the route the rename uses; the long one is chosen to overflow the sidebar by far more than 8px. */
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const title = (id, text, folder) =>
      fetch(new URL(`/api/sessions/${id}/title`, live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: text, folder }),
      })
    /** 78 bytes: under DSH's 80-byte title cap (normalizeSessionTitle), which a longer title would be cut by, yet far wider than the sidebar. */
    const longTitle = 'a session name long enough to overflow the sidebar and crawl under the pointer'
    /** Each session's definition folder comes from the CLI's own record, not from a guessed name. */
    assert.equal((await title(longId, longTitle, dirname(longRecord.definition))).status, 200, 'the long title is written')
    assert.equal((await title(shortId, 'short', dirname(shortRecord.definition))).status, 200, 'the short title is written')

    browser = await openBrowser()
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    const probe = async (label) => JSON.parse(await browser.evaluate(`(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const rows = () => [...document.querySelectorAll('#tree .row')]
      const ensureOpen = async (text) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const row = rows().find((candidate) => candidate.querySelector('.label')?.textContent === text)
          if (row === undefined) { await wait(150); continue }
          const li = row.closest('li')
          if (li.dataset.open !== 'true') row.click()
          await wait(200)
          if (li.dataset.open === 'true') return true
        }
        return false
      }
      for (let attempt = 0; attempt < 30 && rows().length === 0; attempt += 1) await wait(150)
      await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
      await ensureOpen('_tools_')
      await ensureOpen('some-tool')
      const row = rows().find((candidate) => candidate.querySelector('.label')?.textContent === ${JSON.stringify(label)})
      if (row === undefined) return JSON.stringify({ error: 'row not found' })
      const labelEl = row.querySelector('.label')
      const rect = row.getBoundingClientRect()
      return JSON.stringify({
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        overflowing: labelEl.scrollWidth - labelEl.clientWidth,
        before: { left: labelEl.scrollLeft, scrolled: labelEl.dataset.scrolled ?? null, clipped: labelEl.dataset.clipped ?? null },
      })
    })()`))

    /** Trusted pointer onto the long row: the marquee is a hover behaviour and a synthetic event would not prove it. */
    const target = await probe(longTitle)
    assert.equal(target.error, undefined, `the long row is drawn\nsaw: ${JSON.stringify(target)}`)
    assert.ok(target.overflowing > 8, `the title overflows by more than the reference's 8px floor\nsaw: ${target.overflowing}`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    await new Promise((done) => setTimeout(done, 900))
    const during = JSON.parse(await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree .row')].find((candidate) => candidate.querySelector('.label')?.textContent === ${JSON.stringify(longTitle)})
      const label = row.querySelector('.label')
      return JSON.stringify({ left: label.scrollLeft, scrolled: label.dataset.scrolled ?? null, clipped: label.dataset.clipped ?? null })
    })()`))
    assert.ok(during.left > 0, `hovering crawls the title\nsaw: ${JSON.stringify(during)}`)
    assert.equal(during.scrolled, '', 'and marks the left edge as scrolled')

    /** Leaving returns it to the start in one step — the resting ellipsis must not meet a travelling title. */
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
    await new Promise((done) => setTimeout(done, 400))
    const after = JSON.parse(await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree .row')].find((candidate) => candidate.querySelector('.label')?.textContent === ${JSON.stringify(longTitle)})
      const label = row.querySelector('.label')
      return JSON.stringify({ left: label.scrollLeft, scrolled: label.dataset.scrolled ?? null, clipped: label.dataset.clipped ?? null })
    })()`))
    assert.equal(after.left, 0, `leaving returns the title to its start\nsaw: ${JSON.stringify(after)}`)
    assert.equal(after.scrolled, null, 'and clears the fade marks')

    /** A short title never moves: the reference's floor exists so a few clipped pixels do not read as jitter. */
    const shortTarget = await probe('short')
    assert.equal(shortTarget.error, undefined)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: shortTarget.x, y: shortTarget.y })
    await new Promise((done) => setTimeout(done, 500))
    const shortAfter = JSON.parse(await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('#tree .row')].find((candidate) => candidate.querySelector('.label')?.textContent === 'short')
      return JSON.stringify({ left: row.querySelector('.label').scrollLeft })
    })()`))
    assert.equal(shortAfter.left, 0, 'a title that fits does not crawl')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the menu forks a session from its row, and the child appears in the tree named after it', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-fork-menu')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    const made = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
    await runCli(adminArgs(h, ['--turn', 'a conversation the menu should fork']), { env: h.env, cwd: branch })

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, made.session)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    /** Open the source row's menu through its own button, and take the item a person would take. */
    const opened = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const ensureOpen = async (text) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rows().find((candidate) => candidate.querySelector('.label')?.textContent === text)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        for (let attempt = 0; attempt < 30 && rows().length === 0; attempt += 1) await wait(150)
        await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        const sessionRow = [...document.querySelectorAll('#tree li[data-kind="session"]')][0]
        if (sessionRow === undefined) return JSON.stringify({ error: 'no session row' })
        const sourceLabel = sessionRow.querySelector(':scope > .row .label').textContent
        const trigger = sessionRow.querySelector(':scope > .row .menu-wrap > button')
        if (trigger === null) return JSON.stringify({ error: 'no menu trigger' })
        trigger.click()
        await wait(300)
        const item = [...sessionRow.querySelectorAll(':scope > .row .menu button')].find((button) => (button.textContent || '').trim() === 'Fork session')
        if (item === undefined) return JSON.stringify({ error: 'no fork item' })
        item.click()
        await wait(1500)
        const labels = [...document.querySelectorAll('#tree li[data-kind="session"] > .row .label')].map((label) => label.textContent)
        return JSON.stringify({ labels, sourceLabel, note: document.getElementById('tree-note')?.textContent ?? document.getElementById('note')?.textContent ?? '' })
      })()`),
    )
    assert.equal(opened.error, undefined, `the row's menu opened\nsaw: ${JSON.stringify(opened)}`)
    assert.ok(
      opened.labels.some((label) => label === `${opened.sourceLabel} (1)`),
      `the forked child appears in the tree, named after the source with its ordinal\nsaw: ${JSON.stringify(opened)}`,
    )
    assert.equal(opened.note, '', 'the fork reported nothing wrong')
    /** The fork is a real session beside its source, not a copy of the row. */
    assert.ok(opened.labels.includes(opened.sourceLabel), 'and the source row is still there')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a written session moves to the top of its folder, its age follows, and a real pin click holds it there', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-order-age-pin')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    /** Two conversations with an answer each, so both have a write time and a turn. */
    const made = []
    for (let index = 0; index < 2; index += 1) {
      const created = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout)
      made.push(created)
      await runCli(adminArgs(h, ['--turn', `conversation number ${index + 1}`]), { env: h.env, cwd: branch })
      await new Promise((done) => setTimeout(done, 20))
    }

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    const sessionsNow = async () => (await (await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })).json())
    const before = await sessionsNow()
    const older = before.filter((meta) => made.some((one) => one.session === meta.id)).sort((left, right) => String(left.updated).localeCompare(String(right.updated)))[0]
    assert.ok(older !== undefined, `the older session is known\nsaw: ${JSON.stringify(before)}`)

    browser = await openBrowser()
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, made[1].session)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    /** Expand to the session rows and read their order and their age stamps. */
    const readRows = async () =>
      JSON.parse(
        await browser.evaluate(`(async () => {
          const wait = (ms) => new Promise((done) => setTimeout(done, ms))
          const rows = () => [...document.querySelectorAll('#tree .row')]
          const rowFor = (label) => rows().find((row) => row.querySelector('.label')?.textContent === label)
          const ensureOpen = async (label) => {
            for (let attempt = 0; attempt < 30; attempt += 1) {
              const row = rowFor(label)
              if (row === undefined) { await wait(150); continue }
              const li = row.closest('li')
              if (li.dataset.open !== 'true') row.click()
              await wait(200)
              if (li.dataset.open === 'true') return true
            }
            return false
          }
          for (let attempt = 0; attempt < 30 && rows().length === 0; attempt += 1) await wait(150)
          await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
          await ensureOpen('_tools_')
          await ensureOpen('some-tool')
          const sessionRows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          return JSON.stringify({
            labels: sessionRows.map((li) => li.querySelector(':scope > .row .label').textContent),
            stamps: sessionRows.map((li) => li.querySelector(':scope > .row .age')?.dataset.stamp ?? null),
            ages: sessionRows.map((li) => li.querySelector(':scope > .row .age')?.textContent ?? null),
          })
        })()`),
      )
    /** The age and controls' positions, so the pin can be judged by what it must **not** move. */
    const geometry = async () =>
      JSON.parse(
        await browser.evaluate(`(() => {
          const rows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          return JSON.stringify(rows.map((li) => {
            const row = li.querySelector(':scope > .row')
            const age = row.querySelector(':scope > .row-right .age')
            const tools = row.querySelector(':scope > .row-right .row-tools')
            const slot = row.querySelector('.row-right > .pin-slot')
            const box = (node) => node === null ? null : (() => { const rect = node.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.width)] })()
            /** The slot element always exists; it is a **mark** only when it carries the glyph. */
            const marked = slot === null || slot.querySelector('svg') === null ? null : box(slot)
            return { age: box(age), tools: box(tools), slot: marked, slotGlyph: slot === null ? null : slot.querySelector('svg') !== null }
          }))
        })()`),
      )
    /** Read the rows first — reading expands the tree — then measure the boxes on the rows as drawn. */
    const earlier = await readRows()
    const geometryBefore = await geometry()
    /**
     * The order is newest-write first. Rows the store does not know (definitions without a record) carry no stamp; they sort
     * after the stamped ones, so the stamps read in descending order on their own.
     */
    const stamped = earlier.stamps.filter((stamp) => stamp !== null)
    assert.ok(stamped.length >= 2, `both written sessions carry a stamp\nsaw: ${JSON.stringify(earlier)}`)
    assert.deepEqual(stamped, [...stamped].sort((left, right) => String(right).localeCompare(String(left))), `rows order by their write time, newest first\nsaw: ${JSON.stringify(earlier)}`)

    /** Write to the older session the way the composer does, and watch the list re-read itself. */
    const continued = await fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: older.id, prompt: 'a follow-up that should move this row', folder: branch }),
    })
    assert.equal(continued.status, 200, `the follow-up turn runs\n${await continued.clone().text()}`)
    await continued.text()
    await new Promise((done) => setTimeout(done, 2500))
    const later = await readRows()
    assert.equal(later.labels[0], String(older.title), `the session just written to moved to the top\nsaw: ${JSON.stringify(later)}`)
    const olderMeta = (await sessionsNow()).find((meta) => meta.id === older.id)
    assert.equal(later.stamps[0], olderMeta?.updated, `its row age reads the time it was written to\nsaw: ${JSON.stringify({ stamp: later.stamps[0], meta: olderMeta?.updated })}`)
    assert.notEqual(later.ages[0], earlier.ages.at(-1), 'and the age text is no longer the one it showed before the write')

    /**
     * Pin through the **hover control**, with trusted pointer input — the path the owner pressed.
     *
     * Regression this encodes: the age span shares the row's right slot with the controls and used to receive the press
     * (measured: the icon blinked while hovered and the mousedown target was the age). The press must reach the control.
     */
    const pinTarget = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const rows = () => [...document.querySelectorAll('#tree li[data-kind="session"]')]
        const target = rows()[1]
        const row = target.querySelector(':scope > .row')
        const rect = row.getBoundingClientRect()
        await wait(50)
        const button = [...target.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((candidate) => (candidate.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
        if (button === undefined) return JSON.stringify({ error: 'no pin button' })
        const own = button.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(own.left + own.width / 2), y: Math.round(own.top + own.height / 2), row: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }, label: target.querySelector(':scope > .row .label').textContent })
      })()`),
    )
    assert.equal(pinTarget.error, undefined, `the second row offers a pin\nsaw: ${JSON.stringify(pinTarget)}`)
    /** Enter the row to reveal its controls, then measure the control's fresh box and press it. */
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pinTarget.row.x, y: pinTarget.row.y })
    await new Promise((done) => setTimeout(done, 300))
    const freshPin = JSON.parse(
      await browser.evaluate(`(() => {
        const target = [...document.querySelectorAll('#tree li[data-kind="session"]')][1]
        const button = [...target.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((candidate) => (candidate.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
        const own = button.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(own.left + own.width / 2), y: Math.round(own.top + own.height / 2) })
      })()`),
    )
    await browser.evaluate(`(() => {
      window.__pinPress = []
      document.addEventListener('mousedown', (event) => {
        const at = event.target instanceof Element ? event.target : null
        window.__pinPress.push({ target: at === null ? 'none' : at.tagName + '|' + String(at.className).slice(0, 24), atPoint: (() => { const point = document.elementFromPoint(event.clientX, event.clientY); return point === null ? 'none' : point.tagName + '|' + (point.getAttribute('aria-label') ?? '') })() })
      }, true)
    })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: freshPin.x, y: freshPin.y })
    await new Promise((done) => setTimeout(done, 250))
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: freshPin.x, y: freshPin.y, button: 'left', buttons: 1, clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: freshPin.x, y: freshPin.y, button: 'left', buttons: 0, clickCount: 1 })
    await new Promise((done) => setTimeout(done, 1500))
    const press = JSON.parse(await browser.evaluate('JSON.stringify(window.__pinPress)'))
    assert.equal(press.length, 1, `the press was observed\nsaw: ${JSON.stringify(press)}`)
    assert.ok(!String(press[0].target).includes('SPAN|age'), `the press reaches the control, not the age painted beside it\nsaw: ${JSON.stringify(press)}`)
    const pinned = await readRows()
    assert.equal(pinned.labels[0], pinTarget.label, `a pressed pin holds the top of its folder\nsaw: ${JSON.stringify({ pinned, pinTarget, press })}`)
    const pinnedMetas = (await sessionsNow()).filter((meta) => meta.pinned === true)
    assert.equal(pinnedMetas.length, 1, `and the store records exactly one pin\nsaw: ${JSON.stringify(pinnedMetas)}`)

    /**
     * **A pin moves nothing.** The age and the controls keep their x position — the report that the pin icon jumped to the left
     * when a row was pinned is judged here — and the state is the filled pin in the slot that every row reserves.
     */
    const geometryAfter = await geometry()
    const byLabel = new Map((await readRows()).labels.map((label, index) => [label, index]))
    const pinnedIndex = byLabel.get(pinTarget.label)
    assert.ok(pinnedIndex !== undefined, 'the pinned row is in the list')
    /** Find the same row by its slot: after the pin it is the one whose slot holds a glyph. */
    const geometryOfTarget = geometryBefore.find((row, index) => earlier.labels[index] === pinTarget.label)
    const after = geometryAfter.find((row) => row.slotGlyph === true)
    assert.ok(after !== undefined, `the pinned row draws a glyph in its slot\nsaw: ${JSON.stringify(geometryAfter)}`)
    /**
     * The marker is added at the right, so the age moves left by its width when a row is pinned — the mark is what moved, not the
     * row. What must hold is that the mark ends at the row's **content edge** and that, on hover, the pin control lands on the
     * same right edge (the two states swap in place rather than overlapping).
     */
    const edges = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const pinnedRow = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.dataset.pinned === 'true')
        const row = pinnedRow.querySelector(':scope > .row')
        const rowBox = row.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(row).paddingRight)
        const slot = row.querySelector('.row-right > .pin-slot')
        const marker = slot.getBoundingClientRect()
        /** Focus the row (the item's one Tab stop since #92): the controls replace the age and the marker in the same right-aligned flow. */
        row.focus()
        await wait(120)
        const pin = [...row.querySelectorAll('.row-right > .row-tools > .session-actions > button')].find((button) => (button.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
        const pinBox = pin === null || pin === undefined ? null : pin.getBoundingClientRect()
        const markerOnHover = getComputedStyle(slot).display
        const pinGlyphs = [...row.querySelectorAll('svg')].filter((svg) => svg.closest('.row-tools') !== null || svg.closest('.pin-slot') !== null).length
        row.blur()
        return JSON.stringify({
          contentRight: Math.round(rowBox.right - padding),
          markerRight: Math.round(marker.right),
          pinRight: pinBox === null ? null : Math.round(pinBox.right),
          markerOnHover,
          pinGlyphs,
        })
      })()`),
    )
    assert.equal(edges.markerRight, edges.contentRight, `the mark ends at the row's content edge\nsaw: ${JSON.stringify(edges)}`)
    assert.equal(edges.pinRight, edges.markerRight, `and the hover pin control lands on the same right edge\nsaw: ${JSON.stringify(edges)}`)
    assert.equal(edges.markerOnHover, 'none', 'while the marker steps aside on hover, so only one pin is drawn at a time')
    /**
     * And the mark appears **beside the name**, where it was not before: the target row had no badge at rest, and after
     * pinning it carries one — while the age and the tools above kept their boxes, which is the rule the earlier fixed
     * slot existed to protect and the dynamic badge keeps for free.
     */
    /** The mark only exists on a pinned row, and it sits **at the right edge** — never beside the name. */
    assert.equal(geometryOfTarget.slot, null, 'the row carried no pin mark before it was pinned')
    assert.ok(after.slot !== null, 'and carries one after')
    assert.equal(Math.round(after.slot[1]), 16, `the mark is 16px wide\nsaw: ${JSON.stringify(geometryAfter)}`)
    assert.equal(await browser.evaluate(`document.querySelectorAll('#tree .pin-mark').length`), 0, 'and nothing draws a pin beside a name')
    /** One pin per pinned row, and no second one on the row's left: the old badge class is gone from the page entirely. */
    const pins = JSON.parse(
      await browser.evaluate(`(() => {
        const row = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.dataset.pinned === 'true')
        return JSON.stringify({
          leftBadges: document.querySelectorAll('#tree .pin').length,
          marks: row === null ? null : row.querySelectorAll('.row-right > .pin-slot svg').length,
        })
      })()`),
    )
    assert.equal(pins.leftBadges, 0, 'no pin is drawn on the row left')
    assert.equal(pins.marks, 1, 'and exactly one mark sits at the right')
    /**
     * The icon's **ink and weight**, measured: the mark is the neutral caption ink and not the accent, it is drawn solid (both
     * artwork paths filled) at the reference's Regular 1px, and the pin control that replaces it on hover is the same colour,
     * weight and shape — the icon looks identical whether the row is hovered or not, which is the owner's request.
     */
    const ink = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const pinnedRow = [...document.querySelectorAll('#tree li[data-kind="session"]')].find((li) => li.dataset.pinned === 'true')
        const slot = pinnedRow.querySelector('.row-right > .pin-slot')
        const markerSvg = slot.querySelector('svg')
        /** Both artwork paths are measured, because a malformed path paints nothing: the pin's thin tail disappeared that way once. */
        const markerPaths = [...markerSvg.querySelectorAll('path')].map((path) => {
          const box = path.getBBox()
          const style = getComputedStyle(path)
          const round = (value) => Math.round(value * 100) / 100
          return { w: round(box.width), h: round(box.height), bottom: round(box.y + box.height), filled: style.fill !== 'none', stroke: style.stroke }
        })
        /** The head is the path that states where the tail starts; the tail is the other one, a tapered quad. */
        const headPath = markerSvg.querySelector('path[data-tail-base]')
        const tailPath = [...markerSvg.querySelectorAll('path')].find((path) => path !== headPath)
        const statedBase = (headPath?.dataset.tailBase ?? '').split(' ').map(Number)
        const tailQuad = (() => {
          if (tailPath === null || tailPath === undefined) return null
          const numbers = (tailPath.getAttribute('d') ?? '').match(/-?[0-9]+(?:[.][0-9]+)?/g)?.map(Number) ?? []
          if (numbers.length < 8) return null
          const corner = (index) => ({ x: numbers[index * 2], y: numbers[index * 2 + 1] })
          const [v0, v1, v2, v3] = [corner(0), corner(1), corner(2), corner(3)]
          const base = { x: (v0.x + v3.x) / 2, y: (v0.y + v3.y) / 2 }
          return {
            base,
            baseWidth: Math.hypot(v0.x - v3.x, v0.y - v3.y),
            tipWidth: Math.hypot(v1.x - v2.x, v1.y - v2.y),
            baseDistance: statedBase.length === 2 ? Math.hypot(base.x - statedBase[0], base.y - statedBase[1]) : null,
          }
        })()
        const marker = {
          color: getComputedStyle(slot).color,
          weight: getComputedStyle(markerSvg).strokeWidth,
          paths: markerPaths,
          tailQuad,
        }
        pinnedRow.querySelector(':scope > .row').focus()
        await wait(150)
        const control = pinnedRow.querySelector('.row-right > .row-tools > .session-actions > .pin-action')
        const controlSvg = control.querySelector('svg')
        const hovered = {
          color: getComputedStyle(control).color,
          weight: getComputedStyle(controlSvg).strokeWidth,
          filled: [...controlSvg.querySelectorAll('path')].filter((path) => getComputedStyle(path).fill !== 'none').length,
          markerDisplay: getComputedStyle(slot).display,
        }
        pinnedRow.querySelector(':scope > .row').blur()
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()
        return JSON.stringify({ marker, hovered, accent })
      })()`),
    )
    assert.notEqual(ink.marker.color.toLowerCase(), ink.accent, `the mark is not the accent ink\nsaw: ${JSON.stringify(ink)}`)
    assert.equal(ink.marker.paths.filter((path) => path.filled).length, 2, `the mark paints both shapes solid\nsaw: ${JSON.stringify(ink.marker)}`)
    assert.equal(ink.marker.weight, '1px', `at the reference's Regular 1px stroke\nsaw: ${JSON.stringify(ink)}`)
    assert.equal(ink.hovered.color, ink.marker.color, `the hover pin control keeps the same ink\nsaw: ${JSON.stringify(ink)}`)
    assert.equal(ink.hovered.weight, ink.marker.weight, `and the same weight\nsaw: ${JSON.stringify(ink)}`)
    assert.equal(ink.hovered.filled, 2, `and stays solid (both shapes filled)\nsaw: ${JSON.stringify(ink)}`)
    assert.equal(ink.hovered.markerDisplay, 'none', 'with the marker swapped out, so one icon is drawn')
    /**
     * The artwork has a **head and a tail**: the needle path must paint (a non-zero box) and reach below the body. A cubic path
     * whose commands were compacted into one coordinate pair each is invalid and paints nothing — measured, that is exactly why
     * the pin's thin tail was missing while its head showed.
     */
    assert.equal(ink.marker.paths.length, 2, `the mark is the pin artwork's two shapes\nsaw: ${JSON.stringify(ink.marker)}`)
    const pinHead = ink.marker.paths.find((path) => path.w > 5)
    const pinTail = ink.marker.paths.find((path) => path.w <= 5)
    assert.ok(pinHead !== undefined, `the pin's head is the larger shape\nsaw: ${JSON.stringify(ink.marker.paths)}`)
    assert.ok(pinHead.w > 1 && pinHead.h > 1, `and it paints\nsaw: ${JSON.stringify(pinHead)}`)
    assert.ok(pinTail !== undefined, `the pin's tail is the smaller shape\nsaw: ${JSON.stringify(ink.marker.paths)}`)
    assert.ok(pinTail.w > 1 && pinTail.h > 1, `and it paints (a broken path paints nothing)\nsaw: ${JSON.stringify(pinTail)}`)
    assert.equal(pinTail.bottom > pinHead.bottom, true, `its tail reaches below the head, so the pin reads as a pin\nsaw: ${JSON.stringify(ink.marker.paths)}`)
    assert.equal(pinTail.filled, true, 'the tail is a filled taper, not a stroked line')
    assert.equal(pinTail.stroke, 'none', 'with no stroke that would add its own width around it')
    /** **In the middle of the head**: the tail's stated base is the midpoint of the head's lower edge, and the quad starts there. */
    const tailQuad = ink.marker.tailQuad
    assert.ok(tailQuad !== null, `the tail is a measurable quad\nsaw: ${JSON.stringify(ink.marker.tailQuad)}`)
    assert.ok(tailQuad.baseDistance < 0.2, `the tail starts at the middle of the head, where it says it does\nsaw: ${JSON.stringify(tailQuad)}`)
    /** **Not over thin, not over thick**: the reference needle is about 0.95 across at the body, narrowing to a point. */
    assert.ok(tailQuad.baseWidth >= 0.7 && tailQuad.baseWidth <= 1.1, `the tail's base matches the reference's thinness\nsaw: ${JSON.stringify(tailQuad)}`)
    assert.ok(tailQuad.tipWidth > 0 && tailQuad.tipWidth < tailQuad.baseWidth / 3, `and it narrows to a point\nsaw: ${JSON.stringify(tailQuad)}`)
    /** And the hover control carries the state in its glyph: filled on a pinned row, outline otherwise. */
    const glyphs = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
        return JSON.stringify(rows.map((li) => {
          const pin = [...li.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((button) => (button.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
          /** Both DSH pins fill the needle; the filled variant also fills the **body**, so the count is the difference. */
          const filled = pin === undefined ? null : pin.querySelectorAll('path[fill]').length >= 2
          return { label: li.querySelector(':scope > .row .label').textContent, filled, pinned: li.dataset.pinned === 'true' }
        }))
      })()`),
    )
    const pinnedGlyph = glyphs.find((row) => row.label === pinTarget.label)
    assert.equal(pinnedGlyph?.filled, true, `a pinned row's pin control is the filled glyph\nsaw: ${JSON.stringify(glyphs)}`)
    assert.ok(glyphs.filter((row) => row.pinned !== true).every((row) => row.filled !== true), 'an unpinned row keeps the outline glyph')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a pinned row glides to its new place, and reduced motion skips the glide', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const h = harness('session-pin-glide')
  let live
  let browser
  try {
    await conventionsFixture(h)
    const branch = join(h.work, '_tools_', 'some-tool')
    let newest
    for (let index = 0; index < 3; index += 1) {
      newest = parseJson((await runCli(adminArgs(h, ['session', 'new', branch, '--json']), { env: h.env, cwd: h.work })).stdout).session
      await runCli(adminArgs(h, ['--turn', `conversation for the glide ${index + 1}`]), { env: h.env, cwd: branch })
      await new Promise((done) => setTimeout(done, 20))
    }
    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    browser = await openBrowser()
    /** The page opens no session on its own (#17), so the session this check is about is opened by name. */
    await browser.gotoSession(live.url, newest)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)

    /**
     * Pin and sample **in one page turn**. The animation is 200 ms and the reference's glide is the claim, so the click and the
     * `getAnimations()` read happen in the same script — a CDP round trip under load can outlast the animation and report
     * nothing while the row did glide.
     */
    const result = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const frame = () => new Promise((done) => requestAnimationFrame(() => done()))
        const rows = () => [...document.querySelectorAll('#tree .row')]
        const rowFor = (label) => rows().find((row) => row.querySelector('.label')?.textContent === label)
        const ensureOpen = async (label) => {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const row = rowFor(label)
            if (row === undefined) { await wait(150); continue }
            const li = row.closest('li')
            if (li.dataset.open !== 'true') row.click()
            await wait(200)
            if (li.dataset.open === 'true') return true
          }
          return false
        }
        for (let attempt = 0; attempt < 30 && rows().length === 0; attempt += 1) await wait(150)
        await ensureOpen(rows()[0]?.querySelector('.label')?.textContent ?? '')
        await ensureOpen('_tools_')
        await ensureOpen('some-tool')
        /**
         * Wait for the session rows to be drawn: the tree re-reads itself when activity arrives, so the count can be mid-render
         * right after an expansion. Retry the deepest level when the rows are not there yet.
         */
        for (let attempt = 0; attempt < 25 && document.querySelectorAll('#tree li[data-kind="session"]').length < 2; attempt += 1) {
          await wait(200)
          if (document.querySelectorAll('#tree li[data-kind="session"]').length < 2) await ensureOpen('some-tool')
        }
        const beforeOrder = [...document.querySelectorAll('#tree li[data-kind="session"] > .row .label')].map((label) => label.textContent)
        const target = [...document.querySelectorAll('#tree li[data-kind="session"]')][1]
        const key = target.dataset.rowKey
        const pin = [...target.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((candidate) => (candidate.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
        if (pin === undefined) return JSON.stringify({ error: 'no pin control' })
        pin.click()
        /**
         * The handler is async — a POST, then a tree re-read, then the glide — so the animation starts a few frames later. Poll
         * for it; the glide itself is 200 ms, which is why this is a tight loop rather than one delayed sample.
         */
        const moveRow = () => document.querySelector('#tree li[data-row-key="' + key + '"]')
        let animations = []
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const li = moveRow()
          animations = li === null ? [] : li.getAnimations().map((animation) => ({
            duration: animation.effect?.getTiming?.().duration ?? null,
            easing: animation.effect?.getTiming?.().easing ?? null,
            transforms: (animation.effect?.getKeyframes?.() ?? []).map((frameEntry) => frameEntry.transform).filter((value) => typeof value === 'string'),
          }))
          if (animations.length > 0) break
          await wait(8)
        }
        /**
         * In flight: the row's **rendered transform must change** while the glide runs. The row is re-queried every turn, because
         * a tree re-read can replace the element mid-flight and a held detached animation's clock read 0 through the whole window.
         */
        const startFrame = moveRow() === null ? null : getComputedStyle(moveRow()).transform
        let midFrame = null
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const li = moveRow()
          if (li !== null) {
            const frame = getComputedStyle(li).transform
            if (frame !== 'none' && frame !== startFrame) {
              midFrame = frame
              break
            }
          }
          await wait(16)
        }
        await wait(500)
        const settled = {
          transform: getComputedStyle(document.querySelector('#tree li[data-row-key="' + key + '"]')).transform,
          order: [...document.querySelectorAll('#tree li[data-kind="session"] > .row .label')].map((label) => label.textContent),
          pinned: [...document.querySelectorAll('#tree li[data-kind="session"]')].map((li) => li.dataset.pinned === 'true'),
          glyphFilled: (() => {
            const li = document.querySelector('#tree li[data-row-key="' + key + '"]')
            const button = [...li.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((candidate) => (candidate.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
            if (button === undefined) return null
            /** Solid: both artwork shapes (the head and the tapered tail) are filled. */
            const paths = [...button.querySelectorAll('svg path')]
            return paths.filter((path) => getComputedStyle(path).fill !== 'none').length === 2
          })(),
        }
        return JSON.stringify({ beforeOrder, key, animations, startFrame, midFrame, settled })
      })()`),
    )
    assert.equal(result.error, undefined, `the fixture offered a pin control\nsaw: ${JSON.stringify(result)}`)
    const glide = result.animations.find((animation) => animation.transforms.length >= 2)
    assert.ok(glide !== undefined, `the pinned row glides with a transform animation\nsaw: ${JSON.stringify(result.animations)}`)
    assert.equal(glide.duration, 400, `with the slower 400 ms glide the owner asked for\nsaw: ${JSON.stringify(glide)}`)
    assert.equal(glide.easing, 'ease-out', `and its ease-out\nsaw: ${JSON.stringify(glide)}`)
    assert.ok(
      result.midFrame !== null && result.midFrame !== result.startFrame,
      `the row is in flight while the animation runs\nsaw: ${JSON.stringify({ startFrame: result.startFrame, midFrame: result.midFrame })}`,
    )
    assert.equal(result.settled.transform, 'none', `and settles at its resting position\nsaw: ${JSON.stringify(result.settled)}`)
    assert.equal(result.settled.order[0], result.beforeOrder[1], `with the pinned row at the top\nsaw: ${JSON.stringify(result.settled)}`)
    assert.equal(result.settled.pinned[0], true, 'drawn as pinned')
    assert.equal(result.settled.glyphFilled, true, 'with the solid pin on its unpin control')

    /** Reduced motion: the same action moves the row with no animation at all. */
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reduced = JSON.parse(
      await browser.evaluate(`(async () => {
        const wait = (ms) => new Promise((done) => setTimeout(done, ms))
        const frame = () => new Promise((done) => requestAnimationFrame(() => done()))
        const target = [...document.querySelectorAll('#tree li[data-kind="session"]')][0]
        const key = target.dataset.rowKey
        const pin = [...target.querySelectorAll(':scope > .row .row-tools > .session-actions > button')].find((candidate) => (candidate.getAttribute('aria-label') || '').toLowerCase().includes('pin'))
        pin.click()
        await frame()
        await frame()
        const animations = [...document.querySelectorAll('#tree li[data-row-key="' + key + '"]')].flatMap((li) => li.getAnimations()).filter((animation) => (animation.effect?.getKeyframes?.() ?? []).some((entry) => typeof entry.transform === 'string'))
        await wait(300)
        return JSON.stringify({ animations: animations.length, first: [...document.querySelectorAll('#tree li[data-kind="session"] > .row .label')][0]?.textContent ?? null })
      })()`),
    )
    assert.equal(reduced.animations, 0, `reduced motion skips the glide\nsaw: ${JSON.stringify(reduced)}`)
    assert.notEqual(reduced.first, result.beforeOrder[1], 'while the order still changes')
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('pins follow DSH in both orders: prompt time under Last updated, the later pin first under Manual, the flat list like the tree', async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * R-developer-eight-17 (DSH parity C13) with C17 and issue #63. Two pins read one way in the tree and the other way in
   * In one list, which sorted by creation. Since C17 the flat list follows the tree's rule in the **selected order**,
   * as DSH's flat list partitions its own account's order (dsh-client-ui-workspace/lib/client.js:1146-1154,
   * 3583-3584). The rule, from DSH's README (*Reordering and view options*):
   * - **Last updated** sorts each partition by the latest prompt or steer, and pin time does not affect it.
   * - **Manual** keeps a saved sequence. Entering it freezes the order on screen.
   * - Pinning "moves the Session to the front of its complete saved sequence without changing the selected mode. It
   *   leads the pinned partition in Manual but need not lead it in Last updated. Unpinning leaves the saved position
   *   unchanged."
   * DSH fronts a pin in the group's account and the flat list's (`pinSessionOrder` / `pinOrderAccounts`,
   * client.js:1303-1309, 1343-1345). This check judged "the later pin leads" in the only order main had, and is
   * rewritten to that rule.
   *
   * The fixture: four sessions in one workspace, prompted first..fourth, then first again, so it has the latest prompt.
   * The third is pinned before the second, so the second is the later pin and the third has the later prompt. Manual is
   * entered from a freshly loaded In one list, so the tree has not been drawn in that page load.
   */
  const h = harness('session-pin-order')
  let live
  let browser
  try {
    entry(join(h.work, 'INDEX.md'), '# a workspace for the pin order\n')
    const added = await runCli(adminArgs(h, ['workspace', 'add', h.work]), { env: h.env, cwd: h.work })
    assert.equal(added.code, 0, `the fixture registered its root\n${added.stdout}${added.stderr}`)
    const made = []
    for (let index = 0; index < 4; index += 1) {
      const created = await runCli(adminArgs(h, ['session', 'new', h.work, '--json']), { env: h.env, cwd: h.work })
      assert.equal(created.code, 0, `session ${index + 1} was created\n${created.stdout}${created.stderr}`)
      made.push(parseJson(created.stdout).session)
      const turn = await runCli(adminArgs(h, ['--turn', `pin order conversation ${index + 1}`]), { env: h.env, cwd: h.work })
      assert.equal(turn.code, 0, `session ${index + 1} took a turn\n${turn.stdout}${turn.stderr}`)
      await new Promise((done) => setTimeout(done, 30))
    }
    const [first, second, third, fourth] = made

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    /** The first session is prompted again, so it has the latest prompt of the unpinned two. */
    const written = await fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: first, prompt: 'a follow-up that makes the oldest session the latest prompted', folder: h.work }),
    })
    assert.equal(written.status, 200, `the follow-up turn runs\n${await written.clone().text()}`)
    await written.text()
    /** The third session is pinned, then the second: the second is the later pin, the third the later prompt. */
    const pin = (id) =>
      fetch(new URL(`/api/sessions/${id}/flags`, live.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      })
    assert.equal((await pin(third)).status, 200, 'the first pin was accepted')
    await new Promise((done) => setTimeout(done, 30))
    assert.equal((await pin(second)).status, 200, 'the second pin was accepted')
    const metas = await (await fetch(new URL('/api/sessions', live.url), { headers: { cookie } })).json()
    const metaOf = (id) => metas.find((meta) => meta.id === id)
    assert.ok(String(metaOf(second)?.pinnedAt) > String(metaOf(third)?.pinnedAt), `the store says which pin is later\nsaw: ${JSON.stringify(metas)}`)
    assert.ok(String(metaOf(third)?.updated) > String(metaOf(second)?.updated), `and which pinned session was prompted later\nsaw: ${JSON.stringify(metas)}`)
    assert.ok(String(metaOf(first)?.updated) > String(metaOf(fourth)?.updated), `and which unpinned session was prompted last\nsaw: ${JSON.stringify(metas)}`)

    /**
     * Page helpers, installed once per page load: read the rows of whichever view is drawn, choose a View options item,
     * and press a row's pin control. Each read waits until it sees four rows, opening the workspace if it is closed.
     */
    const helpers = `(() => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms))
      const sessionLis = () => [...document.querySelectorAll('#tree li[data-kind="session"]')]
      window.__pinOrder = {
        async read() {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const workspaceLi = document.querySelector('#tree li[data-kind="workspace"]')
            if (workspaceLi !== null && workspaceLi.dataset.open !== 'true' && attempt % 5 === 0) workspaceLi.querySelector(':scope > .row').click()
            if (sessionLis().length >= 4 && (workspaceLi === null || workspaceLi.dataset.open === 'true')) break
            await wait(150)
          }
          await wait(400)
          return {
            view: document.querySelector('#tree li[data-kind="workspace"]') === null ? 'flat' : 'tree',
            ids: sessionLis().map((li) => li.dataset.sessionId ?? null),
            pinned: sessionLis().map((li) => li.dataset.pinned === 'true'),
          }
        },
        async choose(label) {
          document.querySelector('#view-options button').click()
          await wait(250)
          const item = [...document.querySelectorAll('#view-options .menu:not([hidden]) button')].find((button) => (button.textContent || '').trim() === label)
          if (item === undefined) return false
          item.click()
          await wait(1200)
          return true
        },
        async pin(id) {
          const button = document.querySelector('#tree li[data-kind="session"][data-session-id="' + id + '"] > .row button.pin-action')
          if (button === null) return false
          button.click()
          await wait(1500)
          return true
        },
        stored() {
          return localStorage.getItem('heddle.tree.order.v1')
        },
      }
      return true
    })()`
    const page = async (call) => JSON.parse(await browser.evaluate(`(async () => JSON.stringify(await window.__pinOrder.${call}))()`, 30_000))
    const name = (ids) => (ids ?? []).map((id) => ['first', 'second', 'third', 'fourth'][made.indexOf(id)] ?? id)
    const byPrompt = [third, second, first, fourth]

    browser = await openBrowser()
    /**
     * Opened on one of the four by name: a plain first visit starts a fresh New session (#17), whose open blank row
     * would stand among the four this check orders. Opening a session writes nothing, so the order is unchanged.
     */
    await browser.gotoSession(live.url, fourth)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    await browser.evaluate(helpers)

    /** Last updated (the default): the pinned part by prompt time, so the later pin does not lead, in both views. */
    const treeUpdated = await page('read()')
    assert.equal(treeUpdated.view, 'tree', `the page opens on the tree\nsaw: ${JSON.stringify(treeUpdated)}`)
    assert.deepEqual(name(treeUpdated.ids), name(byPrompt), `Last updated: the pin prompted later leads, not the later pin\nsaw: ${JSON.stringify(name(treeUpdated.ids))}`)
    assert.deepEqual(treeUpdated.pinned, [true, true, false, false], 'and the two leading rows are drawn as pinned')
    assert.equal(await page(`choose('In one list')`), true, 'View options offers In one list')
    const flatUpdated = await page('read()')
    assert.equal(flatUpdated.view, 'flat', `In one list drew no workspace rows\nsaw: ${JSON.stringify(flatUpdated)}`)
    assert.deepEqual(name(flatUpdated.ids), name(treeUpdated.ids), `In one list reads as the tree does under Last updated\nsaw: ${JSON.stringify(name(flatUpdated.ids))}`)

    /** Reload into the flat list, choose Manual there, and the tree keeps the order on screen rather than pin time. */
    await browser.goto(live.url)
    await browser.waitFor(`document.querySelectorAll('#tree .row').length > 0`, 20_000)
    await browser.evaluate(helpers)
    assert.equal(await page(`choose('Manual')`), true, 'View options offers Manual')
    const flatManual = await page('read()')
    assert.equal(flatManual.view, 'flat', 'the reload kept In one list')
    assert.deepEqual(name(flatManual.ids), name(byPrompt), `entering Manual freezes the flat list as it was\nsaw: ${JSON.stringify(name(flatManual.ids))}`)
    assert.equal(JSON.parse(String(await page('stored()'))).orderBy, 'manual', 'the browser stores Manual')
    assert.equal(await page(`choose('Workspace Tree')`), true, 'View options offers Workspace Tree')
    const treeManual = await page('read()')
    assert.deepEqual(
      name(treeManual.ids),
      name(byPrompt),
      `Manual chosen in the flat list froze the tree's order too, rather than putting the later pin first\nsaw: ${JSON.stringify(name(treeManual.ids))}`,
    )

    /**
     * Under Manual an unpin moves nothing in the saved sequence. Manual froze Last updated's sequence, in which the second
     * (the oldest prompt) is last, so the row returns to that slot.
     */
    assert.equal(await page(`pin(${JSON.stringify(second)})`), true, 'the second row offers its pin control')
    const unpinned = await page('read()')
    assert.deepEqual(name(unpinned.ids), name([third, first, fourth, second]), `the unpinned row goes back to its saved slot\nsaw: ${JSON.stringify(name(unpinned.ids))}`)
    assert.deepEqual(unpinned.pinned, [true, false, false, false], 'and only the third is drawn as pinned')

    /** Pinning it again under Manual fronts it: the later pin leads, in the tree and in the flat list alike. */
    assert.equal(await page(`pin(${JSON.stringify(second)})`), true, 'the second row offers its pin control again')
    const repinned = await page('read()')
    const latestPinFirst = [second, third, first, fourth]
    assert.deepEqual(name(repinned.ids), name(latestPinFirst), `under Manual the later pin leads the pinned part\nsaw: ${JSON.stringify(name(repinned.ids))}`)
    assert.deepEqual(repinned.pinned, [true, true, false, false], 'and both pins are drawn')
    assert.equal(await page(`choose('In one list')`), true, 'back to In one list')
    const flatRepinned = await page('read()')
    assert.deepEqual(name(flatRepinned.ids), name(latestPinFirst), `the pin fronted the flat list as well\nsaw: ${JSON.stringify(name(flatRepinned.ids))}`)

    /** Unpinned again, it keeps the front slot the pin gave it: it heads the rest, ahead of later prompts. */
    assert.equal(await page(`choose('Workspace Tree')`), true, 'back to Workspace Tree')
    assert.equal(await page(`pin(${JSON.stringify(second)})`), true, 'the second row offers its pin control a third time')
    const kept = [third, second, first, fourth]
    const unpinnedAgain = await page('read()')
    assert.deepEqual(name(unpinnedAgain.ids), name(kept), `an unpin leaves the saved position under Manual\nsaw: ${JSON.stringify(name(unpinnedAgain.ids))}`)
    assert.deepEqual(unpinnedAgain.pinned, [true, false, false, false], 'with only the third pinned')
    assert.equal(await page(`choose('In one list')`), true, 'In one list once more')
    const flatKept = await page('read()')
    assert.deepEqual(name(flatKept.ids), name(kept), `and the flat list keeps it there too\nsaw: ${JSON.stringify(name(flatKept.ids))}`)

    /** Last updated discards the layout: every part by prompt time again, in either view. */
    assert.equal(await page(`choose('Last updated')`), true, 'View options offers Last updated')
    const backByPrompt = [third, first, fourth, second]
    const flatBack = await page('read()')
    assert.deepEqual(name(flatBack.ids), name(backByPrompt), `Last updated orders by prompt time again\nsaw: ${JSON.stringify(name(flatBack.ids))}`)
    assert.equal(await page(`choose('Workspace Tree')`), true, 'back to Workspace Tree')
    const treeBack = await page('read()')
    assert.deepEqual(name(treeBack.ids), name(flatBack.ids), `and the tree reads as the flat list does\nsaw: ${JSON.stringify(name(treeBack.ids))}`)
  } finally {
    browser?.close()
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

/**
 * The text of every tool result a turn's stream carried, in order: the server's SSE body is one JSON event per data
 * line, and a tool result is a message whose role is tool.
 */
function toolResultsInStream(body) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice('data: '.length))
      } catch {
        return null
      }
    })
    .map((data) => data?.event)
    .filter((event) => event?.type === 'message' && event.message?.role === 'tool')
    .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
}

test("a session's turn runs its tools in the session's own folder, through the server and through the command line", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsWeb()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * R-developer-eight-10 (DSH parity C3), measured on both builds: a turn sent to a session of workspace B ran bash in
   * the directory the server was launched in, so the model's pwd printed that directory and its relative paths
   * landed there. DSH runs a session's tools in the session's own directory. The turn here is one scripted bash pwd,
   * and every process that runs it is launched somewhere else: the server in the repository, the command line in a
   * sibling folder A. Neither names a sandbox root, so the only thing that can put the shell in B is the session.
   */
  const h = harness('tool-cwd')
  scriptedConfig({ home: h.home, steps: [{ toolCall: { name: 'bash', arguments: { command: 'pwd' } } }, { text: 'printed the folder' }] })
  const folderA = join(h.work, 'ws-a')
  const folderB = join(h.work, 'ws-b')
  mkdirSync(folderA, { recursive: true })
  mkdirSync(folderB, { recursive: true })
  /** The shell reports its physical directory, so the expectation is the folder's real path. */
  const expected = `${realpathSync(folderB)}\n`
  let live
  try {
    const made = await runCli(adminArgs(h, ['session', 'new', folderB, '--json']), { env: h.env, cwd: h.work })
    assert.equal(made.code, 0, `the session was created in B\n${made.stdout}${made.stderr}`)
    const created = parseJson(made.stdout)

    live = await startServer(
      ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions')],
      { ...h.env, HOME: h.home },
    )
    const handshake = await fetch(live.url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie.length > 0, 'the server issued a cookie')
    const turn = await fetch(new URL('/api/turn', live.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ session: created.session, prompt: 'where am I' }),
    })
    const stream = await turn.text()
    assert.equal(turn.status, 200, `the turn ran through the server\n${stream}`)
    const served = toolResultsInStream(stream)
    assert.equal(served.length, 1, `the turn made its one tool call\n${stream}`)
    assert.equal(served[0], expected, `bash ran in the session's folder, not the server's launch directory (${repoRoot})`)
    live.kill()
    live = undefined

    /** The same session resumed by a command line launched in A, which is the directory its sandbox falls back to. */
    const resumed = await runCli(adminArgs(h, ['--resume', created.session, '--turn', 'and where am I now']), { env: h.env, cwd: folderA })
    assert.equal(resumed.code, 0, `the resumed turn ran\n${resumed.stdout}${resumed.stderr}`)
    const results = readTranscript(join(h.home, 'sessions', created.session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.equal(results.length, 2, `both turns' tool results are in the session\nsaw: ${JSON.stringify(results)}`)
    assert.equal(results[1], expected, `the resumed turn's bash ran in the session's folder, not in A (${folderA})`)
  } finally {
    live?.kill()
    removeDir(h.home)
    removeDir(h.work)
  }
})

test("a session is Last updated by a person's latest prompt, not by the answer or the tool work written after it", async (context) => {
  if (!skipUnless(context, (await supportsCommands()) && (await supportsTurn()), CAPABILITY)) return
  /**
   * R-developer-eight-20 (DSH parity C17), DSH's Last updated: a row is dated by the latest prompt or steer a person
   * wrote. DSH's list takes lastPromptAt from a user-sourced user/message, as that event's own time
   * (dsh-api-session-controller/lib/index.js:1872-1879), and dates the row max(createdAt, lastPromptAt) (index.js:2124-2125).
   * heddle dated it by its last write, so the answer and the turn boundary re-dated it. The turn here runs one scripted
   * bash call that sleeps, so everything written after the prompt is measurably later than the prompt itself.
   */
  const h = harness('last-prompt')
  scriptedConfig({ home: h.home, steps: [{ toolCall: { name: 'bash', arguments: { command: 'sleep 0.4' } } }, { text: 'answered after the pause' }] })
  try {
    const first = await runCli([...h.args, '--turn', 'the prompt that dates this row'], { env: h.env, cwd: h.work })
    assert.equal(first.code, 0, `the turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(id, 'the turn left a session')
    /** The prompt is a user message with no source: a message the harness wrote carries one. */
    const lastPrompt = () =>
      readTranscript(join(h.home, 'sessions', id))
        .filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source === undefined)
        .at(-1)
    const events = readTranscript(join(h.home, 'sessions', id))
    const prompt = lastPrompt()
    const answered = events.filter((event) => event.type === 'assistant/completed' || event.type === 'turn/completed').at(-1)
    assert.ok(prompt !== undefined && answered !== undefined, `the log holds the prompt and the answer\nsaw: ${events.map((event) => event.type).join(', ')}`)
    assert.ok(Date.parse(answered.at) - Date.parse(prompt.at) >= 300, `the answer was written well after the prompt\nprompt ${prompt.at}, answer ${answered.at}`)
    const listed = (await sessionsOf(h)).find((meta) => meta.id === id)
    assert.equal(listed?.updated, prompt.at, `the session is dated by its prompt, not by what was written after it\nsaw: ${JSON.stringify(listed)}`)

    /** The next prompt moves it. */
    const second = await runCli([...h.args, '--turn', 'a second prompt', '--resume', id], { env: h.env, cwd: h.work })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)
    const again = lastPrompt()
    assert.notEqual(again?.at, prompt.at, 'the second prompt is a new event')
    const relisted = (await sessionsOf(h)).find((meta) => meta.id === id)
    assert.equal(relisted?.updated, again?.at, `the next prompt re-dates it\nsaw: ${JSON.stringify(relisted)}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})
