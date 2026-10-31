import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { defaultEndpoints, isShippedFixture, unscriptedFixtureMessage } from '../src/endpoints.ts'
import { scriptedAdapter } from '../src/llm/adapters.ts'
import type { EndpointConfig } from '../src/llm/types.ts'

/**
 * Issue #74: a home that configured nothing runs on the shipped offline fixture, so its missing script was the first
 * message a new user saw. The fixture as shipped now says how to configure a model; any other scripted endpoint keeps
 * naming the file it could not read.
 */

const folder = mkdtempSync(join(tmpdir(), 'heddle-unscripted-fixture-'))
const before = process.cwd()
// The fixture's script path is relative to the working folder; this one has no `scripted.json`.
process.chdir(folder)
after(() => {
  process.chdir(before)
  rmSync(folder, { recursive: true, force: true })
})

const shipped = defaultEndpoints()[0] as EndpointConfig

async function failure(endpoint: EndpointConfig): Promise<{ message: string; code: unknown }> {
  try {
    for await (const _chunk of scriptedAdapter(endpoint as never, { round: 0 } as never)) {
      // A missing script fails before the first chunk.
    }
  } catch (error) {
    return { message: (error as Error).message, code: (error as { code?: unknown }).code }
  }
  throw new Error('the scripted call did not fail')
}

test('only the fixture as shipped is the shipped fixture', () => {
  assert.equal(isShippedFixture(shipped), true)
  assert.equal(isShippedFixture({ ...shipped, baseUrl: '/tmp/steps.json' }), false)
  assert.equal(isShippedFixture({ ...shipped, name: 'double' }), false)
  assert.equal(isShippedFixture({ ...shipped, kind: 'openai-chat' }), false)
})

test('the message names the first machine file a run reads, and the shape to write there', () => {
  const message = unscriptedFixtureMessage(['/etc/heddle.json', '/home/someone/.heddle/heddle.json'])
  assert.ok(message.startsWith("the offline test endpoint 'scripted' has no script at scripted.json. To talk to a model,"), message)
  assert.ok(message.includes('declare one in /etc/heddle.json, for example {"endpoints": [{"name": "mine", "kind": "openai-chat"'), message)
  assert.ok(message.endsWith('"default": "mine"}'), message)
})

test('the shipped fixture without its script says how to configure a model, still as SCRIPT', async () => {
  const { message, code } = await failure(shipped)
  assert.equal(code, 'SCRIPT')
  assert.equal(message, unscriptedFixtureMessage())
})

test('another scripted endpoint without its script keeps naming the file', async () => {
  const { message, code } = await failure({ ...shipped, name: 'double' })
  assert.equal(code, 'SCRIPT')
  assert.equal(message, "the script for 'double' could not be read at scripted.json")
})
