import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { scriptedAdapter } from '../src/llm/adapters.ts'

/**
 * The scripted backend separates steps by **purpose**, which is what lets one script describe a Lead's turn and
 * a teammate's automatic turns without them replaying each other's steps. The adapter already filtered by
 * purpose; `runTurn` now forwards the purpose it was given.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-scripted-purpose-'))
after(() => rmSync(root, { recursive: true, force: true }))

function script(steps: unknown[]): string {
  const path = join(root, `script-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify({ steps }))
  return path
}

async function collect(path: string, purpose?: string): Promise<string[]> {
  const endpoint = { name: 'scripted', kind: 'scripted', baseUrl: path }
  const chunks: string[] = []
  for await (const chunk of scriptedAdapter(endpoint as never, { round: 0, ...(purpose !== undefined ? { purpose } : {}) } as never)) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
  }
  return chunks
}

test('a step is chosen by purpose, and an untagged script stays an ordinary turn', async () => {
  const path = script([
    { text: 'ordinary answer' },
    { purpose: 'team', text: 'teammate answer' },
    { purpose: 'team', text: 'second teammate step' },
  ])
  assert.deepEqual(await collect(path), ['ordinary answer'])
  assert.deepEqual(await collect(path, 'team'), ['teammate answer'])
})

test('a purpose with no steps of its own answers nothing, rather than borrowing another purpose’s step', async () => {
  const path = script([{ text: 'ordinary' }])
  assert.deepEqual(await collect(path, 'team'), [])
})
