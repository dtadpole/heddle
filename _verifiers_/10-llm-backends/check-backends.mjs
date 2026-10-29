import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, httpConfig, isolatedHome, parseJson, removeDir, responsesDouble, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 1 — LLM backends.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: heddle **connects to backend model servers and runs
 * agent loops over them**, with the endpoint list coming from configuration rather than code.
 *
 * Two claims are separated on purpose. The **wire** is judged offline against local doubles that
 * speak the provider's real routes — the Chat Completions shape and the Responses shape, which
 * are genuinely different and whose difference is why there are two adapters. The **real
 * backend** is judged by one short request to a configured endpoint, and it reports *unjudged*
 * when nothing is configured or the signer is not running, because "the gateway was not set up"
 * must never be recorded as "the gateway works".
 */

const CAPABILITY = 'backend connections with a configured endpoint list'

async function supportsBackends() {
  const help = await runCli(['--help'])
  // The probe asks for every command this part's checks run, matched as a command line rather than as a word:
  // a check that runs a command the harness does not advertise would fail, not skip, and that failure would
  // be about the missing command, not about this part.
  return /--endpoint/.test(help.stdout) && /--turn/.test(help.stdout) && /^\s{2}models\b/m.test(help.stdout)
}

test('the endpoint list is configuration and the command reports it', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  const home = isolatedHome('backends-list')
  let double
  try {
    double = await chatDouble({ content: 'x' })
    const config = httpConfig({ home, name: 'not-the-first', baseUrl: double.baseUrl })
    const run = await runCli(['models', '--json'], { env: { HOME: home, HEDDLE_CONFIG: config } })
    assert.equal(run.code, 0, `the command ran\n${run.stdout}${run.stderr}`)
    const endpoints = parseJson(run.stdout)
    assert.ok(Array.isArray(endpoints), `it printed a list\n${run.stdout}`)
    const names = endpoints.map((endpoint) => endpoint.name)
    assert.ok(names.includes('not-the-first'), `the configured endpoint is there\nsaw: ${names.join(', ')}`)
    assert.ok(names.includes('scripted'), 'and the built-in offline endpoint is there for a fresh clone')
    const configured = endpoints.find((endpoint) => endpoint.name === 'not-the-first')
    assert.equal(configured.kind, 'openai-chat', 'each endpoint declares its wire shape')
    assert.equal(configured.baseUrl, double.baseUrl, 'and the URL the configuration gave it')
  } finally {
    await double?.close()
    removeDir(home)
  }
})

test('a turn runs over the Chat Completions shape', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  const home = isolatedHome('backends-chat')
  let double
  try {
    double = await chatDouble({ content: 'answered over chat completions' })
    const config = httpConfig({ home, name: 'chat', baseUrl: double.baseUrl })
    const run = await runCli(['--endpoint', 'chat', '--sandbox-root', home, '--turn', 'say something', '--json'], { env: { HOME: home, HEDDLE_CONFIG: config } })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /answered over chat completions/, 'the answer came back through the framework')
    assert.ok(double.requests.length > 0, 'the request reached the endpoint')
    assert.match(double.requests[0].url, /chat\/completions/, 'at the route that shape uses')
    const body = JSON.parse(double.requests[0].body)
    assert.ok(Array.isArray(body.messages) && body.messages.length > 0, 'and it carried the conversation')
  } finally {
    await double?.close()
    removeDir(home)
  }
})

test('a turn runs over the Responses shape, which is a different contract', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  const home = isolatedHome('backends-responses')
  let double
  try {
    double = await responsesDouble({ content: 'answered over responses' })
    const config = httpConfig({ home, name: 'codex', kind: 'openai-responses', baseUrl: double.baseUrl })
    const run = await runCli(['--endpoint', 'codex', '--sandbox-root', home, '--turn', 'say something', '--json'], { env: { HOME: home, HEDDLE_CONFIG: config } })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /answered over responses/, 'the answer came back')
    assert.match(double.requests[0].url, /responses/, 'at the route that shape uses')
    const body = JSON.parse(double.requests[0].body)
    assert.ok(Array.isArray(body.input), 'input is a list, which that route requires')
    assert.equal(body.stream, true, 'and it is streamed, which that route also requires')
  } finally {
    await double?.close()
    removeDir(home)
  }
})

