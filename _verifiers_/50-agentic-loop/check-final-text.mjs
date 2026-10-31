// A turn's answer is its last non-empty round, DSH's rule for what a run hands back (`dsh-subagent`
// finalAssistantOutput: "the last non-empty assistant message"). Live-testing issue #9: both loops added every round's
// text, so the remark a model makes before a tool call was fused to its answer ("I'll read both files.Both reads…") in
// the API's answer, the CLI's printed answer and a delegated child's closing message. The log keeps each round's own
// message either way. A scripted endpoint says something and calls read_file in round one, then answers in round two.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

function profile(home) {
  const dir = join(home, 'final-text-profile')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: console
      name: ${repoRoot}/src/plugins/console-exporter.ts
    - id: session
      name: ${repoRoot}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${repoRoot}/src/plugins/model.ts
    - id: context
      name: ${repoRoot}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 200000
    - id: sandbox
      name: ${repoRoot}/src/sandbox/service.ts
      config:
        mode: danger-full-access
        workspaceRoot: ${home}
    - id: approvals
      name: ${repoRoot}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${repoRoot}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [read_file]
`,
  )
  return dir
}

/** Run one turn of `steps` (round one reads a file the home holds); return the turn's completed text. */
async function completedText(steps) {
  const home = isolatedHome('final-text')
  try {
    const file = join(home, 'note.txt')
    writeFileSync(file, 'hello')
    const scripted = steps.map((step) => (step.toolCall ? { ...step, toolCall: { name: 'read_file', arguments: { path: file } } } : step))
    const { config } = scriptedConfig({ home, steps: scripted })
    const run = await runCli(['--profile', profile(home), '--sandbox-root', home, '--turn', 'read the note and tell me'], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const completed = readTranscript(join(home, 'sessions', session)).filter((event) => event.type === 'assistant/completed')
    assert.equal(completed.length, 1, 'one completed turn')
    return completed[0].text
  } finally {
    removeDir(home)
  }
}

test("the answer is the last round's text, not the remark before the tool call fused to it", async () => {
  const text = await completedText([{ text: "I'll read the file.", toolCall: true }, { text: 'The file says hello.' }])
  assert.equal(text, 'The file says hello.')
})

test('a last round with no text leaves the last round that had some as the answer', async () => {
  const text = await completedText([{ text: 'Reading it now.', toolCall: true }, { text: '' }])
  assert.equal(text, 'Reading it now.')
})
