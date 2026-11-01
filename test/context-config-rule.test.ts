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

test("the context row's module carries the rule, and its schema the bounds both builds judge", () => {
  assert.equal(configProblems, contextConfigProblems, 'validateRows finds the rule on the row module')
  const refused = (value: unknown) => {
    try {
      Config(value as never)
      return null
    } catch (error) {
      return (error as Error).message
    }
  }
  assert.equal(refused({ contextWindow: -5 }), '$.contextWindow expected number >= 1 but got -5')
  assert.equal(refused({ contextWindow: 1.5 }), '$.contextWindow expected number multiple of 1 but got 1.5')
  assert.equal(refused({ contextWindow: 0 }), '$.contextWindow expected number >= 1 but got 0')
  assert.equal(refused({ thresholdRatio: -1 }), '$.thresholdRatio expected number >= 0 but got -1')
  assert.equal(refused({ thresholdRatio: 2 }), '$.thresholdRatio expected number <= 1 but got 2')
  assert.equal(refused({ policies: [{ endpoint: 'x', retainTokens: -1 }] }), '$.policies[0].retainTokens expected number >= 0 but got -1')
  assert.equal(refused({ contextWindow: 200_000, thresholdRatio: 0.7, retainRatio: 0.2 }), null)
})
