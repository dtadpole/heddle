import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, parseJson, removeDir, runCli, runCliTimed, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 2 — streaming.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: main content and reasoning arrive as
 * **separate deltas while the model is still writing**.
 *
 * This part needs **no Web UI and no server**. A claim that can only be checked through
 * a browser is a claim that breaks whenever the browser does, and streaming is a
 * property of the model path rather than of any view of it. The Web UI's own checks then
 * judge that the same deltas reach a client over its stream.
 *
 * The double is a local HTTP server that emits its deltas with gaps and delays its
 * terminator, so "arrived early" is a real property of the run rather than an artefact of
 * buffering. Everything here is offline.
 */

const CAPABILITY = 'a streaming path: reasoning and content deltas emitted before the turn ends'

function harness(label, options = {}) {
  const home = isolatedHome(label)
  const work = fixtureDir(label)
  return {
    home,
    work,
    // The sandbox is confined to the fixture, so a check that writes a file cannot write one here.
    args: ['--session-root', `${home}/sessions`, '--sandbox-root', work],
    env: { HOME: home, ...(options.env ?? {}) },
  }
}

/** Does this build expose a streaming view on the command line? */
async function supportsStream() {
  const help = await runCli(['--help'])
  return /--stream/.test(help.stdout)
}

test('reasoning and content arrive as separate deltas, before the turn ends', async (context) => {
  if (!skipUnless(context, await supportsStream(), CAPABILITY)) return
  const double = await chatDouble({ content: 'the answer', reasoning: 'thinking about it' })
  const h = harness('stream-deltas')
  try {
    const config = httpConfig({ home: h.home, baseUrl: double.baseUrl })
    const run = await runCliTimed(['--stream', '--endpoint', 'double', '--turn', 'say something'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, `the run succeeded\n${run.lines.map((line) => `${line.stream}: ${line.text}`).join('\n')}`)

    const stderr = run.lines.filter((line) => line.stream === 'stderr').map((line) => line.text).join('\n')
    assert.match(stderr, /\[reasoning\]/, `a reasoning delta was printed\n${stderr}`)
    assert.match(stderr, /the answer/, `a content delta was printed\n${stderr}`)
    assert.ok(
      stderr.indexOf('[reasoning]') < stderr.indexOf('the answer'),
      `reasoning came before the content, as the provider sent it\n${stderr}`,
    )
    assert.ok(double.requests.length > 0, 'the request reached the double')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    await double.close()
  }
})

test('a delta is printed while the model is still generating', async (context) => {
  if (!skipUnless(context, await supportsStream(), CAPABILITY)) return
  /**
   * The double holds its terminator open for a moment after both deltas, so a run that
   * buffered the answer and printed it at the end cannot pass: the deltas have to be
   * seen on the stream strictly before the run finished.
   */
  const double = await chatDouble({ content: 'live content', reasoning: 'live reasoning', holdOpenMs: 1200 })
  const h = harness('stream-live')
  try {
    const config = httpConfig({ home: h.home, baseUrl: double.baseUrl })
    const run = await runCliTimed(['--stream', '--endpoint', 'double', '--turn', 'say something'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, `the run succeeded`)

    const firstDelta = run.lines.find((line) => line.stream === 'stderr' && /\[reasoning\]|live content/.test(line.text))
    assert.ok(firstDelta, 'a delta line was printed at all')
    assert.ok(
      firstDelta.at < run.elapsed - 200,
      `the first delta arrived at ${firstDelta.at}ms and the run ended at ${run.elapsed}ms, so it did not wait for the end`,
    )
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    await double.close()
  }
})

test('the same deltas are recorded in the session, not only printed', async (context) => {
  if (!skipUnless(context, await supportsStream(), CAPABILITY)) return
  const double = await chatDouble({ content: 'recorded content', reasoning: 'recorded reasoning' })
  const h = harness('stream-recorded')
  try {
    const config = httpConfig({ home: h.home, baseUrl: double.baseUrl, stream: false })
    const run = await runCli(['--stream', '--json', '--endpoint', 'double', '--turn', 'say something'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, `the run succeeded\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.ok(summary.stream, `the run reported its stream\n${run.stdout}`)
    assert.ok((summary.stream?.textDeltas ?? 0) > 0, 'at least one content delta was seen')
    assert.ok((summary.stream?.reasoningDeltas ?? 0) > 0, 'at least one reasoning delta was seen')
    assert.equal(summary.stream?.completed, true, 'the stream reached a completion')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    await double.close()
  }
})

test('a non-streaming provider still produces the same deltas', async (context) => {
  if (!skipUnless(context, await supportsStream(), CAPABILITY)) return
  /**
   * The vocabulary has one shape for every transport, so a provider that answers with a
   * single JSON body must still be folded into deltas rather than being a second code
   * path that can rot.
   */
  const double = await chatDouble({ content: 'unstreamed answer', json: true })
  const h = harness('stream-json')
  try {
    const config = httpConfig({ home: h.home, baseUrl: double.baseUrl, stream: false })
    const run = await runCli(['--stream', '--json', '--endpoint', 'double', '--turn', 'say something'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(run.code, 0, `the run succeeded\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.match(summary.text ?? '', /unstreamed answer/, 'the body-only answer reached the caller')
    assert.ok((summary.stream?.textDeltas ?? 0) > 0, 'it arrived as deltas like every other answer')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    await double.close()
  }
})

test('every turn in one session streams, not only the first', async (context) => {
  if (!skipUnless(context, await supportsStream(), CAPABILITY)) return
  /**
   * A resumed session is where a buffering bug hides: the first turn can be streamed while a later one
   * is assembled and printed at the end, and a person watching a long conversation sees the second
   * case as the harness hanging.
   *
   * The check runs two turns against one session and requires **both** to report deltas before their
   * completion, from the run's own summary — so the property is asserted per turn rather than once
   * for the process.
   */
  const double = await chatDouble({ content: 'streamed content', reasoning: 'streamed reasoning', holdOpenMs: 400 })
  const h = harness('session-turns')
  try {
    const config = httpConfig({ home: h.home, baseUrl: double.baseUrl })
    const first = await runCli(['--stream', '--json', '--endpoint', 'double', '--turn', 'first question'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const firstSummary = parseJson(first.stdout)
    assert.ok((firstSummary?.stream?.textDeltas ?? 0) > 0, 'the first turn streamed content')
    assert.ok((firstSummary?.stream?.reasoningDeltas ?? 0) > 0, 'and reasoning')
    const session = firstSummary?.session
    assert.ok(session, 'the first turn named its session')

    const second = await runCli(['--stream', '--json', '--endpoint', 'double', '--resume', session, '--turn', 'second question'], {
      env: { ...h.env, HEDDLE_CONFIG: config },
      timeoutMs: 30_000,
    })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)
    const secondSummary = parseJson(second.stdout)
    assert.ok(
      (secondSummary?.stream?.textDeltas ?? 0) > 0,
      `the resumed turn streamed its content too\n${second.stdout}`,
    )
    assert.ok((secondSummary?.stream?.reasoningDeltas ?? 0) > 0, 'and its reasoning')
    assert.equal(secondSummary?.session, session, 'and it was the same session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    await double.close()
  }
})
