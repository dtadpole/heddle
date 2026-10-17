import assert from 'node:assert/strict'
import { test } from 'node:test'

import { catalogOf, schemaFor } from '../src/server/tool-catalog.ts'
import type { ToolSpec } from '../src/llm/types.ts'

/**
 * The tool catalog the Trajectory details pane shows.
 *
 * The view asks by name, so the shaping has two jobs that are easy to get silently wrong: a name must be
 * found regardless of the order the profile registered tools in, and a name registered twice must not
 * become two rows a reader has to choose between.
 */

const spec = (name: string, description = `${name} does things`): ToolSpec => ({ name, description, parameters: { type: 'object' } })

test('the catalog is sorted by name, so a lookup reads like a list', () => {
  const catalog = catalogOf([spec('write_file'), spec('bash'), spec('list_dir')])
  assert.deepEqual(
    catalog.map((tool) => tool.name),
    ['bash', 'list_dir', 'write_file'],
  )
})

test('a name registered twice keeps the first definition, which is what the model was offered', () => {
  const catalog = catalogOf([spec('bash', 'first'), spec('bash', 'second')])
  assert.equal(catalog.length, 1)
  assert.equal(schemaFor(catalog, 'bash')?.description, 'first')
})

test('a missing parameter schema is an empty object rather than undefined', () => {
  const catalog = catalogOf([{ name: 'bare', description: 'no parameters' } as ToolSpec])
  assert.deepEqual(catalog[0]?.parameters, {})
})

test('a lookup by name answers the definition, and misses cleanly', () => {
  const catalog = catalogOf([spec('bash'), spec('list_dir')])
  assert.equal(schemaFor(catalog, 'list_dir')?.name, 'list_dir')
  assert.equal(schemaFor(catalog, 'write_file'), undefined, 'a tool the profile does not offer has no schema')
})
