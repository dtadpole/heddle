import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, parseJson, removeDir, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 0 — the configuration system.
 *
 * Judges the layer the whole harness sits on: that a run composes its tree from **named
 * profiles and patch layers**, that a layer may include another, that a value can come
 * from the environment without the value being written into the tree, that a bad row
 * **fails where it is written** naming the row and the field, and that the composition can
 * say which layer supplied every value.
 *
 * Everything is a fixture under `.heddle-tmp/`, and each fixture profile carries its own
 * plugin files, so a check states exactly what a tree is and does not depend on the
 * project's own profile staying the shape it is today. Nothing is started except the
 * plugins the fixture declares, so this part is offline and fast.
 */

const CAPABILITY = 'the configuration system (profiles, includes, environment references, validation, provenance)'

/** A plugin fixture: a service with a schema, so validation has something to check. */
function pluginSource(name) {
  return `import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = '${name}'

export default class ${name[0].toUpperCase()}${name.slice(1)} extends Service {
  static readonly provide = '${name}'
  static readonly Config = Schema.object({
    label: Schema.string().default('none'),
    count: Schema.number().default(0),
  })
  readonly label: string
  readonly count: number
  constructor(ctx: any, config: any = {}) {
    super(ctx, '${name}')
    this.label = config.label ?? 'none'
    this.count = config.count ?? 0
  }
}
`
}

/**
 * The file a row names for a component.
 *
 * The TypeScript build loads a `.ts` plugin. The Rust binary cannot load TypeScript, so under `HEDDLE_BIN` the row
 * names a **component manifest** beside the profile instead — the port's part-0 shape, where a row names a built-in
 * or an outside component rather than a module path. The manifest's `config` is the schema the `.ts` plugin declares,
 * written as JSON Schema, and `--validate` must read it **without starting** the command.
 */
const binaryUnderTest = typeof process.env.HEDDLE_BIN === 'string' && process.env.HEDDLE_BIN.length > 0

/** The row's `name:` for a component: the TypeScript plugin, or the manifest the binary reads. */
const componentFile = (name) => (binaryUnderTest ? `./${name}.component.yml` : `./${name}.ts`)

/** A component manifest: what a row names under `HEDDLE_BIN`, carrying the same schema as the `.ts` plugin. */
function manifestSource(name) {
  return `command: ./${name}.ts
config:
  type: object
  properties:
    label:
      type: string
    count:
      type: number
`
}

/**
 * Write a profile directory and return a home that holds it.
 *
 * The home is returned rather than the directory because every check drives the CLI with
 * `HEDDLE_HOME`, which is what makes "a profile is a name this machine holds" a fact the
 * check can set up rather than one it inherits from the developer's machine.
 */
function profileFixture(label, options) {
  const home = fixtureDir(`config-home-${label}`)
  const dir = join(home, 'profiles', options.profile ?? 'dev')
  mkdirSync(dir, { recursive: true })
  for (const name of ['alpha', 'beta', 'gamma']) {
    writeFileSync(
      join(dir, binaryUnderTest ? `${name}.component.yml` : `${name}.ts`),
      binaryUnderTest ? manifestSource(name) : pluginSource(name),
    )
  }
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'heddle.patch.yml'), options.patch)
  for (const [name, text] of Object.entries(options.extra ?? {})) writeFileSync(join(dir, name), text)
  return { home, dir, env: { HEDDLE_HOME: home } }
}

const BASE_PATCH = `- insert:
    - id: alpha
      name: ${componentFile('alpha')}
      config:
        label: from-profile
    - id: beta
      name: ${componentFile('beta')}
`

async function supportsProfiles() {
  const help = await runCli(['--help'])
  return /--profile/.test(help.stdout)
}

test('a named profile composes the tree a run loads', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('compose', { patch: BASE_PATCH })
  try {
    const result = await runCli(['--profile', 'dev', 'config', '--json'], { env: fixture.env })
    assert.equal(result.code, 0, `the profile booted\n${result.stdout}${result.stderr}`)
    const rows = parseJson(result.stdout)
    assert.ok(Array.isArray(rows), `the command printed rows\n${result.stdout}`)
    assert.deepEqual(
      rows.map((row) => row.id),
      ['alpha', 'beta'],
      'the loaded set is what the profile declares, in order',
    )
  } finally {
    removeDir(fixture.home)
  }
})

test('a later layer restates one row and leaves the rest alone', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('patch', { patch: BASE_PATCH })
  try {
    writeFileSync(
      join(fixture.dir, 'restate.yml'),
      `- patch:
    - id: alpha
      config:
        label: from-the-later-layer
`,
    )
    const result = await runCli(['--profile', 'dev', '--patch', join(fixture.dir, 'restate.yml'), 'config', '--json'], {
      env: fixture.env,
    })
    assert.equal(result.code, 0, `the layered command succeeded\n${result.stdout}${result.stderr}`)
    const rows = parseJson(result.stdout)
    const alpha = rows.find((row) => row.id === 'alpha')
    assert.equal(alpha?.config?.label, 'from-the-later-layer', 'the last write won')
    assert.equal(rows.length, 2, 'no other row was added or removed')
    const beta = rows.find((row) => row.id === 'beta')
    assert.equal(beta?.config, undefined, 'the untouched row kept its shape')
  } finally {
    removeDir(fixture.home)
  }
})

