import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contextConfigProblems } from '../src/config/context-rule.ts'
import { Config, configProblems } from '../src/context/service.ts'

/**
 * The context row's budget rule at write time (#212), the same sentences as heddle-config's context_rule.rs tests:
 * what `resolveBudget` would refuse when a turn starts is refused where it is written, in DSH's compaction-basic words.
 */

test('the shipped and default budgets pass', () => {
  assert.deepEqual(contextConfigProblems({}), [])
  assert.deepEqual(contextConfigProblems({ contextWindow: 1_048_576 }), [])
  assert.deepEqual(contextConfigProblems({ thresholdRatio: 0.7, retainRatio: 0.2 }), [])
  assert.deepEqual(contextConfigProblems({ thresholdTokens: 1000, retainTokens: 200 }), [])
})

test('each refusal is DSH-shaped and names what was written', () => {
  assert.deepEqual(contextConfigProblems({ retainRatio: 0.99, thresholdRatio: 0.5 }), ['retainRatio (0.99) must be less than the resolved thresholdRatio (0.5)'])
  assert.deepEqual(contextConfigProblems({ thresholdRatio: 0 }), ['thresholdRatio (0) must be a number in (0, 1]'])
  assert.deepEqual(contextConfigProblems({ thresholdTokens: 400, retainTokens: 500 }), ['retainTokens (500) must be less than thresholdTokens (400)'])
  assert.deepEqual(contextConfigProblems({ contextWindow: 1 }), [
    'retainRatio (0.16) of contextWindow 1 is 0 tokens, which must be less than the threshold tokens (0 = thresholdRatio 0.8 of contextWindow 1)',
  ])
  assert.deepEqual(contextConfigProblems({ retainTokens: 900_000 }), [
    'retainTokens (900000) must be less than the threshold tokens (838860 = thresholdRatio 0.8 of contextWindow 1048576)',
  ])
  assert.deepEqual(contextConfigProblems({ thresholdTokens: 1000 }), [
    'retainRatio (0.16) of contextWindow 1048576 is 167772 tokens, which must be less than thresholdTokens (1000)',
  ])
})

test('a policy is judged over the row, and only when it names a budget field', () => {
  assert.deepEqual(contextConfigProblems({ policies: [{ endpoint: 'small', retainRatio: 0.9 }] }), [
    'policies[0].retainRatio (0.9) must be less than the resolved thresholdRatio (0.8)',
  ])
  assert.deepEqual(
    contextConfigProblems({ retainRatio: 0.9, thresholdRatio: 0.95, policies: [{ endpoint: 'a' }, { endpoint: 'b', thresholdRatio: 0.5 }] }),
    ['policies[1].retainRatio (0.9) must be less than the resolved thresholdRatio (0.5)'],
  )
})

test('the bounds are DSH\'s, on the row and in each policy, and the budget is judged only over usable numbers', () => {
  assert.deepEqual(contextConfigProblems({ contextWindow: -5 }), ['contextWindow (-5) must be a positive integer'])
  assert.deepEqual(contextConfigProblems({ contextWindow: 1.5 }), ['contextWindow (1.5) must be a positive integer'])
  assert.deepEqual(contextConfigProblems({ contextWindow: 0 }), ['contextWindow (0) must be a positive integer'])
  assert.deepEqual(contextConfigProblems({ thresholdRatio: -1 }), ['thresholdRatio (-1) must be a number in (0, 1]'])
  assert.deepEqual(contextConfigProblems({ thresholdRatio: 2 }), ['thresholdRatio (2) must be a number in (0, 1]'])
  assert.deepEqual(contextConfigProblems({ retainTokens: 2.5 }), ['retainTokens (2.5) must be a non-negative integer'])
  assert.deepEqual(contextConfigProblems({ instructionsMaxBytes: -1 }), ['instructionsMaxBytes (-1) must be a non-negative integer'])
  assert.deepEqual(contextConfigProblems({ summarizeMaxTokens: 0 }), ['summarizeMaxTokens (0) must be a positive integer'])
  assert.deepEqual(contextConfigProblems({ policies: [{ endpoint: 'x', retainTokens: -1 }] }), ['policies[0].retainTokens (-1) must be a non-negative integer'])
  assert.deepEqual(contextConfigProblems({ contextWindow: 0, retainRatio: 0.99, thresholdRatio: 0.5 }), ['contextWindow (0) must be a positive integer'], 'a bound speaks before the budget')
})

test("the context row's module carries the rule, and its schema still boots what it booted", () => {
  assert.equal(configProblems, contextConfigProblems, 'validateRows finds the rule on the row module')
  // The bounds are the rule's, not the schema's: a boot applies the schema, and a patch holding such a value still boots.
  assert.equal(Config({ contextWindow: -5 } as never).contextWindow, -5)
})
