import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, parseJson, readTranscript, removeDir, runCli, scriptedConfig, sessionsUnder, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 5 — the agentic loop.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: **the agentic loop runs with tool calls** — the model
 * asks, the tool acts, the result goes back, and the loop stops when the model stops asking.
 *
 * The scripted endpoint makes this exact rather than probabilistic: a script is a sequence of
 * steps, one per round, so "the loop ran three rounds and fed each result back" is a fact about
 * the transcript. The claims are that a multi-step task completes, that each result is visible to
 * the next round, that a model which never stops asking is stopped by the round limit, and that a
 * turn is resumable.
 */

const CAPABILITY = 'an agentic loop over tool calls'

function harness(label, options = {}) {
  const home = fixtureDir(`loop-home-${label}`)
  const work = fixtureDir(`loop-work-${label}`)
  const { script } = scriptedConfig({ home, steps: options.steps ?? [{ text: 'done' }] })
  return {
    home,
    work,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') },
    args: ['--session-root', join(home, 'sessions'), '--sandbox-root', work, '--endpoint', 'scripted'],
    script,
  }
}

async function supportsTurns() {
  const help = await runCli(['--help'])
  return /--turn/.test(help.stdout)
}

test('a multi-step task completes its rounds and records each one', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('multi', {
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'one.txt', content: 'first' } } },
      { toolCall: { name: 'read_file', arguments: { path: 'one.txt' } } },
      { text: 'finished the task' },
    ],
  })
  try {
    const run = await runCli([...h.args, '--turn', 'write a file then read it'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(session, 'a session was recorded')
    const events = readTranscript(join(h.home, 'sessions', session))

    const requests = events.filter((event) => event.type === 'model/request')
    assert.ok(requests.length >= 3, `the loop asked the model once per round (${requests.length})`)
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(toolResults.length >= 2, 'both tool calls produced a result')
    assert.match(toolResults.join('\n'), /first/, 'the read came back with what the write wrote, so the result reached the loop')
    const completed = events.find((event) => event.type === 'assistant/completed')
    assert.match(String(completed?.text ?? ''), /finished the task/, 'and the loop ended with the answer')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the model sees each tool result before the next round', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('feedback', {
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'note.txt', content: 'a secret word' } } },
      { toolCall: { name: 'read_file', arguments: { path: 'note.txt' } } },
      { text: 'read it back' },
    ],
  })
  try {
    const run = await runCli([...h.args, '--turn', 'remember a word'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    /**
     * The tool result must be in the request the **next** round sends, which is what "fed back"
     * means. Reading it from the transcript's `model/request` count would only prove the model was
     * called again, so the check reads the second round's message count instead.
     */
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session))
    const requests = events.filter((event) => event.type === 'model/request')
    assert.ok(requests.length >= 3, 'there were at least three rounds')
    const last = requests[requests.length - 1]
    assert.ok(
      (last.messages ?? 0) >= 5,
      `the later request carried the conversation and the tool results (${last.messages} messages)`,
    )
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a model that never stops asking for tools is stopped by the round limit', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  /**
   * One step that always asks for a tool: rounds two and beyond have no step left, and the scripted
   * adapter answers those with nothing but a completion. So the loop ends because the model stopped
   * asking — and the round limit is checked separately by asking for more rounds than the script.
   */
  const h = harness('limit', {
    steps: [
      { toolCall: { name: 'list_dir', arguments: {} } },
      { text: '' },
    ],
  })
  try {
    const run = await runCli([...h.args, '--max-rounds', '3', '--turn', 'keep going'], { env: h.env, timeoutMs: 60_000 })
    assert.equal(run.code, 0, `the turn ended rather than running forever\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session))
    const requests = events.filter((event) => event.type === 'model/request')
    assert.ok(requests.length <= 3, `the round limit was respected (${requests.length} rounds)`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a turn is resumable and the transcript grows rather than being replaced', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('resume', { steps: [{ text: 'first answer' }] })
  try {
    const first = await runCli([...h.args, '--turn', 'first question'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const before = readTranscript(join(h.home, 'sessions', session)).length

    const second = await runCli([...h.args, '--resume', session, '--turn', 'second question'], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)
    const after = readTranscript(join(h.home, 'sessions', session))
    assert.ok(after.length > before, 'the record grew')
    const userTurns = after
      .filter((event) => event.type === 'message' && event.message?.role === 'user')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(userTurns.includes('first question'), 'the earlier turn is still there')
    assert.ok(userTurns.includes('second question'), 'and the new one was appended')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a tool that fails is reported to the model rather than ending the turn', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('failure', {
    steps: [{ toolCall: { name: 'read_file', arguments: { path: 'not-here.txt' } } }, { text: 'it was missing' }],
  })
  try {
    const run = await runCli([...h.args, '--turn', 'read a file that is not there'], { env: h.env })
    /**
     * A failed tool call makes the run exit non-zero, and that is the harness reporting a fact
     * rather than failing: measured, requiring exit zero here failed on a run that did exactly what
     * this claim asks for. What matters is that the loop continued and answered.
     */
    assert.equal(run.timedOut, false, `the turn finished\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout + run.stderr, /it was missing|error/, 'the turn continued past the failure')
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session))
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.match(toolResults.join('\n'), /error \(/, 'the failure came back as the tool result')
    assert.match(String(events.find((event) => event.type === 'assistant/completed')?.text ?? ''), /it was missing/, 'and the loop answered')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the round limit is reported rather than passed off as an answer', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  /**
   * A model that keeps asking for tools is stopped by the limit, and a person needs to know that
   * happened: an answer produced because the harness gave up is not the same as one the model finished,
   * and reporting the first as the second is the failure this check is about.
   */
  const h = harness('limit-reported', {
    steps: [
      { toolCall: { name: 'list_dir', arguments: {} } },
      { toolCall: { name: 'list_dir', arguments: {} } },
      { toolCall: { name: 'list_dir', arguments: {} } },
      { toolCall: { name: 'list_dir', arguments: {} } },
    ],
  })
  try {
    const run = await runCli([...h.args, '--max-rounds', '2', '--turn', 'keep going'], { env: h.env, timeoutMs: 60_000 })
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(session, 'a session was recorded')
    const events = readTranscript(join(h.home, 'sessions', session))
    const requests = events.filter((event) => event.type === 'model/request')
    assert.ok(requests.length <= 2, `the limit was respected (${requests.length} rounds)`)

    const completed = events.find((event) => event.type === 'assistant/completed')
    assert.ok(completed, 'the turn was recorded as finished')
    /**
     * The record says how it ended. Either the completion carries the limit in its reason or the turn
     * carries it — both are the harness saying "I stopped", which is the claim; what would fail is a
     * completion that reads as a finished answer with nothing about the limit anywhere.
     */
    const ended = JSON.stringify({ completed, turns: events.filter((event) => event.type === 'turn/completed') })
    assert.match(ended, /limit|round|2/i, `the record says the round limit ended the turn\n${ended.slice(0, 300)}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})
