import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A run that names no profile boots the shipped default (issue #74).
 *
 * DSH auto-initializes its shipped profiles from their templates on first use. heddle used to boot an **empty tree**
 * when a run named no profile, no `--config` and no `--patch` from a folder with no project `cordis.yml`: on a fresh home
 * the Web UI loaded with no session, model or workspace service, its first message failed with an internal error, and
 * on a binary `web --session-root` did not start at all. Now such a run boots `$HEDDLE_HOME/profiles/default`, created
 * from the shipped template the first time, and says so. Every run here uses a fresh home and an empty folder.
 */
function run(home, cwd, args) {
  const env = { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home }
  delete env.HEDDLE_CONFIG
  const [command, argv] = heddleCommand(args)
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout: 60_000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function fresh(label) {
  const home = isolatedHome(`default-profile-${label}`)
  const work = join(home, 'empty-folder')
  mkdirSync(work, { recursive: true })
  return { home, work }
}

test('a run that names no profile, from a folder with no project tree, boots the shipped default profile', () => {
  const { home, work } = fresh('config')
  try {
    const first = run(home, work, ['config', '--json'])
    assert.equal(first.code, 0, first.stderr)
    const ids = JSON.parse(first.stdout).map((row) => row.id)
    for (const id of ['session', 'model', 'context', 'workspace', 'sandbox', 'tools']) {
      assert.ok(ids.includes(id), `the shipped tree's '${id}' row is composed (rows: ${ids.join(', ') || 'none'})`)
    }
    const dir = join(home, 'profiles', 'default')
    assert.match(first.stderr, /created profile 'default' from the shipped template/, 'the run says it created the profile')
    assert.ok(existsSync(join(dir, 'cordis.yml')) && existsSync(join(dir, 'heddle.patch.yml')), 'under $HEDDLE_HOME/profiles/default')

    const second = run(home, work, ['config', '--json'])
    assert.equal(second.code, 0, second.stderr)
    assert.doesNotMatch(second.stderr, /created profile/, 'the second run boots the profile it finds, without re-creating it')
    assert.deepEqual(JSON.parse(second.stdout).map((row) => row.id), ids)
  } finally {
    removeDir(home)
  }
})

test('listing profiles creates none', () => {
  const { home, work } = fresh('profiles')
  try {
    const listed = run(home, work, ['profiles'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.equal(existsSync(join(home, 'profiles', 'default')), false, 'profiles only reads')
  } finally {
    removeDir(home)
  }
})

test('web --session-root on a fresh home starts, with the session row from the default profile', () => {
  const { home, work } = fresh('web')
  try {
    const planned = run(home, work, ['web', '--dry-run', '--session-root', join(home, 'sessions')])
    assert.equal(planned.code, 0, `${planned.stdout}\n${planned.stderr}`)
    assert.match(`${planned.stdout}${planned.stderr}`, /heddle web: would serve/, 'the server would start')
  } finally {
    removeDir(home)
  }
})
