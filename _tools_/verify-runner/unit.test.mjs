import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classify, collectNames, tapCounts } from './run.mjs'

/**
 * The runner's own **component tests**.
 *
 * Every verdict in this repository passes through `classify`, and the runner's header already said the
 * mapping "is worth a test of its own" — this is it. The rules under test are the ones a wrong
 * implementation would hide behind a green run: a skipped check is never a pass, a failure outranks an
 * unjudged check, and nothing collected is unjudged rather than passed.
 *
 *     node --test _tools_/verify-runner/unit.test.mjs
 */

/** One TAP tail, as node v24 writes it: no colon after the key. */
function tap({ tests, pass, fail = 0, skipped = 0, cancelled = 0, todo = 0 }) {
  return [
    `# tests ${tests}`,
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '',
  ].join('\n')
}

test('a tap counter is read without a colon, and a missing one is zero', () => {
  const text = tap({ tests: 4, pass: 3, skipped: 1 })
  assert.equal(tapCounts(text, 'tests'), 4)
  assert.equal(tapCounts(text, 'pass'), 3)
  assert.equal(tapCounts(text, 'skipped'), 1)
  assert.equal(tapCounts(text, 'fail'), 0, 'an absent counter is zero rather than an error')
  assert.equal(tapCounts('', 'tests'), 0)
})

test('a run where every check passed is the only zero', () => {
  const result = classify(tap({ tests: 3, pass: 3 }), '', 0)
  assert.equal(result.verdict, 0)
  assert.equal(result.reason, 'all 3 check(s) passed')
})

test('a skipped check is unjudged, even beside passes', () => {
  const result = classify(tap({ tests: 3, pass: 2, skipped: 1 }), '', 0)
  assert.equal(result.verdict, 3, 'a skip is never a pass')
  assert.equal(result.reason, '1 of 3 check(s) could not be judged')
})

test('a suite where every check skipped is unjudged', () => {
  const result = classify(tap({ tests: 2, pass: 0, skipped: 2 }), '', 0)
  assert.equal(result.verdict, 3)
})

test('nothing collected is unjudged, not passed', () => {
  const result = classify(tap({ tests: 0, pass: 0 }), '', 0)
  assert.equal(result.verdict, 3)
  assert.equal(result.reason, 'no checks were collected')
})

test('a failure outranks a skip, and a cancellation counts as one', () => {
  const withSkip = classify(tap({ tests: 4, pass: 2, fail: 1, skipped: 1 }), '', 1)
  assert.equal(withSkip.verdict, 1, 'a broken capability matters more than a missing one')
  assert.equal(withSkip.reason, '1 check(s) failed')
  const cancelled = classify(tap({ tests: 4, pass: 2, cancelled: 1 }), '', 1)
  assert.equal(cancelled.verdict, 1)
})

test('a todo is unjudged, because it was not judged', () => {
  const result = classify(tap({ tests: 2, pass: 1, todo: 1 }), '', 0)
  assert.equal(result.verdict, 3)
})

test('a run with no passes, failures or skips produced no verdict', () => {
  const result = classify(tap({ tests: 1, pass: 0 }), '', 0)
  assert.equal(result.verdict, 3)
  assert.equal(result.reason, 'no verdict was produced')
})

/** The `--list` reading: which checks ran, how they finished, and why a skip was unjudged. */
test('a skip line names the check and carries its reason, indented or not', () => {
  const stdout = [
    'ok 1 - the first claim',
    'ok 2 - a skipped claim # SKIP the fixture was absent',
    '    ok 3 - a nested skip # SKIP',
    'not ok 4 - the fourth claim',
    '',
  ].join('\n')
  assert.deepEqual(collectNames(stdout), [
    { name: 'the first claim', status: 'pass' },
    { name: 'a skipped claim', status: 'skip', reason: 'the fixture was absent' },
    { name: 'a nested skip', status: 'skip', reason: '' },
    { name: 'the fourth claim', status: 'fail' },
  ])
})
