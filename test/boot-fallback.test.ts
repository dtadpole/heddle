import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { bootFallback } from '../src/config/boot-fallback.ts'
import { compose, defaultLayers } from '../src/config/schema.ts'
import { layersBeneathSettings, SETTINGS_BEGIN, SETTINGS_END, settingsTarget } from '../src/config/settings.ts'

/**
 * A row Settings' block broke runs on the value beneath the block, with one note (#213); heddle-config's
 * boot_fallback.rs tests decide the same claims.
 */

const SERVICE = resolve('src/context/service.ts')

function fixture(label: string, patch: string) {
  const root = join(tmpdir(), `heddle-boot-fallback-${process.pid}-${label}`)
  rmSync(root, { recursive: true, force: true })
  const profile = join(root, 'home/profiles/dev')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), `- insert:\n    - id: context\n      name: ${SERVICE}\n      config:\n        contextWindow: 1048576\n`)
  writeFileSync(join(profile, 'heddle.patch.yml'), patch)
  const env = { HEDDLE_HOME: join(root, 'home'), HOME: root }
  const layers = defaultLayers({ profile: 'dev', env })
  const target = settingsTarget({ profile: 'dev' }, layers, env)
  assert.ok(target !== undefined)
  return { root, env, layers, target, done: () => rmSync(root, { recursive: true, force: true }) }
}

const block = (config: string) => `${SETTINGS_BEGIN}\n- patch:\n    - id: "context"\n      config: ${config}\n${SETTINGS_END}\n`

test("a row Settings' block broke runs on the value beneath it, with one note naming the row, the problem and the file", async () => {
  const f = fixture('block', block('{"contextWindow": -5}'))
  try {
    const result = await bootFallback(f.layers, compose(f.layers, f.env), layersBeneathSettings(f.layers, f.target, f.env), f.target.path, f.env)
    assert.deepEqual(result.rows[0]?.row.config, { contextWindow: 1048576 })
    assert.deepEqual(result.notes, [
      `heddle: context: contextWindow (-5) must be a positive integer (in ${f.target.path}); this run uses the value beneath it until Settings saves or resets it`,
    ])
  } finally {
    f.done()
  }
})

test('a refused value outside the block keeps its row and is named; a valid tree says nothing', async () => {
  const outside = fixture('outside', '- patch:\n    - id: context\n      config:\n        contextWindow: -5\n')
  try {
    const result = await bootFallback(outside.layers, compose(outside.layers, outside.env), layersBeneathSettings(outside.layers, outside.target, outside.env), outside.target.path, outside.env)
    assert.deepEqual(result.rows[0]?.row.config, { contextWindow: -5 })
    assert.deepEqual(result.notes, [
      `heddle: context: contextWindow (-5) must be a positive integer (in ${outside.target.path}); fix it in the file or run \`heddle config --validate\``,
    ])
  } finally {
    outside.done()
  }
  const valid = fixture('valid', block('{"contextWindow": 200000}'))
  try {
    const result = await bootFallback(valid.layers, compose(valid.layers, valid.env), layersBeneathSettings(valid.layers, valid.target, valid.env), valid.target.path, valid.env)
    assert.deepEqual(result.rows[0]?.row.config, { contextWindow: 200000 })
    assert.deepEqual(result.notes, [])
  } finally {
    valid.done()
  }
})

test('the running row with the config from beneath must pass, and its config provenance follows the fallback', async () => {
  // developer-two's case: beneath, the row is disabled with a bad value; a hand-edited block enables it with another.
  const root = join(tmpdir(), `heddle-boot-fallback-${process.pid}-disabled`)
  rmSync(root, { recursive: true, force: true })
  const profile = join(root, 'home/profiles/dev')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), `- insert:\n    - id: context\n      name: ${SERVICE}\n      disabled: true\n      config:\n        contextWindow: -7\n`)
  writeFileSync(join(profile, 'heddle.patch.yml'), `${SETTINGS_BEGIN}\n- patch:\n    - id: "context"\n      disabled: false\n      config: {"contextWindow": -5}\n${SETTINGS_END}\n`)
  const env = { HEDDLE_HOME: join(root, 'home'), HOME: root }
  try {
    const layers = defaultLayers({ profile: 'dev', env })
    const target = settingsTarget({ profile: 'dev' }, layers, env)
    assert.ok(target !== undefined)
    const rows = compose(layers, env)
    assert.equal(rows[0]?.row.disabled, false, 'the block enables the row')
    const result = await bootFallback(layers, rows, layersBeneathSettings(layers, target, env), target.path, env)
    assert.deepEqual(result.rows[0]?.row.config, { contextWindow: -5 }, 'nothing falls back')
    assert.ok(result.notes[0]?.endsWith('fix it in the file or run `heddle config --validate`'), result.notes[0])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const f = fixture('provenance', block('{"contextWindow": -5}'))
  try {
    const result = await bootFallback(f.layers, compose(f.layers, f.env), layersBeneathSettings(f.layers, f.target, f.env), f.target.path, f.env)
    const files = (result.rows[0]?.fields ?? []).filter((field) => field.field.startsWith('config')).map((field) => field.file)
    assert.deepEqual([...new Set(files)], [join(f.root, 'home/profiles/dev/cordis.yml')], 'the config is reported from the layer it now comes from')
  } finally {
    f.done()
  }
})
