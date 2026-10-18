import assert from 'node:assert/strict'
import { test } from 'node:test'

import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'
import { fingerprint, judge, loadMachineConfig, loadValidationCache, validationTargets } from '../../_tools_/model-validation/lib.mjs'

/**
 * The machine's model endpoints — every configured model, in each of the three wire formats, judged by the
 * validation that was actually run against it.
 *
 * This check makes **no network call**. The calls happen in
 * [`_tools_/model-validation/`](../../_tools_/model-validation/INDEX.md), which records its results next to a
 * fingerprint of the configuration; this check judges that record. A configuration change — a new endpoint, a new
 * model, a new declared reasoning level, a moved address — changes the fingerprint, so the record goes stale and
 * this check turns red until the validator is run again. That is the mechanism the owner asked for: a newly
 * configured endpoint or model type cannot pass verification without having been exercised.
 *
 * On a machine with no local endpoint configuration (a fresh clone, CI) the checks report **unjudged**: there is
 * nothing to validate, and passing silently would be the same mistake as calling a green branch a deployment.
 */

const config = loadMachineConfig()
const targets = config === null ? [] : validationTargets(config)
const cache = loadValidationCache()

test("the machine's model configuration has a fresh validation record", (context) => {
  if (!skipUnless(context, config !== null && targets.length > 0, 'a machine-local endpoint configuration with a model endpoint of the three wire formats')) return
  assert.ok(
    cache !== null,
    "no model validation is recorded on this machine — run 'npm run validate:endpoints'",
  )
  assert.equal(
    cache.configFingerprint,
    fingerprint(config),
    "the model configuration changed since the last validation — run 'npm run validate:endpoints'",
  )
  assert.deepEqual(cache.interactions, ['streaming', 'reasoning', 'tool-call'], 'the record covers the three interactions')
  assert.ok(Array.isArray(cache.apiTypes) && cache.apiTypes.length > 0, 'and names the wire format families it exercised')
})

test('every configured model passes streaming, reasoning and tool-call validation', (context) => {
  if (!skipUnless(context, config !== null && targets.length > 0, 'a machine-local endpoint configuration with a model endpoint of the three wire formats')) return
  const verdict = judge(cache, config)
  assert.equal(
    verdict.ok,
    true,
    `the recorded validation does not cover this configuration — run 'npm run validate:endpoints'\n  ${verdict.failures.join('\n  ')}`,
  )
})
