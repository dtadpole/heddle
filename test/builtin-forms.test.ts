import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import Schema from '@deepseek-ai/schemastery'

import { FORMS_FILE } from '../src/config/builtin-forms.ts'
import { normalizeProjection, type SerializedSchema } from '../src/config/form-projection.ts'

/**
 * The settings view's schema descriptor (issue #123): deterministic uids, and the Rust build's embedded copy generated
 * from these very schemas.
 */

test('the same schema serializes to the same normalized projection however many schemas came before it', () => {
  const make = () =>
    Schema.object({
      mode: Schema.union(['allow', 'deny']).default('allow'),
      limit: Schema.number().step(1).min(1).default(10),
      tags: Schema.array(Schema.string()).default([]),
    })
  Schema.string()
  Schema.number()
  const first = normalizeProjection(make().toJSON() as unknown as SerializedSchema)
  Schema.boolean()
  const second = normalizeProjection(make().toJSON() as unknown as SerializedSchema)
  assert.deepEqual(second, first)
  assert.equal(first.uid, Object.keys(first.refs).length, 'the root is the last node, as Schemastery numbers it')
  assert.deepEqual(Object.keys(first.refs), Object.keys(first.refs).map((_, index) => String(index + 1)), 'uids run 1..n in order')
  const root = first.refs[String(first.uid)] as { dict: Record<string, number> }
  assert.deepEqual(first.refs[String(root.dict.limit)], { type: 'number', meta: { step: 1, min: 1, default: 10 } })
})

test('the Rust build\'s embedded projections are exactly what the TypeScript schemas generate', () => {
  const repo = join(import.meta.dirname, '..')
  const generated = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { builtinForms, formsText } from ${JSON.stringify(join(repo, 'src/config/builtin-forms.ts'))}; process.stdout.write(formsText(await builtinForms()))`],
    { encoding: 'utf8', env: { ...process.env, HEDDLE_HOME: '$HEDDLE_HOME' }, cwd: repo },
  )
  assert.equal(generated.status, 0, generated.stderr)
  assert.equal(
    readFileSync(FORMS_FILE, 'utf8'),
    generated.stdout,
    "rust/crates/heddle-config/src/builtin_forms.json is stale: run HEDDLE_HOME='$HEDDLE_HOME' node src/config/builtin-forms.ts --write",
  )
})
