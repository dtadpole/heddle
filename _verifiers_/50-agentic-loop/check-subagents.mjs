import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Multiple agents: a parent turn delegates a task to a child agent, the child works in its own session, and its
 * final answer comes back as the parent's tool result.
 *
 * The claim is three-part and each part would fail on its own if the boundary were wrong: the child is a
 * **separate session** with its parent, origin and depth in the metadata; the parent's transcript shows one
 * tool call and the child's answer, never the child's conversation; and the parent's turn **continues** with
 * that answer instead of ending at the delegation.
 *
 * Driven through the CLI with a scripted model, so no network and no key: step 1 is the parent's tool call,
 * step 2 answers the child, step 3 answers the parent after the delegation returns.
 */

const CAPABILITY = 'a turn with tools'

function supportsTurn(help) {
  return /--turn/.test(help)
}

/** The metadata file a session has, asked for by root and id whatever layout the store used. */
function metaOf(root, id) {
  return JSON.parse(readFileSync(join(dirname(transcriptFile(join(root, id))), `${id}.json`), 'utf8'))
}

const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')

test('a parent delegates to a child agent, and the child’s answer returns to the parent', async (context) => {
  if (!skipUnless(context, supportsTurn((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('subagent')
  const work = fixtureDir('subagent-work')
  const root = join(home, 'sessions')
  try {
    const { config } = scriptedConfig({
      home,
      steps: [
        { toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } },
        { text: 'child answer' },
        { text: 'parent done' },
      ],
    })
    const run = await runCli(
      ['--config', join(repoRoot, 'cordis.yml'), '--session-root', root, '--turn', 'parent prompt'],
      { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
    )
    assert.equal(run.code, 0, `the parent turn ran\n${run.stdout}${run.stderr}`)

    const ids = sessionsUnder(root)
    assert.equal(ids.length, 2, `the delegation made exactly one child session\nsaw: ${ids.join(', ')}`)

    const transcripts = new Map(ids.map((id) => [id, readTranscript(join(root, id))]))
    const parentId = ids.find((id) => transcripts.get(id).some((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event) === 'parent prompt'))
    assert.ok(parentId !== undefined, 'the parent session is the one with the original prompt')
    const childId = ids.find((id) => id !== parentId)
    assert.ok(childId !== undefined)

    // Attribution: the child is a session of its own, and its metadata says whose child it is.
    const childMeta = metaOf(root, childId)
    assert.equal(childMeta.parentSession, parentId, 'the child names its parent session')
    assert.equal(childMeta.origin, 'subagent', 'and says how it came to exist')
    assert.equal(childMeta.delegationDepth, 1, 'and how deep the chain is')
    assert.equal(childMeta.cwd, childMeta.cwd, 'and keeps a folder')

    // The child saw the delegated prompt and produced its answer in its own log.
    const childEvents = transcripts.get(childId)
    assert.ok(childEvents.some((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event) === 'child task'), 'the child got the delegated prompt')
    assert.ok(childEvents.some((event) => event.type === 'assistant/chunk' && event.chunk?.type === 'text-delta' && event.chunk.text === 'child answer'), 'and answered it')

    // The parent saw a tool call and its result — not the child's conversation.
    const parentEvents = transcripts.get(parentId)
    const toolResults = parentEvents.filter((event) => event.type === 'message' && event.message?.role === 'tool')
    assert.equal(toolResults.length, 1, 'the delegation is one tool result in the parent')
    assert.match(textOf(toolResults[0]), /child answer/, 'carrying the child’s final answer')
    assert.match(textOf(toolResults[0]), new RegExp(childId), 'and naming the session it came from')
    assert.equal(
      parentEvents.filter((event) => event.type === 'message' && textOf(event).includes('child task')).length,
      0,
      'the child’s prompt is not in the parent’s transcript: the delegation is a boundary',
    )

    /**
     * The parent continued after the delegation: a second model call follows the tool result. The scripted
     * double indexes its steps **per session**, so both the parent and the child replay the script from its
     * start; the claim here is the continuation, not which scripted text happens to be the parent's final
     * answer (the child's own first round therefore also replays the tool call, which the depth/busy limit
     * refuses — a second thing this check exercises without naming it in the script).
     */
    const toolResultIndex = parentEvents.findIndex((event) => event.type === 'message' && event.message?.role === 'tool')
    assert.ok(
      parentEvents.slice(toolResultIndex + 1).some((event) => event.type === 'model/request'),
      'the parent continued with the answer in hand',
    )
  } finally {
    removeDir(home)
    removeDir(work)
  }
})
