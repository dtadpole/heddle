// A profile is reset from a shipped template, as DSH's `--profile <name> --from-default-profile <template>` does: the
// custom profile is replaced by a fresh copy of the template and the command then boots it. heddle ships one template,
// `default`, the checkout's own tree with its row names made absolute. Runs against whichever harness HEDDLE_BIN
// names, or the TypeScript build.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, removeDir, repoRoot, runCli } from '../../_tools_/verify-runner/lib.mjs'

test('a custom profile is replaced by a fresh copy of the default template, and a bad request writes nothing', async () => {
  const home = isolatedHome('profile-reset')
  try {
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle') }
    const dir = join(home, '.heddle', 'profiles', 'mine')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.yml'), '- insert:\n    - id: custom\n      name: ./custom.ts\n')
    writeFileSync(join(dir, 'notes.txt'), 'hand-made')

    const reset = await runCli(['--profile', 'mine', '--from-default-profile', 'default', 'profiles', '--json'], { env })
    assert.equal(reset.code, 0, `the reset succeeds and the command runs\n${reset.stderr}`)
    assert.deepEqual(readdirSync(dir).sort(), ['cordis.yml', 'heddle.patch.yml'], 'nothing of the custom profile is kept')
    assert.equal(readFileSync(join(dir, 'cordis.yml'), 'utf8'), readFileSync(join(repoRoot, 'cordis.yml'), 'utf8'))
    const patch = readFileSync(join(dir, 'heddle.patch.yml'), 'utf8')
    assert.ok(patch.includes(`name: ${repoRoot}/src/plugins/model.ts`), 'row names are absolute, so the profile boots anywhere')
    assert.ok(!/name: \.\//.test(patch), 'no relative row name is left')
    const listed = JSON.parse(reset.stdout).find((profile) => profile.name === 'mine')
    assert.deepEqual(listed?.layers, ['cordis.yml', 'heddle.patch.yml'], `the command then reads the fresh profile\n${reset.stdout.slice(0, 300)}`)

    const valid = await runCli(['--profile', 'mine', 'config', '--validate'], { env })
    assert.equal(valid.code, 0, `the fresh profile validates\n${valid.stdout}${valid.stderr}`)

    const unknown = await runCli(['--profile', 'other', '--from-default-profile', 'web', 'profiles'], { env })
    assert.notEqual(unknown.code, 0, 'an unknown template is refused')
    assert.match(unknown.stderr, /unknown profile template 'web'; heddle ships: default/)
    assert.equal(existsSync(join(home, '.heddle', 'profiles', 'other')), false, 'and nothing is written')

    const nameless = await runCli(['--from-default-profile', 'default', 'profiles'], { env })
    assert.notEqual(nameless.code, 0, 'the template needs a profile to replace')
    assert.match(nameless.stderr, /--from-default-profile needs --profile/)
  } finally {
    removeDir(home)
  }
})
