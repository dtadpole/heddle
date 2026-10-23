import assert from 'node:assert/strict'
import { test } from 'node:test'

import { laneVerdict, parseArgs, parseVerdictLine } from '../../lane.mjs'

/**
 * The lane gate's decision, judged without running a verifier.
 *
 * The rule a wrong implementation would hide behind a green merge: a failing check, a verdict of 1, or a check file
 * with no verdict at all (a timeout, a crash) blocks the merge; a check that could not be judged does not.
 *
 *     node --test _tools_/verify-runner/_tests_/lane-rules/unit.test.mjs
 */

const record = (part, check, result) => ({ part, check, result })
const verdict = (code, { tests = 1, pass = 0, fail = 0, skipped = 0 } = {}) => ({ verdict: code, tests, pass, fail, skipped })

test('unjudged checks leave the lane green, and the totals count them', () => {
  const decision = laneVerdict([
    record('05-config-system', 'check.mjs', verdict(0, { tests: 10, pass: 10 })),
    record('10-llm-backends', 'check-backends.mjs', verdict(3, { tests: 8, skipped: 8 })),
  ])
  assert.equal(decision.verdict, 'green')
  assert.deepEqual([decision.tests, decision.pass, decision.fail, decision.skipped, decision.files], [18, 10, 0, 8, 2])
  assert.deepEqual(decision.failing, [])
  assert.deepEqual(decision.broken, [])
})

test('one failing check turns the lane red and names its file', () => {
  const decision = laneVerdict([
    record('05-config-system', 'check.mjs', verdict(0, { tests: 10, pass: 10 })),
    record('30-context-management', 'check.mjs', verdict(1, { tests: 9, pass: 8, fail: 1 })),
  ])
  assert.equal(decision.verdict, 'red')
  assert.deepEqual(decision.failing, ['30-context-management/check.mjs'])
})

test('a file whose verdict is 1 is red even when its fail count reads 0', () => {
  // The runner gives 1 for a cancelled check too; a summary that only summed `fail` would miss it.
  const decision = laneVerdict([record('60-hooks', 'check.mjs', verdict(1, { tests: 6, pass: 5 }))])
  assert.equal(decision.verdict, 'red')
  assert.deepEqual(decision.failing, ['60-hooks/check.mjs'])
})

test('a check file with no verdict — a timeout or a crash — is broken, and broken is red', () => {
  const decision = laneVerdict([
    record('05-config-system', 'check.mjs', verdict(0, { tests: 10, pass: 10 })),
    record('10-llm-backends', 'check-backends.mjs', null),
    record('20-streaming', 'check.mjs', { reason: 'no verdict field' }),
  ])
  assert.equal(decision.verdict, 'red')
  assert.deepEqual(decision.broken, ['10-llm-backends/check-backends.mjs', '20-streaming/check.mjs'])
  assert.equal(decision.tests, 10, 'a broken file adds nothing to the totals')
})

test('an empty run is green only vacuously, and says it ran no files', () => {
  const decision = laneVerdict([])
  assert.equal(decision.verdict, 'green')
  assert.equal(decision.files, 0)
})

test('the verdict line is the last line of the runner output, and nothing else is a verdict', () => {
  assert.deepEqual(parseVerdictLine('noise\n{"verdict":3,"tests":2,"pass":0,"fail":0,"skipped":2}\n'), {
    verdict: 3,
    tests: 2,
    pass: 0,
    fail: 0,
    skipped: 2,
  })
  assert.equal(parseVerdictLine(''), null)
  assert.equal(parseVerdictLine('not json'), null)
  assert.equal(parseVerdictLine('{"tests":2}'), null, 'an object without a numeric verdict is not a verdict')
  assert.equal(parseVerdictLine(undefined), null)
})

test('every part named on the command line is judged, with or without --timeout', () => {
  // The first version dropped the first part whenever --timeout was absent.
  assert.deepEqual(parseArgs(['05-config-system', '10-llm-backends']), { parts: ['05-config-system', '10-llm-backends'], json: false, timeoutSeconds: 400 })
  assert.deepEqual(parseArgs(['--timeout', '90', '05-config-system', '--json', '60-hooks']), { parts: ['05-config-system', '60-hooks'], json: true, timeoutSeconds: 90 })
  assert.deepEqual(parseArgs(['05-config-system', '--timeout', '30']).parts, ['05-config-system'])
})

test('a command line the gate cannot run is refused rather than guessed at', () => {
  assert.equal(parseArgs([]), null, 'no parts')
  assert.equal(parseArgs(['--json']), null, 'no parts, only a flag')
  assert.equal(parseArgs(['05-config-system', '--timeout', 'soon']), null, 'a timeout that is not a number')
  assert.equal(parseArgs(['05-config-system', '--timeout', '0']), null, 'a timeout that is not positive')
  assert.equal(parseArgs(['05-config-system', '--allow-skip']), null, 'an unknown flag')
})
