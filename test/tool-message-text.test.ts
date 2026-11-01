import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toolMessageText } from '../src/agent/loop.ts'

/**
 * A failed tool result keeps what it printed (live-testing issue #82). A bash call that exited 7 used to reach the model
 * as the bare error sentence, so the model ran a second command to see its stdout and stderr; DSH's bash renderResult
 * keeps the body and adds an exit marker. The error line stays first, because the page reads it as the failure and as
 * the closed row's summary.
 */

test('a failed result with output keeps the output below its error line', () => {
  const text = toolMessageText({ output: 'stdout-marker\nstderr-marker\n', error: { code: 'EXIT', message: 'the command exited 7' } })
  assert.equal(text, 'error (EXIT): the command exited 7\nstdout-marker\nstderr-marker\n')
  assert.equal(text.split('\n')[0], 'error (EXIT): the command exited 7', 'the first line is still the error')
})

test('a failed result with no output is the error line alone, as before', () => {
  assert.equal(toolMessageText({ output: '', error: { code: 'INTERRUPTED', message: 'the command was stopped before it finished' } }), 'error (INTERRUPTED): the command was stopped before it finished')
})

test('a successful result is its output, and an empty one says so, as before', () => {
  assert.equal(toolMessageText({ output: 'ok\n' }), 'ok\n')
  assert.equal(toolMessageText({ output: '' }), '(the tool produced no output)')
})
