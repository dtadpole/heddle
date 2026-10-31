import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ConfigError } from '../src/config/schema.ts'
import { PROFILE_TEMPLATES, resetProfileFromTemplate, templateFiles } from '../src/config/profile-template.ts'

/** DSH's --from-default-profile: a custom profile replaced by a fresh copy of a shipped template. */

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'heddle-profile-template-'))
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  writeFileSync(join(checkout, 'cordis.yml'), '# base\n[]\n')
  writeFileSync(join(checkout, 'heddle.patch.yml'), '- insert:\n    - id: model\n      name: ./src/plugins/model.ts\n    - id: outside\n      name: /opt/tools/x.json\n')
  const env = { HEDDLE_HOME: join(root, 'home'), HOME: root }
  return { root, checkout, env, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('the default template is the checkout tree with absolute row names', () => {
  const s = scratch()
  const files = templateFiles(s.checkout)
  assert.equal(files['cordis.yml'], '# base\n[]\n')
  assert.match(files['heddle.patch.yml'] ?? '', new RegExp(`name: ${s.checkout}/src/plugins/model\\.ts`))
  assert.match(files['heddle.patch.yml'] ?? '', /name: \/opt\/tools\/x\.json/, 'an absolute name is kept')
  assert.deepEqual(PROFILE_TEMPLATES, ['default'])
  s.done()
})

test('a custom profile is replaced by a fresh copy, nothing of the old one kept', () => {
  const s = scratch()
  const dir = join(s.env.HEDDLE_HOME, 'profiles', 'mine')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '- insert:\n    - id: custom\n      name: custom\n')
  writeFileSync(join(dir, 'notes.txt'), 'hand-made')
  const profile = resetProfileFromTemplate('mine', 'default', { checkout: s.checkout, env: s.env })
  assert.equal(profile.name, 'mine')
  assert.deepEqual(readdirSync(dir).sort(), ['cordis.yml', 'heddle.patch.yml'])
  assert.equal(readFileSync(join(dir, 'cordis.yml'), 'utf8'), '# base\n[]\n')
  assert.deepEqual([...profile.layers], ['cordis.yml', 'heddle.patch.yml'])
  assert.deepEqual(readdirSync(join(s.env.HEDDLE_HOME, 'profiles')), ['mine'], 'no staging directory is left behind')
  s.done()
})

test('a new name is created, and an unknown template or a path is refused before anything is written', () => {
  const s = scratch()
  assert.equal(resetProfileFromTemplate('fresh', 'default', { checkout: s.checkout, env: s.env }).name, 'fresh')
  assert.throws(() => resetProfileFromTemplate('other', 'web', { checkout: s.checkout, env: s.env }), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.problems.join(), /unknown profile template 'web'; heddle ships: default/)
    return true
  })
  // The CLI only turns away a directory argument; every other name rests on this rule.
  for (const name of ['../escape', 'a/b', '', '.hidden', '..', '-flag']) {
    assert.throws(() => resetProfileFromTemplate(name, 'default', { checkout: s.checkout, env: s.env }), /plain name/, `'${name}' is not a plain name`)
  }
  assert.equal(existsSync(join(s.env.HEDDLE_HOME, 'profiles', 'a')), false)
  assert.equal(existsSync(join(s.env.HEDDLE_HOME, 'profiles', 'other')), false)
  assert.equal(existsSync(join(s.root, 'escape')), false)
  s.done()
})
