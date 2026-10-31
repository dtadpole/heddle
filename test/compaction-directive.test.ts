import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPACTION_INSTRUCTION, SUMMARY_OPEN_TAG } from '../src/context/compaction.ts'

/**
 * The summariser is asked DSH's structured checkpoint directive (#77), verbatim from dsh-compaction-basic.
 *
 * The four-sentence request it replaced let the DeepSeek reasoning model answer a pending request in the span (an
 * essay as the "summary"). The directive names the role, fixes the sections and forbids any other action.
 */
test('the compaction instruction is DSH’s directive: the role, every section in order, and the rules', () => {
  assert.ok(COMPACTION_INSTRUCTION.startsWith('You are now acting as a compaction engine for this AI coding assistant.'))
  const sections = ['## Primary Request and Intent', '## Key Technical Concepts', '## Files and Code', '## Errors and Fixes', '## Pending Jobs', '## Current Work', '## Next Step', '## Critical Context']
  const at = sections.map((section) => COMPACTION_INSTRUCTION.indexOf(section))
  assert.ok(at.every((index) => index > 0), 'every section is named')
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in DSH’s order')
  assert.ok(COMPACTION_INSTRUCTION.includes('Output only the checkpoint text: do not call any tool or take any other action.'))
  assert.ok(COMPACTION_INSTRUCTION.includes(`If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint.`))
  assert.equal(COMPACTION_INSTRUCTION.includes('Summarise the conversation above'), false, 'the old request is gone')
})
