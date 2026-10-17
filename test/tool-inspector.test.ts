import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inspectTool, renderPayload } from '../src/server/tool-inspector.ts'
import { catalogOf } from '../src/server/tool-catalog.ts'

/**
 * The tool inspector's three blocks.
 *
 * Two properties matter more than the styling: arguments are shown **as JSON only when they parse**, and
 * every byte of a payload or result is escaped — the strings come from a model, not from this project.
 */

test('valid JSON arguments are rendered as highlighted JSON, without a line gutter', () => {
  const rendered = renderPayload('{"path": "/tmp", "limit": 10}')
  assert.equal(rendered.isJson, true)
  assert.match(rendered.html, /hljs-/)
  assert.ok(!rendered.html.includes('class="ln"'), 'an inspector block needs no line numbers')
  assert.match(rendered.html, /&quot;path&quot;/, 'and the keys are still escaped text')
})

test('arguments that are not JSON are shown as escaped text', () => {
  const rendered = renderPayload('{"path": <script>alert(1)</script>')
  assert.equal(rendered.isJson, false)
  assert.ok(!rendered.html.includes('<script'), 'a payload cannot become markup')
  assert.match(rendered.html, /&lt;script&gt;/, 'and it is visible as text')
})

test('an error result is marked so the pane can tint it', () => {
  const inspection = inspectTool({ payload: '{}', result: 'error: exit 1', error: true }, [])
  assert.equal(inspection.resultIsError, true)
  assert.match(inspection.result, /tr-error-text/)
  assert.match(inspection.result, /error: exit 1/)
})

test('a tool the profile declares carries its schema, and an unknown one does not', () => {
  const catalog = catalogOf([{ name: 'bash', description: 'run a shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }])
  const known = inspectTool({ payload: '{"command":"pwd"}', result: 'ok', name: 'bash' }, catalog)
  assert.equal(known.schema?.name, 'bash')
  assert.equal(known.schema?.description, 'run a shell')
  assert.match(known.schema?.parameters ?? '', /hljs-/)
  assert.match(known.schema?.parameters ?? '', /command/)
  const unknown = inspectTool({ payload: '{}', result: 'ok', name: 'nope' }, catalog)
  assert.equal(unknown.schema, undefined)
})