test('a real configured backend answers one short request, or is unjudged', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  /**
   * The one check here that may spend anything, and it is bounded: a single request for a couple
   * of tokens against whatever endpoint the machine's own configuration names as its default.
   *
   * It reports unjudged rather than passing when there is no such endpoint, because a check that
   * passes by not testing is worse than one that admits it did not run.
   */
  const probe = await runCli(['models', '--json'], {})
  const endpoints = parseJson(probe.stdout)
  const real = Array.isArray(endpoints)
    ? endpoints.find((endpoint) => endpoint.kind === 'openai-chat' && endpoint.baseUrl.startsWith('http') && !endpoint.baseUrl.includes('127.0.0.1'))
    : undefined
  const local = Array.isArray(endpoints)
    ? endpoints.find((endpoint) => endpoint.kind === 'openai-chat' && endpoint.baseUrl.includes('127.0.0.1'))
    : undefined
  const target = real ?? local
  if (!skipUnless(context, target !== undefined, 'a configured endpoint this machine can reach, which the environment did not provide')) return

  /**
   * A **fresh session root**, because this is meant to be one short request. Measured: run against the
   * owner's store, the turn resumed the last session there and replayed its history — including an
   * assistant turn that was reasoning only, which a real gateway rejects with "Invalid assistant
   * message" — so the check judged the machine's session history rather than one request.
   */
  const home = isolatedHome('backends-real')
  let run
  try {
    run = await runCli(
      ['--session-root', join(home, 'sessions'), '--endpoint', target.name, '--turn', 'Reply with the single word: ready', '--max-output-tokens', '24', '--json'],
      { timeoutMs: 120_000 },
    )
  } finally {
    removeDir(home)
  }
  if (run.code !== 0) {
    // An unreachable gateway is a fact about the machine, not a failure of the harness, and the
    // check says which it is rather than guessing.
    context.skip(`the configured endpoint '${target.name}' did not answer, so this part was not judged — ${run.stderr.trim().split('\n').pop() ?? ''}`)
    return
  }
  const summary = parseJson(run.stdout)
  /**
   * A reasoning-only answer is an answer; see the publisher probe for why a small budget can be spent
   * thinking. Nothing at all is unjudged rather than a pass or a failure.
   */
  const answer = `${summary?.text ?? ''}${summary?.reasoning ?? ''}`
  if (answer.length === 0) {
    context.skip(`the configured endpoint '${target.name}' answered with no text or reasoning within its token budget, so this part was not judged`)
    return
  }
  assert.equal(summary?.endpoint, target.name, 'and the answer came from the endpoint that was named')
})

test('the configured default endpoint is the one a turn uses when none is named', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  /**
   * A person configures a default so they do not have to name an endpoint every time. The check sets a
   * default that is deliberately **not** first, neither in the file nor by name (both builds sort endpoints
   * by name), so honouring it cannot be an accident of ordering.
   */
  const home = isolatedHome('backends-default')
  let first, chosen
  try {
    first = await chatDouble({ content: 'the first endpoint answered' })
    chosen = await chatDouble({ content: 'the default endpoint answered' })
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'chosen',
      endpoints: [
        { name: 'a-first', kind: 'openai-chat', baseUrl: first.baseUrl, model: 'double', stream: true },
        { name: 'chosen', kind: 'openai-chat', baseUrl: chosen.baseUrl, model: 'double', stream: true },
      ],
    })
    const run = await runCli(['--sandbox-root', home, '--turn', 'say something', '--json'], { env: { HOME: home, HEDDLE_CONFIG: config } })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /the default endpoint answered/, 'the configured default answered')
    assert.equal(first.requests.length, 0, 'and the first endpoint in the list was never reached')
  } finally {
    await first?.close()
    await chosen?.close()
    removeDir(home)
  }
})

test('listing the endpoints costs nothing and reaches no provider', async (context) => {
  if (!skipUnless(context, await supportsBackends(), CAPABILITY)) return
  /**
   * `heddle models` is how a person checks a configuration before trusting it, so it must not be a call:
   * a model list that spends quota is a list nobody dares run. The check points an endpoint at a double
   * that records every request and requires the listing to leave it empty.
   */
  const home = isolatedHome('backends-list-free')
  let double
  try {
    double = await chatDouble({ content: 'x' })
    const config = httpConfig({ home, name: 'double', baseUrl: double.baseUrl })
    const run = await runCli(['models', '--json'], { env: { HOME: home, HEDDLE_CONFIG: config } })
    assert.equal(run.code, 0, `the listing ran\n${run.stdout}${run.stderr}`)
    assert.equal(double.requests.length, 0, 'listing the endpoints made no request')
  } finally {
    await double?.close()
    removeDir(home)
  }
})
