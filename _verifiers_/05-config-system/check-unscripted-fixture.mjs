import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A home that configured nothing says how to configure a model (issue #74, the first message on a fresh home).
 *
 * The shipped endpoint list is only the offline test fixture `scripted`, which reads `scripted.json` from the working
 * folder. On a fresh home a first message therefore failed with "the script for 'scripted' could not be read at
 * scripted.json", which names a test file and not what to do. DSH's first message without a key names the credential
 * and where to store it; heddle's now names the machine file a run reads and the shape to write there. Every run here
 * uses a fresh home (also `HOME`, so nothing resolves into a real one) and the shipped default profile.
 */
function turn(home, cwd, extraEnv = {}) {
  const env = { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HOME: home, ...extraEnv }
  if (!('HEDDLE_CONFIG' in extraEnv)) delete env.HEDDLE_CONFIG
  const [command, argv] = heddleCommand(['--profile', 'default', '--from-default-profile', 'default', '--turn', 'hello'])
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout: 60_000 })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function fresh(label) {
  const home = isolatedHome(`unscripted-fixture-${label}`)
  const work = join(home, 'empty-folder')
  mkdirSync(work, { recursive: true })
  return { home, work }
}

const OPENING = "the offline test endpoint 'scripted' has no script at scripted.json. To talk to a model, pick another endpoint for this session, or declare one in "

test('a first message on a home with no endpoint names the machine file and the shape to write there', () => {
  const { home, work } = fresh('home')
  try {
    const result = turn(home, work)
    assert.equal(result.code, 1, result.out)
    assert.ok(result.out.includes(`${OPENING}${join(home, 'heddle.json')}, for example {"endpoints": [{"name": "mine", "kind": "openai-chat"`), result.out)
    assert.ok(result.out.includes('"default": "mine"}'), result.out)
    assert.doesNotMatch(result.out, /could not be read at scripted\.json/, 'the test file is no longer the message')
  } finally {
    removeDir(home)
  }
})

test('HEDDLE_CONFIG is the file named, being the one a run reads first', () => {
  const { home, work } = fresh('named')
  const named = join(home, 'elsewhere', 'machine.json')
  try {
    const result = turn(home, work, { HEDDLE_CONFIG: named })
    assert.equal(result.code, 1, result.out)
    assert.ok(result.out.includes(`${OPENING}${named},`), result.out)
  } finally {
    removeDir(home)
  }
})

test('the fixture still answers from a folder that has its script', () => {
  const { home, work } = fresh('scripted')
  writeFileSync(join(work, 'scripted.json'), JSON.stringify({ steps: [{ text: 'hello back' }] }))
  try {
    const result = turn(home, work)
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /hello back/)
  } finally {
    removeDir(home)
  }
})
