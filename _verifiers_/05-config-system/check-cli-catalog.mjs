import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, parseJson, readTranscript, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 0 — what the shipped profile's command line says, and what it offers the model.
 *
 * Two claims about the repository's own profile (`cordis.yml` and `heddle.patch.yml`, booted by running the
 * harness from the repository root) rather than about a fixture, because both failures this judges lived in
 * that profile and its command line:
 *
 * - **`--json` stdout is the JSON document and nothing else.** A one-shot command printed the plugins' boot lines
 *   (`model: 1 endpoint(s) — …`, `tools: 4 registered …`, `team: durable team service ready`) to stdout ahead of
 *   its JSON, and a turn added its tools' log lines (`turn: wrote …`), so `JSON.parse(stdout)` failed. The
 *   verifiers' own `parseJson` hid it by scanning upward for the last value; this check parses the **whole**
 *   stdout, as a script piping `heddle … --json` into a JSON reader does.
 * - **The tool catalog the command line reports is the one a turn offers, and it carries the goal and todo verbs.**
 *   `heddle tools` and `heddle --turn` apply the tools row's allow list and `heddle web` does not, so a list that
 *   omitted `create_goal`, `get_goal`, `update_goal` and `todo_write` hid them from `heddle tools` and from every
 *   `--turn` while a web turn offered them. `todo_read` is deliberately not required: DSH has no read tool and the
 *   todo-parity change removes it.
 *
 * Offline: the one model is a scripted endpoint, and every store — sessions, workspaces, the endpoint file and the
 * home directory itself — is a fixture under `.heddle-tmp/`. The sandbox root is the fixture too, so a tool call
 * cannot land in the checkout.
 */

const CAPABILITY = 'the one-shot commands goal, tools and --turn with --json'

/** Does the harness under test advertise every command these checks run? Matched as command lines in the help. */
async function supportsCatalog() {
  const help = await runCli(['--help'])
  return (
    /^\s{2}goal\b/m.test(help.stdout) &&
    /^\s{2}tools\b/m.test(help.stdout) &&
    /--turn/.test(help.stdout) &&
    /--json/.test(help.stdout)
  )
}

/**
 * A home for one check: a scripted endpoint, and the flags that keep every store inside it.
 *
 * The working directory stays the repository root (the runner's default), so the tree booted is the shipped
 * profile — the one `heddle web` serves from this checkout — and not a fixture's.
 */
function shippedProfileHarness(label, steps) {
  const home = isolatedHome(`cli-catalog-${label}`)
  const { config } = scriptedConfig({ home, steps })
  return {
    home,
    env: { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    roots: ['--session-root', join(home, 'sessions'), '--sandbox-root', home],
  }
}

/** Parse stdout **whole**: a `--json` run's stdout must be one JSON document with nothing before or after it. */
function wholeJson(stdout, what) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    assert.fail(`${what}: stdout is not one JSON document (${error.message})\n--- stdout ---\n${stdout.slice(0, 1200)}`)
  }
}

test('goal --json prints the JSON document alone on stdout', async (context) => {
  if (!skipUnless(context, await supportsCatalog(), CAPABILITY)) return
  const h = shippedProfileHarness('goal', [{ text: 'ready' }])
  try {
    // A session to ask about, made the ordinary one-shot way. Its stdout is read leniently here: this test's claim
    // is about `goal`, and the turn's own stdout is judged by the third test.
    const turn = await runCli([...h.roots, '--turn', 'start a session', '--json'], { env: h.env })
    assert.equal(turn.code, 0, `the scripted turn ran\n${turn.stdout}${turn.stderr}`)
    const session = parseJson(turn.stdout)?.session
    assert.ok(typeof session === 'string' && session.length > 0, `the turn reported its session\n${turn.stdout}`)

    const goal = await runCli([...h.roots, 'goal', session, '--json'], { env: h.env })
    assert.equal(goal.code, 0, `the goal command ran\n${goal.stdout}${goal.stderr}`)
    const report = wholeJson(goal.stdout, 'heddle goal <session> --json')
    assert.equal(report.session, session, 'the document names the session it was asked about')
    assert.ok('goal' in report, `the document carries the goal field, null when none is set\n${goal.stdout}`)
  } finally {
    removeDir(h.home)
  }
})

test('tools --json prints the JSON document alone, and it lists the goal and todo tools a web turn offers', async (context) => {
  if (!skipUnless(context, await supportsCatalog(), CAPABILITY)) return
  const h = shippedProfileHarness('tools', [{ text: 'unused' }])
  try {
    const run = await runCli([...h.roots, 'tools', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the tools command ran\n${run.stdout}${run.stderr}`)
    // The catalog first, read leniently, so a build that fails both claims reports the missing tools by name; the
    // first test already judges a polluted stdout on its own.
    const tools = parseJson(run.stdout)
    assert.ok(Array.isArray(tools), `the document is a list\n${run.stdout}`)
    const names = tools.map((tool) => tool.name)
    for (const wanted of ['create_goal', 'get_goal', 'update_goal', 'todo_write']) {
      assert.ok(names.includes(wanted), `the shipped profile's catalog lists ${wanted}; it listed ${names.join(', ')}`)
    }
    assert.deepEqual(wholeJson(run.stdout, 'heddle tools --json'), tools, 'and stdout is that document alone')
  } finally {
    removeDir(h.home)
  }
})

test('a --turn that calls get_goal gets the tool, not an unknown-tool refusal', async (context) => {
  if (!skipUnless(context, await supportsCatalog(), CAPABILITY)) return
  /**
   * The `write_file` step is there for the last assertion: a tool that logs (`turn: wrote …`) is the path by which a
   * turn's own run, not only the boot, reached stdout. The sandbox root is the fixture, so the file lands there.
   */
  const h = shippedProfileHarness('turn', [
    { toolCall: { name: 'get_goal', arguments: {} } },
    { toolCall: { name: 'write_file', arguments: { path: 'goal-note.txt', content: 'checked' } } },
    { text: 'checked the goal' },
  ])
  try {
    const run = await runCli([...h.roots, '--turn', 'what is the goal?', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the scripted turn ran\n${run.stdout}${run.stderr}`)
    const report = parseJson(run.stdout)
    assert.ok(report !== null, `the turn printed a report\n${run.stdout}`)

    const refusals = (report.denials ?? []).filter((denial) => denial.tool === 'get_goal')
    assert.deepEqual(refusals, [], `get_goal was not refused\n${JSON.stringify(report.denials)}`)
    const call = (report.toolCalls ?? []).find((entry) => entry.name === 'get_goal')
    assert.ok(call !== undefined, `the model's get_goal call is in the report\n${JSON.stringify(report.toolCalls)}`)
    assert.equal(call.ok, true, `get_goal answered without an error\n${JSON.stringify(report.toolCalls)}`)

    // The answer the model read, from the session's own log: a real goal answer, not a registry refusal.
    const events = readTranscript(report.transcript)
    const answers = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(answers.length > 0, 'the tool result was recorded')
    assert.doesNotMatch(answers.join('\n'), /UNKNOWN_TOOL|no tool named/, `the model read a goal answer\n${answers.join('\n')}`)

    // The turn's own --json stdout is held to the same rule as the commands': the document alone.
    wholeJson(run.stdout, 'heddle --turn … --json')
  } finally {
    removeDir(h.home)
  }
})