test('a layer includes another layer file', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('include', {
    patch: `- include: ./extra.yml
`,
    extra: {
      'extra.yml': `- insert:
    - id: gamma
      name: ${componentFile('gamma')}
      config:
        label: from-the-included-file
`,
    },
  })
  try {
    const result = await runCli(['--profile', 'dev', 'config', '--json'], { env: fixture.env })
    assert.equal(result.code, 0, `the include composed\n${result.stdout}${result.stderr}`)
    const rows = parseJson(result.stdout)
    assert.deepEqual(rows.map((row) => row.id), ['gamma'], 'the included layer inserted its row')
    assert.equal(rows[0]?.config?.label, 'from-the-included-file', 'the included values arrived')
  } finally {
    removeDir(fixture.home)
  }
})

test('an include cycle is refused by path, not by depth', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('cycle', {
    patch: `- include: ./a.yml
`,
    extra: {
      'a.yml': `- include: ./b.yml
`,
      'b.yml': `- include: ./a.yml
`,
    },
  })
  try {
    const result = await runCli(['--profile', 'dev', 'config'], { env: fixture.env })
    assert.notEqual(result.code, 0, 'a cycle fails')
    assert.match(result.stderr + result.stdout, /cycle/, 'the failure says it is a cycle')
    assert.match(result.stderr + result.stdout, /a\.yml/, 'and names the files in it')
  } finally {
    removeDir(fixture.home)
  }
})

test('a value can come from the environment without being written into the tree', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('env', {
    patch: `- insert:
    - id: alpha
      name: ${componentFile('alpha')}
      config:
        label: \${HEDDLE_FIXTURE_LABEL}
        count: !env HEDDLE_FIXTURE_COUNT
`,
  })
  try {
    const result = await runCli(['--profile', 'dev', 'config', '--json'], {
      env: { ...fixture.env, HEDDLE_FIXTURE_LABEL: 'from-the-environment', HEDDLE_FIXTURE_COUNT: '7' },
    })
    assert.equal(result.code, 0, `the references resolved\n${result.stdout}${result.stderr}`)
    const rows = parseJson(result.stdout)
    assert.equal(rows[0]?.config?.label, 'from-the-environment', 'a ${NAME} inside a string substituted')
    assert.equal(rows[0]?.config?.count, 7, 'a whole-value !env kept its type rather than becoming a string')
  } finally {
    removeDir(fixture.home)
  }
})

test('a missing environment reference fails and names the variable', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('env-missing', {
    patch: `- insert:
    - id: alpha
      name: ${componentFile('alpha')}
      config:
        label: \${HEDDLE_FIXTURE_ABSENT}
`,
  })
  try {
    const result = await runCli(['--profile', 'dev', 'config'], { env: fixture.env })
    assert.notEqual(result.code, 0, 'a missing reference is an error rather than an empty string')
    assert.match(result.stderr + result.stdout, /HEDDLE_FIXTURE_ABSENT/, 'the failure names the variable to set')
  } finally {
    removeDir(fixture.home)
  }
})

test('a bad value fails naming the row and the field', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('validate', {
    patch: `- insert:
    - id: alpha
      name: ${componentFile('alpha')}
      config:
        count: not-a-number
`,
  })
  try {
    const validate = await runCli(['--profile', 'dev', 'config', '--validate'], { env: fixture.env })
    assert.notEqual(validate.code, 0, 'validation fails on the bad value')
    const output = validate.stderr + validate.stdout
    assert.match(output, /alpha/, `the failure names the row\n${output}`)
    assert.match(output, /count/, `the failure names the field\n${output}`)
  } finally {
    removeDir(fixture.home)
  }
})

test('a patch against a row no layer inserted is refused where it is written', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('unknown-patch', {
    patch: `- insert:
    - id: alpha
      name: ${componentFile('alpha')}
- patch:
    - id: nowhere
      config: {}
`,
  })
  try {
    const result = await runCli(['--profile', 'dev', 'config'], { env: fixture.env })
    assert.notEqual(result.code, 0, 'the composition fails')
    assert.match(result.stderr + result.stdout, /nowhere/, 'and names the row it could not find')
  } finally {
    removeDir(fixture.home)
  }
})

test('the composition can say which layer supplied a value', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('origins', { patch: BASE_PATCH })
  try {
    writeFileSync(
      join(fixture.dir, 'restate.yml'),
      `- patch:
    - id: alpha
      config:
        label: from-the-override-layer
`,
    )
    const result = await runCli(
      ['--profile', 'dev', '--patch', join(fixture.dir, 'restate.yml'), 'config', '--origins', '--json'],
      { env: fixture.env },
    )
    assert.equal(result.code, 0, `origins printed\n${result.stdout}${result.stderr}`)
    const rows = parseJson(result.stdout)
    const alpha = rows.find((row) => row.id === 'alpha')
    const labelOrigin = (alpha?.origins ?? []).find((origin) => origin.field === 'config.label')
    assert.ok(labelOrigin, `the value's origin is recorded\n${JSON.stringify(alpha)}`)
    assert.match(labelOrigin.layer, /restate\.yml/, 'the origin names the layer that won, not the one that was overridden')
    const idOrigin = (alpha?.origins ?? []).find((origin) => origin.field === 'id')
    assert.match(idOrigin?.layer ?? '', /heddle\.patch\.yml/, 'a field no later layer touched keeps its original layer')
  } finally {
    removeDir(fixture.home)
  }
})

test('a profile that does not exist says which ones do', async (context) => {
  if (!skipUnless(context, await supportsProfiles(), CAPABILITY)) return
  const fixture = profileFixture('unknown-profile', { patch: BASE_PATCH })
  try {
    const result = await runCli(['--profile', 'nowhere', 'config'], { env: fixture.env })
    assert.notEqual(result.code, 0, 'an unknown profile fails')
    assert.match(result.stderr + result.stdout, /nowhere/, 'the failure names what was asked for')
    assert.match(result.stderr + result.stdout, /dev/, 'and lists what exists')
  } finally {
    removeDir(fixture.home)
  }
})
