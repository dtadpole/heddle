import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Multiple agents: a parent delegates a task to a child agent that works in its own session, **without waiting
 * for it**, and the child reports back by notice when it settles — DSH's background subagent.
 *
 * Three claims, each of which fails on its own if the delegation is wrong:
 *
 * - the child is a **separate session** with its parent, origin and depth in the metadata, and its conversation
 *   stays out of the parent's transcript;
 * - the delegation **returns at once**: the parent's tool result is DSH's `started subagent <id>`, recorded before
 *   the child has finished, never the child's answer;
 * - the child's closing message **reaches the parent** as a user-role settlement notice (`subagent-settled`,
 *   DSH's wording), and the parent answers it — in a new turn when it had gone idle, or in its running turn
 *   when it was still working (DSH's steering).
 *
 * Driven through the CLI with a scripted model, so no network and no key. The parent, the child and a turn a
 * notice starts each get their own script through the request `purpose` (`turn`, `subagent`,
 * `subagent-notice`); the one-shot CLI must wait for the child and print the answer of the last turn.
 */

const CAPABILITY = 'a turn with tools'

function supportsTurn(help) {
  return /--turn/.test(help)
}

/** The metadata file a session has, asked for by root and id whatever layout the store used. */
function metaOf(root, id) {
  return JSON.parse(readFileSync(join(dirname(transcriptFile(join(root, id))), `${id}.json`), 'utf8'))
}

const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('\n')
const at = (event) => Date.parse(event.at)

/** Run one parent turn through the CLI with the given scripts, and read both sessions back. */
async function delegateRun(label, steps) {
  const home = isolatedHome(label)
  const work = fixtureDir(`${label}-work`)
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps })
  const run = await runCli(
    ['--config', join(repoRoot, 'cordis.yml'), '--session-root', root, '--turn', 'parent prompt'],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  const ids = sessionsUnder(root)
  const transcripts = new Map(ids.map((id) => [id, readTranscript(join(root, id))]))
  const parentId = ids.find((id) => transcripts.get(id).some((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event) === 'parent prompt'))
  const childId = ids.find((id) => id !== parentId)
  return {
    run,
    ids,
    root,
    parentId,
    childId,
    parentEvents: parentId === undefined ? [] : transcripts.get(parentId),
    childEvents: childId === undefined ? [] : transcripts.get(childId),
    cleanup: () => {
      removeDir(home)
      removeDir(work)
    },
  }
}

/** The settlement notices in a session's log. */
const noticesIn = (events) => events.filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'subagent-settled')

test('a delegation returns at once, and the child’s answer reaches the parent by notice when it settles', async (context) => {
  if (!skipUnless(context, supportsTurn((await runCli(['--help'])).stdout), CAPABILITY)) return
  const result = await delegateRun('subagent', [
    { toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } },
    { text: 'parent started the child' },
    { purpose: 'subagent', toolCall: { name: 'bash', arguments: { command: 'sleep 1; echo child-worked' } } },
    { purpose: 'subagent', text: 'child answer' },
    { purpose: 'subagent-notice', text: 'parent read the notice' },
  ])
  const { run, ids, root, parentId, childId, parentEvents, childEvents } = result
  try {
    assert.equal(run.code, 0, `the parent turn ran\n${run.stdout}${run.stderr}`)
    assert.equal(ids.length, 2, `the delegation made exactly one child session\nsaw: ${ids.join(', ')}`)
    assert.ok(parentId !== undefined && childId !== undefined, 'the parent session is the one with the original prompt')

    // Attribution: the child is a session of its own, and its metadata says whose child it is.
    const childMeta = metaOf(root, childId)
    assert.equal(childMeta.parentSession, parentId, 'the child names its parent session')
    assert.equal(childMeta.origin, 'subagent', 'and says how it came to exist')
    assert.equal(childMeta.delegationDepth, 1, 'and how deep the chain is')
    assert.ok(childEvents.some((event) => event.type === 'message' && event.message?.role === 'user' && textOf(event) === 'child task'), 'the child got the delegated prompt')

    // The delegation returned at once: DSH's start line, recorded before the child finished.
    const toolResults = parentEvents.filter((event) => event.type === 'message' && event.message?.role === 'tool')
    assert.equal(toolResults.length, 1, 'the delegation is one tool result in the parent')
    assert.equal(textOf(toolResults[0]), `started subagent ${childId}`, 'the result is DSH’s start line, not the child’s answer')
    const childDone = childEvents.find((event) => event.type === 'turn/completed')
    assert.ok(childDone !== undefined, 'the child finished its turn')
    assert.ok(at(toolResults[0]) < at(childDone), 'the parent had its result before the child finished')
    const parentFirstDone = parentEvents.find((event) => event.type === 'turn/completed')
    assert.ok(parentFirstDone !== undefined && at(parentFirstDone) < at(childDone), 'and ended its own turn without waiting for the child')

    // The child reported back: one settlement notice, DSH's wording, then a parent turn that answered it.
    const notices = noticesIn(parentEvents)
    assert.equal(notices.length, 1, 'the parent received one settlement notice')
    assert.equal(notices[0].message.source.senderSessionId, childId, 'from its child')
    assert.equal(
      textOf(notices[0]),
      [`Background subagent ${childId} finished. It cannot receive follow-up messages.`, 'Its closing message:', 'child answer'].join('\n'),
      'carrying the child’s closing message in DSH’s words',
    )
    const noticeIndex = parentEvents.indexOf(notices[0])
    assert.ok(parentEvents.slice(noticeIndex + 1).some((event) => event.type === 'model/request'), 'the parent answered the notice')
    assert.match(run.stdout, /parent read the notice/, 'and the one-shot CLI waited for it and printed that answer')
    assert.equal(
      parentEvents.filter((event) => event.type === 'message' && textOf(event).includes('child task')).length,
      0,
      'the child’s prompt is not in the parent’s transcript: the delegation is a boundary',
    )
  } finally {
    result.cleanup()
  }
})

test('a child that settles while its parent is still working is answered inside the parent’s running turn', async (context) => {
  if (!skipUnless(context, supportsTurn((await runCli(['--help'])).stdout), CAPABILITY)) return
  const result = await delegateRun('subagent-steer', [
    { toolCall: { name: 'delegate', arguments: { prompt: 'quick task' } } },
    { toolCall: { name: 'bash', arguments: { command: 'sleep 2; echo parent-worked' } } },
    { text: 'parent saw the notice mid-turn' },
    { purpose: 'subagent', text: 'quick answer' },
    { purpose: 'subagent-notice', text: 'a separate turn answered the notice' },
  ])
  const { run, childId, parentEvents } = result
  try {
    assert.equal(run.code, 0, `the parent turn ran\n${run.stdout}${run.stderr}`)
    assert.ok(childId !== undefined, 'a child session exists')
    const notices = noticesIn(parentEvents)
    assert.equal(notices.length, 1, 'the parent received one settlement notice')
    assert.match(textOf(notices[0]), /quick answer/)
    const turnsDone = parentEvents.filter((event) => event.type === 'turn/completed')
    assert.equal(turnsDone.length, 1, 'no second turn was needed: the running turn took the notice in')
    const noticeIndex = parentEvents.indexOf(notices[0])
    const doneIndex = parentEvents.indexOf(turnsDone[0])
    assert.ok(noticeIndex < doneIndex, 'the notice arrived while the turn was running')
    assert.ok(parentEvents.slice(noticeIndex, doneIndex).some((event) => event.type === 'model/request'), 'and that turn answered it')
    assert.match(run.stdout, /parent saw the notice mid-turn/)
  } finally {
    result.cleanup()
  }
})
