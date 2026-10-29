import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Tool arguments are checked as DSH checks them (R-developer-five-6, coordinator ruling (a)).
 *
 * DSH's `defineTool` validates a call's arguments against the declared parameters before the tool runs: a wrong
 * type, a missing required property or a value outside an enum is an `INVALID_ARGS` result in DSH's words
 * (`invalid arguments: <violations>`), and the turn goes on. Its roots are **open** — compiled with no
 * `additionalProperties` — so an unknown top-level argument is accepted, and the schema the model receives says so.
 *
 * Two claims, each failing on its own if the gate were wrong: a scripted turn's wrong-typed call is refused before
 * the tool acts while an extra top-level key reaches the tool; and the tool schemas a real model request carries
 * have open roots.
 */

const CAPABILITY = 'a turn with tools'
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')

test('a call that breaks its schema is refused INVALID_ARGS before the tool acts; an extra top-level key passes', async (context) => {
  if (!skipUnless(context, /--turn/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('argument-validation')
  const work = fixtureDir('argument-validation-work')
  const root = join(home, 'sessions')
  try {
    const { config } = scriptedConfig({
      home,
      steps: [
        { toolCall: { name: 'write_file', arguments: { path: 7, content: 'x' } } },
        { toolCall: { name: 'write_file', arguments: { path: 'extra.txt', content: 'x', run_in_background: true } } },
        { text: 'done' },
      ],
    })
    const run = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', root, '--turn', 'write twice'], {
      env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
      cwd: work,
    })
    /**
     * The turn goes on after the refusal and ends with its own answer. The CLI's exit status is not the claim: every
     * refused call is one of the turn's denials, which the one-shot CLI reports with status 1, as it does for a tool
     * that fails.
     */
    assert.match(run.stdout, /^done$/m, `the turn went on and answered\n${run.stdout}${run.stderr}`)
    const [session] = sessionsUnder(root)
    const results = readTranscript(join(root, session)).filter((event) => event.type === 'message' && event.message?.role === 'tool').map(textOf)
    assert.equal(results.length, 2, `two tool results\n${results.join('\n')}`)
    assert.match(results[0], /INVALID_ARGS/, `the wrong type is refused by code\n${results[0]}`)
    assert.match(results[0], /invalid arguments: "path" must be a string/, 'in DSH’s words')
    assert.equal(existsSync(join(work, '7')), false, 'and the tool never wrote')
    assert.doesNotMatch(results[1], /INVALID_ARGS|error/i, `an unknown top-level key is accepted\n${results[1]}`)
    assert.equal(existsSync(join(work, 'extra.txt')), true, 'and the tool ran')
  } finally {
    removeDir(home)
    removeDir(work)
  }
})

test('the tool schemas a model request carries have open roots, as DSH compiles them', async (context) => {
  if (!skipUnless(context, /--turn/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('argument-validation-wire')
  const work = fixtureDir('argument-validation-wire-work')
  const double = await chatDouble({ content: 'ok' })
  try {
    const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
    const run = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions'), '--turn', 'hello'], {
      env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
      cwd: work,
    })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const parse = (text) => {
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    }
    const body = double.requests.map((entry) => parse(entry.body)).find((value) => Array.isArray(value?.tools))
    assert.ok(body !== undefined, 'the request carried tools')
    const closed = body.tools
      .map((tool) => tool.function ?? tool)
      .filter((fn) => fn.parameters !== undefined && Object.hasOwn(fn.parameters, 'additionalProperties'))
      .map((fn) => fn.name)
    assert.ok(body.tools.length > 0)
    assert.deepEqual(closed, [], 'no tool root is closed')
  } finally {
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})
