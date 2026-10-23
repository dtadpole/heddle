import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkMap, compareToBaseline, confirmRegressions, laneVerdict, parseArgs, parseListOutput, parseVerdictLine } from '../../lane.mjs'

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
  assert.deepEqual(parseArgs(['05-config-system', '10-llm-backends']), { parts: ['05-config-system', '10-llm-backends'], json: false, timeoutSeconds: 400, baseline: null, writeBaseline: null })
  assert.deepEqual(parseArgs(['--timeout', '90', '05-config-system', '--json', '60-hooks']), { parts: ['05-config-system', '60-hooks'], json: true, timeoutSeconds: 90, baseline: null, writeBaseline: null })
  assert.deepEqual(parseArgs(['05-config-system', '--timeout', '30']).parts, ['05-config-system'])
})

test('a command line the gate cannot run is refused rather than guessed at', () => {
  assert.equal(parseArgs([]), null, 'no parts')
  assert.equal(parseArgs(['--json']), null, 'no parts, only a flag')
  assert.equal(parseArgs(['05-config-system', '--timeout', 'soon']), null, 'a timeout that is not a number')
  assert.equal(parseArgs(['05-config-system', '--timeout', '0']), null, 'a timeout that is not positive')
  assert.equal(parseArgs(['05-config-system', '--allow-skip']), null, 'an unknown flag')
})

test('a --list run is read as named checks, its exit code as the verdict', () => {
  const out = 'pass   the first claim\nfail   the second claim\nskip   the third claim  [unjudged: a real endpoint]\n'
  const result = parseListOutput(out, 1)
  assert.deepEqual([result.verdict, result.tests, result.pass, result.fail, result.skipped], [1, 3, 1, 1, 1])
  assert.deepEqual(result.checks.map((check) => check.name), ['the first claim', 'the second claim', 'the third claim'])
  assert.equal(parseListOutput('', 1), null, 'a file that printed no check and did not exit unjudged is broken')
  assert.equal(parseListOutput('', 3)?.tests, 0, 'nothing collected, exit 3, is an unjudged file, not a broken one')
  assert.equal(parseListOutput('pass   x\n', null), null, 'a killed run has no verdict')
})

test('the check map names each check by its part, file and name', () => {
  const records = [{ part: '05-config-system', check: 'check.mjs', result: parseListOutput('pass   a profile composes\n', 0) }, { part: '10-llm-backends', check: 'check-backends.mjs', result: null }]
  assert.deepEqual(checkMap(records), { '05-config-system/check.mjs :: a profile composes': 'pass' })
})

test('against a baseline, only a lost pass regresses; a new failure of an unjudged check is listed, not blocking', () => {
  const baseline = { 'a :: one': 'pass', 'a :: two': 'skip', 'a :: three': 'skip', 'a :: four': 'pass' }
  const current = { 'a :: one': 'pass', 'a :: two': 'pass', 'a :: three': 'fail', 'a :: four': 'fail' }
  assert.deepEqual(compareToBaseline(baseline, current), { regressed: ['a :: four'], newlyPassing: ['a :: two'], failing: ['a :: four', 'a :: three'] })
})

test('a baseline pass that disappears from the run counts as a regression', () => {
  // A renamed or deleted check must not hide a lost pass.
  assert.deepEqual(compareToBaseline({ 'a :: renamed': 'pass' }, { 'a :: renamed later': 'pass' }).regressed, ['a :: renamed'])
})

test('--baseline and --write-baseline take a file, and a missing value is refused', () => {
  assert.deepEqual(parseArgs(['--baseline', 'base.json', '05-config-system']), { parts: ['05-config-system'], json: false, timeoutSeconds: 400, baseline: 'base.json', writeBaseline: null })
  assert.equal(parseArgs(['--write-baseline', 'out.json', '05-config-system']).writeBaseline, 'out.json')
  assert.equal(parseArgs(['05-config-system', '--baseline']), null)
  assert.equal(parseArgs(['--baseline', '--json', '05-config-system']), null)
})

test('a regression blocks only if its file fails it again on a re-run; one that passes is named flaky', () => {
  const regressed = ['70/check.mjs :: shortcuts', '70/check.mjs :: pin', '50/check-teams.mjs :: lead']
  const rerun = { '70/check.mjs :: shortcuts': 'pass', '70/check.mjs :: pin': 'fail' }
  assert.deepEqual(confirmRegressions(regressed, rerun), { confirmed: ['70/check.mjs :: pin', '50/check-teams.mjs :: lead'], flaky: ['70/check.mjs :: shortcuts'] })
  assert.deepEqual(confirmRegressions([], rerun), { confirmed: [], flaky: [] })
})
