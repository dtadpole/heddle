import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'
import { HEDDLE_VERSION } from '../src/version.ts'

/**
 * heddle reports its release as DSH does (DSH parity S72, S74): `heddle -V` / `--version` print it and exit 0, the
 * server's `/healthz` carries it, and Settings ends with "Current version: {version}". Measured before the fix on both
 * builds: `--version`, `-V` and `version` exited 1 with "unknown argument", `/healthz` answered `{ok, service, port}`,
 * and no version appeared anywhere in the page. The browser check `_verifiers_/80-web-ui/check-version.mjs` judges all
 * three on a running build.
 */

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

test('the release is the package version', () => {
  assert.equal(HEDDLE_VERSION, manifest.version)
  assert.match(HEDDLE_VERSION, /^\d+\.\d+\.\d+/)
})

test('--version and -V print the release alone and exit 0, and the help lists the flag', () => {
  for (const flag of ['--version', '-V']) {
    const run = spawnSync(process.execPath, [join(repoRoot, 'src', 'cli.ts'), flag], { encoding: 'utf8' })
    assert.equal(run.status, 0, `${flag}: ${run.stderr}`)
    assert.equal(run.stdout, `${manifest.version}\n`, flag)
  }
  const help = execFileSync(process.execPath, [join(repoRoot, 'src', 'cli.ts'), '--help'], { encoding: 'utf8' })
  assert.match(help, /^ {2}-V, --version {14}print the version and exit$/m)
})

test('/healthz carries the release', () => {
  const web = readFileSync(join(repoRoot, 'src', 'server', 'web.ts'), 'utf8')
  const route = /url\.pathname === '\/healthz'[\s\S]*?return\n/.exec(web)?.[0] ?? ''
  assert.match(route, /version: HEDDLE_VERSION/, 'the health answer names the version')
})

test('Settings ends with DSH\'s "Current version" row, omitted when the server reports none', () => {
  const source = /function settingsVersionText\([\s\S]*?\n}\n/.exec(page)?.[0]
  assert.ok(source, 'the page defines settingsVersionText')
  const settingsVersionText = new Function(`${source}\nreturn settingsVersionText`)() as (health: unknown) => string | null
  assert.equal(settingsVersionText({ ok: true, service: 'heddle-web', port: 1, version: '0.0.1' }), 'Current version: 0.0.1')
  assert.equal(settingsVersionText({ ok: true, service: 'heddle-web', port: 1 }), null)
  assert.equal(settingsVersionText(null), null)

  assert.match(page, /<p id="settings-version" class="meta" hidden><\/p>\n {2}<\/div>\n<\/dialog>/, 'the row is the last in #settings-body')
  assert.match(page, /read\('\/healthz'\)\]\)/, 'Settings reads the release from /healthz')
})
